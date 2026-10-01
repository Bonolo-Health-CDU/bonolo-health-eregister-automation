import assert from "node:assert/strict";
import { test } from "node:test";
import { buildApp } from "../src/app.ts";
import { KeycloakAdminError, type KeycloakAdmin } from "../src/keycloakAdmin.ts";
import { createUserDirectory, parseNewUser, temporaryPassword, UserInputError } from "../src/users.ts";
import { fakeFhir, fakeOidc, sessionCookie, testConfig } from "./helpers.ts";

const ROLES = ["repo-admin", "programme-manager", "support", "offline_access", "default-roles-bonolo-repository"].map(
  (name, index) => ({ id: `role-${index}`, name }),
);
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

/** In-memory stand-in for the Keycloak admin endpoints the portal uses. */
function fakeKeycloak() {
  let next = 10;
  const users = new Map<string, any>();
  const roles = new Map<string, Set<string>>();
  const credentials = new Map<string, { id: string; type: string }[]>();
  const loggedOut: string[] = [];
  const add = (id: string, username: string, userRoles: string[], extra: Record<string, unknown> = {}) => {
    users.set(id, { id, username, enabled: true, requiredActions: [], totp: false, ...extra });
    roles.set(id, new Set([...userRoles, "default-roles-bonolo-repository"]));
    credentials.set(id, [{ id: `pw-${id}`, type: "password" }]);
  };
  add(uuid(1), "repo.admin", ["repo-admin"]);
  add(uuid(2), "support.clerk", ["support"], { totp: true });
  credentials.get(uuid(2))!.push({ id: "otp-2", type: "otp" });

  const admin: KeycloakAdmin = {
    async request<T>(method: string, path: string, body?: any) {
      const reply = (value: unknown, status = 200, location: string | null = null) => ({ status, body: value as T, location });
      const match = path.match(/^\/users\/([^/?]+)(\/.*)?$/);
      if (method === "GET" && path.startsWith("/users?")) {
        const search = new URLSearchParams(path.split("?")[1]).get("search");
        return reply([...users.values()].filter((user) => !search || user.username.includes(search)));
      }
      if (method === "POST" && path === "/users") {
        if ([...users.values()].some((user) => user.username === body.username || user.email === body.email)) {
          throw new KeycloakAdminError(409, "conflict");
        }
        const id = uuid(next++);
        add(id, body.username, [], { ...body, credentials: undefined });
        return reply(null, 201, `http://kc/admin/realms/r/users/${id}`);
      }
      if (!match || !users.has(match[1])) throw new KeycloakAdminError(404, "not found");
      const [, id, rest = ""] = match;
      const user = users.get(id);
      if (rest === "" && method === "GET") return reply(user);
      if (rest === "" && method === "PUT") return reply(Object.assign(user, body), 204);
      if (rest === "/role-mappings/realm" && method === "GET") return reply(ROLES.filter((role) => roles.get(id)!.has(role.name)));
      if (rest === "/role-mappings/realm/available") return reply(ROLES.filter((role) => !roles.get(id)!.has(role.name)));
      if (rest === "/role-mappings/realm" && method === "POST") return reply(body.forEach((role: any) => roles.get(id)!.add(role.name)), 204);
      if (rest === "/role-mappings/realm" && method === "DELETE") return reply(body.forEach((role: any) => roles.get(id)!.delete(role.name)), 204);
      if (rest === "/logout") return reply(loggedOut.push(id), 204);
      if (rest === "/reset-password") return reply(Object.assign(user, { lastPassword: body }), 204);
      if (rest === "/credentials") return reply(credentials.get(id));
      if (rest.startsWith("/credentials/") && method === "DELETE") {
        credentials.set(id, credentials.get(id)!.filter((item) => item.id !== rest.split("/").pop()));
        user.totp = credentials.get(id)!.some((item) => item.type === "otp");
        return reply(null, 204);
      }
      throw new Error(`fake keycloak: unexpected ${method} ${path}`);
    },
  };
  return { admin, users, roles, credentials, loggedOut };
}

test("new-user input is validated and normalised", () => {
  const user = parseNewUser({ username: " Thabo.M ", firstName: "Thabo", lastName: "Mokoena", email: "THABO@example.org", roles: ["support"] });
  assert.equal(user.username, "thabo.m");
  assert.equal(user.email, "thabo@example.org");
  assert.equal(user.requireMfa, true);
  for (const bad of [
    { username: "x", firstName: "a", lastName: "b", email: "a@b.co", roles: ["support"] },
    { username: "thabo", firstName: "a", lastName: "b", email: "not-an-email", roles: ["support"] },
    { username: "thabo", firstName: "a", lastName: "b", email: "a@b.co", roles: [] },
    { username: "thabo", firstName: "a", lastName: "b", email: "a@b.co", roles: ["realm-admin"] },
    { username: "thabo", firstName: "", lastName: "b", email: "a@b.co", roles: ["support"] },
  ]) {
    assert.throws(() => parseNewUser(bad), UserInputError, JSON.stringify(bad));
  }
});

test("temporary passwords are long, unambiguous and different each time", () => {
  const passwords = new Set(Array.from({ length: 50 }, temporaryPassword));
  assert.equal(passwords.size, 50);
  for (const password of passwords) assert.match(password, /^[A-HJ-NP-Za-km-z2-9]{4}(-[A-HJ-NP-Za-km-z2-9]{4}){3}$/);
});

