import type { Config } from "./config.ts";

export class KeycloakAdminError extends Error {
  readonly status: number;
  readonly detail: string | null;
  constructor(status: number, message: string, detail: string | null = null) {
    super(message);
    this.status = status;
    this.detail = detail;
  }
}

export interface KeycloakUser {
  id: string;
  username: string;
  firstName?: string;
  lastName?: string;
  email?: string;
  enabled: boolean;
  totp?: boolean;
  requiredActions?: string[];
  createdTimestamp?: number;
}

export interface RoleRepresentation {
  id: string;
  name: string;
}

export interface KeycloakAdmin {
  request<T>(method: string, path: string, body?: unknown): Promise<{ status: number; body: T; location: string | null }>;
}

/**
 * Keycloak admin REST API as the repository-portal-admin service account,
 * which holds only view-users, query-users and manage-users. The access token
 * is cached until shortly before it expires.
 */
export function createKeycloakAdmin(config: Config, fetchImpl: typeof fetch = fetch): KeycloakAdmin | null {
  const admin = config.keycloak.admin;
  if (!admin) return null;
  const tokenUrl = `${config.keycloak.internalUrl}/realms/${config.keycloak.realm}/protocol/openid-connect/token`;
  const base = `${config.keycloak.internalUrl}/admin/realms/${config.keycloak.realm}`;
  let token: { value: string; expiresAt: number } | null = null;

  async function accessToken(): Promise<string> {
    if (token && Date.now() < token.expiresAt) return token.value;
    const response = await fetchImpl(tokenUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "client_credentials", client_id: admin!.clientId, client_secret: admin!.clientSecret }),
      signal: AbortSignal.timeout(10000),
    });
    const body = (await response.json().catch(() => ({}))) as { access_token?: string; expires_in?: number };
    if (!response.ok || !body.access_token) {
      throw new KeycloakAdminError(response.status, `Keycloak refused the ${admin!.clientId} service account (HTTP ${response.status})`);
    }
    token = { value: body.access_token, expiresAt: Date.now() + Math.max((body.expires_in ?? 60) - 30, 10) * 1000 };
    return token.value;
  }

  return {
    async request<T>(method: string, path: string, body?: unknown) {
      for (let attempt = 0; ; attempt++) {
        const response = await fetchImpl(`${base}${path}`, {
          method,
          headers: {
            Authorization: `Bearer ${await accessToken()}`,
            Accept: "application/json",
            ...(body === undefined ? {} : { "Content-Type": "application/json" }),
          },
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: AbortSignal.timeout(10000),
        });
        if (response.status === 401 && attempt === 0) {
          token = null; // revoked or expired early: get a new token once
          continue;
        }
        const text = await response.text();
        let parsed: any = null;
        try {
          parsed = text ? JSON.parse(text) : null;
        } catch {
          parsed = text;
        }
        if (!response.ok) {
          const detail = parsed?.errorMessage ?? parsed?.error_description ?? parsed?.error ?? null;
          throw new KeycloakAdminError(response.status, `Keycloak admin API ${method} ${path} answered HTTP ${response.status}`, detail);
        }
        return { status: response.status, body: parsed as T, location: response.headers.get("location") };
      }
    },
  };
}
