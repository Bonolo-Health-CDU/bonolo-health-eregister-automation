import { randomInt } from "node:crypto";
import { KeycloakAdminError, type KeycloakAdmin, type KeycloakUser, type RoleRepresentation } from "./keycloakAdmin.ts";
import { PORTAL_ROLES, portalRoles, type PortalRole } from "./roles.ts";

/**
 * Portal user management on top of Keycloak. Only the three portal roles are
 * ever granted or removed; other realm roles are left alone. Users are
 * disabled rather than deleted, so their history stays attributable.
 */

export class UserInputError extends Error {}

export type MfaState = "configured" | "required" | "none";

export interface PortalUserRecord {
  id: string;
  username: string;
  firstName: string | null;
  lastName: string | null;
  email: string | null;
  enabled: boolean;
  roles: PortalRole[];
  mfa: MfaState;
  passwordChangeRequired: boolean;
  createdAt: string | null;
}

export interface NewUser {
  username: string;
  firstName: string;
  lastName: string;
  email: string;
  roles: PortalRole[];
  requireMfa: boolean;
}

// No 0/O, 1/l/I: these passwords are read out or typed by hand.
const PASSWORD_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";

/** A one-time password like "Kx7p-2Mqa-Rt9e-Hb4w" (19 characters, ~94 bits). */
export function temporaryPassword(): string {
  const groups = Array.from({ length: 4 }, () =>
    Array.from({ length: 4 }, () => PASSWORD_ALPHABET[randomInt(PASSWORD_ALPHABET.length)]).join(""),
  );
  return groups.join("-");
}

const text = (value: unknown, label: string, max: number, required = true): string => {
  const trimmed = typeof value === "string" ? value.trim() : "";
  if (required && !trimmed) throw new UserInputError(`${label} is required.`);
  if (trimmed.length > max) throw new UserInputError(`${label} is too long.`);
  return trimmed;
};

export function parseRoles(value: unknown): PortalRole[] {
  if (!Array.isArray(value) || value.some((role) => typeof role !== "string")) {
    throw new UserInputError("Roles must be a list.");
  }
  const roles = portalRoles(value);
  if (roles.length !== new Set(value).size) throw new UserInputError("Unknown role.");
  return roles;
}

export function parseNewUser(body: unknown): NewUser {
  const input = (body ?? {}) as Record<string, unknown>;
  const username = text(input.username, "Username", 50).toLowerCase();
  if (!/^[a-z0-9][a-z0-9._-]{2,49}$/.test(username)) {
    throw new UserInputError("Username must be 3–50 characters: letters, digits, dot, dash or underscore.");
  }
  const email = text(input.email, "Email", 254).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new UserInputError("Email address is not valid.");
  const roles = parseRoles(input.roles);
  if (!roles.length) throw new UserInputError("Choose at least one role.");
  return {
    username,
    email,
    firstName: text(input.firstName, "First name", 100),
    lastName: text(input.lastName, "Last name", 100),
    roles,
    requireMfa: input.requireMfa !== false,
  };
}

/** Run tasks with at most `limit` in flight. */
async function mapLimit<T, R>(items: T[], limit: number, task: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const index = next++;
        results[index] = await task(items[index]);
      }
    }),
  );
  return results;
}

