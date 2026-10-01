import { createHash, randomBytes } from "node:crypto";
import { createRemoteJWKSet, jwtVerify } from "jose";
import type { Config } from "./config.ts";

export interface IdTokenClaims {
  sub: string;
  preferred_username?: string;
  name?: string;
  email?: string;
  roles?: unknown;
  nonce?: string;
}

export interface Oidc {
  authorizationUrl(params: { state: string; nonce: string; codeChallenge: string }): string;
  exchangeCode(code: string, codeVerifier: string): Promise<{ idToken: string }>;
  verifyIdToken(idToken: string, nonce: string): Promise<IdTokenClaims>;
  logoutUrl(postLogoutRedirect: string): string;
}

export const randomToken = () => randomBytes(32).toString("base64url");
export const codeChallenge = (verifier: string) => createHash("sha256").update(verifier).digest("base64url");

/**
 * Authorization-code flow with PKCE against Keycloak.
 *
 * The browser is sent to the public Keycloak URL; the server exchanges the
 * code and fetches signing keys over the internal URL. Tokens are issued for
 * the public URL, which is what the issuer check expects.
 */
export function createKeycloakOidc(config: Config, fetchImpl: typeof fetch = fetch): Oidc {
  const { keycloak, publicUrl } = config;
  const issuer = `${keycloak.publicUrl}/realms/${keycloak.realm}`;
  const internalBase = `${keycloak.internalUrl}/realms/${keycloak.realm}/protocol/openid-connect`;
  const redirectUri = `${publicUrl}/auth/callback`;
  const jwks = createRemoteJWKSet(new URL(`${internalBase}/certs`));

  return {
    authorizationUrl({ state, nonce, codeChallenge }) {
      const url = new URL(`${issuer}/protocol/openid-connect/auth`);
      url.search = new URLSearchParams({
        response_type: "code",
        client_id: keycloak.clientId,
        redirect_uri: redirectUri,
        scope: "openid profile email",
        state,
        nonce,
        code_challenge: codeChallenge,
        code_challenge_method: "S256",
      }).toString();
      return url.toString();
    },

    async exchangeCode(code, codeVerifier) {
      const response = await fetchImpl(`${internalBase}/token`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code,
          redirect_uri: redirectUri,
          client_id: keycloak.clientId,
          client_secret: keycloak.clientSecret,
          code_verifier: codeVerifier,
        }),
        signal: AbortSignal.timeout(10000),
      });
      const body = (await response.json().catch(() => ({}))) as { id_token?: string; error_description?: string };
      if (!response.ok || !body.id_token) {
        throw new Error(`Keycloak token exchange failed (${response.status}): ${body.error_description ?? "no id_token"}`);
      }
      return { idToken: body.id_token };
    },

    async verifyIdToken(idToken, nonce) {
      const { payload } = await jwtVerify(idToken, jwks, { issuer, audience: keycloak.clientId });
      if (payload.nonce !== nonce) throw new Error("ID token nonce mismatch");
      return payload as unknown as IdTokenClaims;
    },

    logoutUrl(postLogoutRedirect) {
      const url = new URL(`${issuer}/protocol/openid-connect/logout`);
      url.search = new URLSearchParams({
        client_id: keycloak.clientId,
        post_logout_redirect_uri: postLogoutRedirect,
      }).toString();
      return url.toString();
    },
  };
}
