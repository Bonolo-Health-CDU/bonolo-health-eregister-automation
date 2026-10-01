import type { Config } from "../src/config.ts";
import type { Fhir, FhirParams, FhirResponse, FhirSearchResult } from "../src/fhir.ts";
import type { IdTokenClaims, Oidc } from "../src/oidc.ts";

export const testConfig: Config = {
  port: 0,
  publicUrl: "http://portal.test",
  sessionSecret: "x".repeat(40),
  sessionHours: 8,
  keycloak: {
    publicUrl: "http://keycloak.test",
    internalUrl: "http://keycloak.internal",
    realm: "bonolo-repository",
    clientId: "repository-portal",
    clientSecret: "secret",
    admin: null,
  },
  fhir: { baseUrl: "http://openhim.test/fhir", clientId: "portal", password: "pw", timeoutMs: 1000 },
  openhim: null,
  dashboard: { unclaimedHours: 2, timeZone: "Africa/Maseru", cacheSeconds: 60 },
  webRoot: "/nonexistent",
};

/** Fake Keycloak: the "code" is the JSON of the claims to issue. */
export function fakeOidc(): Oidc & { lastVerifier?: string } {
  const fake: Oidc & { lastVerifier?: string } = {
    authorizationUrl: ({ state, nonce, codeChallenge }) =>
      `http://keycloak.test/auth?state=${state}&nonce=${nonce}&code_challenge=${codeChallenge}`,
    async exchangeCode(code, verifier) {
      fake.lastVerifier = verifier;
      return { idToken: code };
    },
    async verifyIdToken(idToken, nonce) {
      const claims = JSON.parse(idToken) as IdTokenClaims;
      if (claims.nonce !== undefined && claims.nonce !== nonce) throw new Error("nonce");
      return claims;
    },
    logoutUrl: (redirect) => `http://keycloak.test/logout?post_logout_redirect_uri=${encodeURIComponent(redirect)}`,
  };
  return fake;
}

type FakeResponse = FhirResponse | ((params: FhirParams) => FhirResponse);

export function fakeFhir(
  responses: Record<string, FakeResponse>,
  searches: Record<string, FhirSearchResult | (() => Promise<FhirSearchResult>)> = {},
  pages: Record<string, FhirResponse> = {},
) {
  const calls: { path: string; params: FhirParams; user: string }[] = [];
  const fhir: Fhir = {
    async get(path, params, user) {
      calls.push({ path, params, user });
      const response = responses[path];
      if (!response) throw new Error(`unexpected ${path}`);
      return typeof response === "function" ? response(params) : response;
    },
    async page(query, user) {
      calls.push({ path: "?page", params: { query }, user });
      const response = pages[query];
      if (!response) throw new Error(`unexpected page ${query}`);
      return response;
    },
    async searchAll(path, params, user) {
      calls.push({ path, params, user });
      const result = searches[path];
      if (!result) throw new Error(`unexpected search ${path}`);
      return typeof result === "function" ? result() : result;
    },
  };
  return { fhir, calls };
}

export const ok = (body: Record<string, unknown>): FhirResponse => ({ status: 200, elapsedMs: 1, body });

export function cookieHeader(setCookie: string | string[] | undefined): string {
  const values = Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : [];
  return values.map((value) => value.split(";")[0]).join("; ");
}

/** Sign in through the fake Keycloak and return the session cookie. */
export async function sessionCookie(
  app: { inject: (options: { url: string; headers?: Record<string, string> }) => Promise<any> },
  claims: Record<string, unknown>,
): Promise<string> {
  const login = await app.inject({ url: "/auth/login" });
  const location = new URL(login.headers.location as string);
  const callback = await app.inject({
    url: `/auth/callback?code=${encodeURIComponent(
      JSON.stringify({ nonce: location.searchParams.get("nonce"), ...claims }),
    )}&state=${location.searchParams.get("state")}`,
    headers: { cookie: cookieHeader(login.headers["set-cookie"]) },
  });
  return cookieHeader(callback.headers["set-cookie"])
    .split("; ")
    .find((cookie) => cookie.startsWith("portal_session="))!;
}