test("creating a user sets a one-time password, required actions and portal roles", async () => {
  const keycloak = fakeKeycloak();
  const directory = createUserDirectory(keycloak.admin);
  const { user, temporaryPassword: password } = await directory.create(
    parseNewUser({ username: "thabo", firstName: "Thabo", lastName: "M", email: "thabo@example.org", roles: ["support", "programme-manager"] }),
  );
  assert.deepEqual(user.roles, ["programme-manager", "support"]);
  assert.equal(user.mfa, "required");
  assert.equal(user.passwordChangeRequired, true);
  assert.equal(keycloak.users.get(user.id).credentials, undefined); // never kept by the fake: sent once
  assert.ok(password.length >= 12);
  await assert.rejects(
    directory.create(parseNewUser({ username: "thabo", firstName: "T", lastName: "M", email: "x@example.org", roles: ["support"] })),
    /already exists/,
  );
});

test("administrators cannot lock themselves or the realm out", async () => {
  const keycloak = fakeKeycloak();
  const directory = createUserDirectory(keycloak.admin);
  const me = uuid(1);
  await assert.rejects(directory.setRoles(me, ["support"], me), /your own administrator role/);
  await assert.rejects(directory.setEnabled(me, false, me), /your own account/);

  // A second admin may demote the only other admin only while one remains.
  await directory.setRoles(uuid(2), ["repo-admin"], me);
  const demoted = await directory.setRoles(me, ["programme-manager"], uuid(2));
  assert.deepEqual(demoted.roles, ["programme-manager"]);
  assert.ok(keycloak.roles.get(me)!.has("default-roles-bonolo-repository")); // non-portal roles untouched
  await assert.rejects(directory.setEnabled(uuid(2), false, me), /last active administrator/);
});

test("disabling ends the user's Keycloak sessions; resetting MFA removes only the authenticator", async () => {
  const keycloak = fakeKeycloak();
  const directory = createUserDirectory(keycloak.admin);
  const disabled = await directory.setEnabled(uuid(2), false, uuid(1));
  assert.equal(disabled.enabled, false);
  assert.deepEqual(keycloak.loggedOut, [uuid(2)]);

  const reset = await directory.resetMfa(uuid(2));
  assert.equal(reset.mfa, "required");
  assert.deepEqual(keycloak.credentials.get(uuid(2))!.map((item) => item.type), ["password"]);

  const { temporaryPassword: password } = await directory.resetPassword(uuid(2));
  assert.deepEqual(keycloak.users.get(uuid(2)).lastPassword, { type: "password", value: password, temporary: true });
  await assert.rejects(directory.get("../../realms"), UserInputError);
});

function portal() {
  const keycloak = fakeKeycloak();
  const app = buildApp({
    config: testConfig,
    oidc: fakeOidc(),
    fhir: fakeFhir({}).fhir,
    openhim: null,
    users: createUserDirectory(keycloak.admin),
    logger: false,
  });
  return { app, keycloak };
}
const asAdmin = (app: ReturnType<typeof portal>["app"]) =>
  sessionCookie(app, { sub: uuid(1), preferred_username: "repo.admin", roles: ["repo-admin"] });
const write = { "content-type": "application/json", "x-portal-request": "1" };

test("user routes: administrators only, and changes need the CSRF header", async () => {
  const { app } = portal();
  const support = await sessionCookie(app, { sub: uuid(2), preferred_username: "support.clerk", roles: ["support"] });
  assert.equal((await app.inject({ url: "/api/users", headers: { cookie: support } })).statusCode, 403);

  const admin = await asAdmin(app);
  const list = await app.inject({ url: "/api/users", headers: { cookie: admin } });
  assert.deepEqual(list.json().map((user: { username: string }) => user.username), ["repo.admin", "support.clerk"]);

  const body = JSON.stringify({ username: "thabo", firstName: "Thabo", lastName: "M", email: "thabo@example.org", roles: ["support"] });
  const forged = await app.inject({ method: "POST", url: "/api/users", headers: { cookie: admin, "content-type": "application/json" }, payload: body });
  assert.equal(forged.statusCode, 403);
  const created = await app.inject({ method: "POST", url: "/api/users", headers: { cookie: admin, ...write }, payload: body });
  assert.equal(created.statusCode, 200);
  assert.ok(created.json().temporaryPassword);

  const invalid = await app.inject({ method: "POST", url: "/api/users", headers: { cookie: admin, ...write }, payload: "{}" });
  assert.equal(invalid.statusCode, 400);
  assert.match(invalid.json().message, /required/);
});

test("disabling a user or changing their roles applies to their very next request", async () => {
  const { app } = portal();
  const admin = await asAdmin(app);
  const support = await sessionCookie(app, { sub: uuid(2), preferred_username: "support.clerk", roles: ["support"] });
  assert.equal((await app.inject({ url: "/api/me", headers: { cookie: support } })).statusCode, 200);

  await app.inject({ method: "PUT", url: `/api/users/${uuid(2)}/roles`, headers: { cookie: admin, ...write }, payload: { roles: ["programme-manager"] } });
  assert.deepEqual((await app.inject({ url: "/api/me", headers: { cookie: support } })).json().roles, ["programme-manager"]);

  const off = await app.inject({ method: "PUT", url: `/api/users/${uuid(2)}/enabled`, headers: { cookie: admin, ...write }, payload: { enabled: false } });
  assert.equal(off.json().enabled, false);
  const after = await app.inject({ url: "/api/me", headers: { cookie: support } });
  assert.equal(after.statusCode, 401);
  assert.match(String(after.headers["set-cookie"]), /portal_session=;/);
});
