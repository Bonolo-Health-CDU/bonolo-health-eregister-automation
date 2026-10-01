export interface Config {
  port: number;
  publicUrl: string;
  sessionSecret: string;
  sessionHours: number;
  keycloak: {
    publicUrl: string;
    internalUrl: string;
    realm: string;
    clientId: string;
    clientSecret: string;
    /** Service-account client for managing portal users; null disables user management. */
    admin: { clientId: string; clientSecret: string } | null;
  };
  fhir: {
    baseUrl: string;
    clientId: string;
    password: string;
    timeoutMs: number;
  };
  /** Read-only OpenHIM API access for integration health; null when not configured. */
  openhim: {
    apiUrl: string;
    user: string;
    password: string;
    caFile: string | null;
    insecureTls: boolean;
    cduClientId: string;
    timeoutMs: number;
  } | null;
  dashboard: {
    unclaimedHours: number;
    timeZone: string;
    cacheSeconds: number;
  };
  webRoot: string;
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new Error(`Missing required environment variable ${name}`);
  return value;
}

const trimSlash = (url: string) => url.replace(/\/+$/, "");

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const sessionSecret = required(env, "PORTAL_SESSION_SECRET");
  if (sessionSecret.length < 32) throw new Error("PORTAL_SESSION_SECRET must be at least 32 characters");
  const keycloakPublicUrl = trimSlash(required(env, "KEYCLOAK_PUBLIC_URL"));
  return {
    port: Number(env.PORT ?? 3000),
    publicUrl: trimSlash(required(env, "PORTAL_PUBLIC_URL")),
    sessionSecret,
    sessionHours: Number(env.PORTAL_SESSION_HOURS ?? 8),
    keycloak: {
      publicUrl: keycloakPublicUrl,
      internalUrl: trimSlash(env.KEYCLOAK_INTERNAL_URL?.trim() || keycloakPublicUrl),
      realm: required(env, "KEYCLOAK_REALM"),
      clientId: required(env, "KEYCLOAK_CLIENT_ID"),
      clientSecret: required(env, "KEYCLOAK_CLIENT_SECRET"),
      admin: env.KEYCLOAK_ADMIN_CLIENT_SECRET?.trim()
        ? {
            clientId: env.KEYCLOAK_ADMIN_CLIENT_ID?.trim() || "repository-portal-admin",
            clientSecret: env.KEYCLOAK_ADMIN_CLIENT_SECRET.trim(),
          }
        : null,
    },
    fhir: {
      baseUrl: trimSlash(required(env, "FHIR_BASE_URL")),
      clientId: required(env, "OPENHIM_CLIENT_ID"),
      password: required(env, "OPENHIM_CLIENT_PASSWORD"),
      timeoutMs: Number(env.FHIR_TIMEOUT_MS ?? 15000),
    },
    openhim: env.OPENHIM_API_URL?.trim()
      ? {
          apiUrl: trimSlash(env.OPENHIM_API_URL.trim()),
          user: required(env, "OPENHIM_API_USER"),
          password: required(env, "OPENHIM_API_PASSWORD"),
          caFile: env.OPENHIM_API_CA_FILE?.trim() || null,
          insecureTls: env.OPENHIM_API_INSECURE_TLS === "true",
          cduClientId: env.OPENHIM_CDU_CLIENT_ID ?? "cdu",
          timeoutMs: Number(env.OPENHIM_API_TIMEOUT_MS ?? 15000),
        }
      : null,
    dashboard: {
      unclaimedHours: Number(env.PORTAL_UNCLAIMED_ALERT_HOURS ?? 2),
      timeZone: env.PORTAL_TIME_ZONE ?? "Africa/Maseru",
      cacheSeconds: Number(env.PORTAL_DASHBOARD_CACHE_SECONDS ?? 60),
    },
    webRoot: env.PORTAL_WEB_ROOT ?? new URL("../public", import.meta.url).pathname,
  };
}