export function createUserDirectory(keycloak: KeycloakAdmin) {
  const userPath = (id: string) => {
    if (!/^[0-9a-f-]{36}$/.test(id)) throw new UserInputError("Invalid user id.");
    return `/users/${id}`;
  };

  async function rolesOf(id: string): Promise<RoleRepresentation[]> {
    return (await keycloak.request<RoleRepresentation[]>("GET", `${userPath(id)}/role-mappings/realm`)).body ?? [];
  }

  function toRecord(user: KeycloakUser, roles: RoleRepresentation[]): PortalUserRecord {
    const actions = user.requiredActions ?? [];
    return {
      id: user.id,
      username: user.username,
      firstName: user.firstName ?? null,
      lastName: user.lastName ?? null,
      email: user.email ?? null,
      enabled: user.enabled,
      roles: portalRoles(roles.map((role) => role.name)),
      mfa: user.totp ? "configured" : actions.includes("CONFIGURE_TOTP") ? "required" : "none",
      passwordChangeRequired: actions.includes("UPDATE_PASSWORD"),
      createdAt: user.createdTimestamp ? new Date(user.createdTimestamp).toISOString() : null,
    };
  }

  async function get(id: string): Promise<PortalUserRecord> {
    const [user, roles] = await Promise.all([
      keycloak.request<KeycloakUser>("GET", userPath(id)).then((response) => response.body),
      rolesOf(id),
    ]);
    return toRecord(user, roles);
  }

  async function list(search?: string): Promise<PortalUserRecord[]> {
    const query = new URLSearchParams({ max: "500", briefRepresentation: "false" });
    const term = search?.trim();
    if (term) query.set("search", term.slice(0, 100));
    const users = (await keycloak.request<KeycloakUser[]>("GET", `/users?${query}`)).body ?? [];
    const records = await mapLimit(users, 8, async (user) => toRecord(user, await rolesOf(user.id)));
    return records.sort((a, b) => a.username.localeCompare(b.username));
  }

  /** Enabled administrators other than `exceptId`. */
  async function otherActiveAdmins(exceptId: string): Promise<number> {
    return (await list()).filter((user) => user.id !== exceptId && user.enabled && user.roles.includes("repo-admin")).length;
  }

  async function setRoles(id: string, wanted: PortalRole[], actorId: string): Promise<PortalUserRecord> {
    const current = await get(id);
    if (current.roles.includes("repo-admin") && !wanted.includes("repo-admin")) {
      if (id === actorId) throw new UserInputError("You cannot remove your own administrator role.");
      if (current.enabled && (await otherActiveAdmins(id)) === 0) {
        throw new UserInputError("This is the last active administrator; give someone else the role first.");
      }
    }
    const add = wanted.filter((role) => !current.roles.includes(role));
    const remove = current.roles.filter((role) => !wanted.includes(role));
    if (add.length) {
      const available = (await keycloak.request<RoleRepresentation[]>("GET", `${userPath(id)}/role-mappings/realm/available`)).body;
      const grants = available.filter((role) => add.includes(role.name as PortalRole));
      await keycloak.request("POST", `${userPath(id)}/role-mappings/realm`, grants);
    }
    if (remove.length) {
      const revokes = (await rolesOf(id)).filter((role) => remove.includes(role.name as PortalRole));
      await keycloak.request("DELETE", `${userPath(id)}/role-mappings/realm`, revokes);
    }
    return get(id);
  }

  async function create(input: NewUser): Promise<{ user: PortalUserRecord; temporaryPassword: string }> {
    const password = temporaryPassword();
    let created;
    try {
      created = await keycloak.request("POST", "/users", {
        username: input.username,
        email: input.email,
        firstName: input.firstName,
        lastName: input.lastName,
        enabled: true,
        emailVerified: false,
        requiredActions: ["UPDATE_PASSWORD", ...(input.requireMfa ? ["CONFIGURE_TOTP"] : [])],
        credentials: [{ type: "password", value: password, temporary: true }],
      });
    } catch (err) {
      if (err instanceof KeycloakAdminError && err.status === 409) {
        throw new UserInputError("A user with this username or email already exists.");
      }
      throw err;
    }
    const id = created.location?.split("/").pop();
    if (!id) throw new Error("Keycloak did not return the new user's id");
    const user = await setRoles(id, input.roles, "");
    return { user, temporaryPassword: password };
  }

  async function setEnabled(id: string, enabled: boolean, actorId: string): Promise<PortalUserRecord> {
    if (!enabled) {
      if (id === actorId) throw new UserInputError("You cannot disable your own account.");
      const current = await get(id);
      if (current.roles.includes("repo-admin") && (await otherActiveAdmins(id)) === 0) {
        throw new UserInputError("This is the last active administrator and cannot be disabled.");
      }
    }
    await keycloak.request("PUT", userPath(id), { enabled });
    if (!enabled) await keycloak.request("POST", `${userPath(id)}/logout`);
    return get(id);
  }

  async function resetPassword(id: string): Promise<{ user: PortalUserRecord; temporaryPassword: string }> {
    const password = temporaryPassword();
    await keycloak.request("PUT", `${userPath(id)}/reset-password`, { type: "password", value: password, temporary: true });
    await keycloak.request("POST", `${userPath(id)}/logout`);
    return { user: await get(id), temporaryPassword: password };
  }

  /** Remove the authenticator app; the user enrols a new one at next sign-in. */
  async function resetMfa(id: string): Promise<PortalUserRecord> {
    const credentials = (await keycloak.request<{ id: string; type: string }[]>("GET", `${userPath(id)}/credentials`)).body;
    for (const credential of credentials.filter((item) => item.type === "otp")) {
      await keycloak.request("DELETE", `${userPath(id)}/credentials/${credential.id}`);
    }
    const user = (await keycloak.request<KeycloakUser>("GET", userPath(id))).body;
    const actions = new Set([...(user.requiredActions ?? []), "CONFIGURE_TOTP"]);
    await keycloak.request("PUT", userPath(id), { requiredActions: [...actions] });
    await keycloak.request("POST", `${userPath(id)}/logout`);
    return get(id);
  }

  /**
   * What a signed-in user may do right now, for session re-checks: null when
   * the account no longer exists or is disabled.
   */
  async function currentAccess(id: string): Promise<{ roles: PortalRole[] } | null> {
    try {
      const user = await get(id);
      return user.enabled ? { roles: user.roles } : null;
    } catch (err) {
      if (err instanceof KeycloakAdminError && err.status === 404) return null;
      throw err;
    }
  }

  return { list, get, create, setRoles, setEnabled, resetPassword, resetMfa, currentAccess };
}

export type UserDirectory = ReturnType<typeof createUserDirectory>;

export const ALL_PORTAL_ROLES = PORTAL_ROLES;
