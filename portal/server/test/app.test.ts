import assert from "node:assert/strict";
import { test } from "node:test";
import { buildApp, safeReturnTo } from "../src/app.ts";
import type { FhirResponse } from "../src/fhir.ts";
import { cookieHeader, fakeFhir, fakeOidc, testConfig } from "./helpers.ts";

const metadata = {
  status: 200,
  elapsedMs: 12,
  body: { fhirVersion: "4.0.1", software: { name: "HAPI FHIR Server", version: "8.12.0" } },
};
const taskCount = { status: 200, elapsedMs: 5, body: { total: 3 } };

function app(fhirResponses: Record<string, FhirResponse> = { metadata, Task: taskCount }) {
  const { fhir, calls } = fakeFhir(fhirResponses);
  const oidc = fakeOidc();
  return { app: buildApp({ config: testConfig, oidc, fhir, logger: false }), calls, oidc };
}

/** Run the login round-trip and return the session cookie. */
async function signIn(instance: ReturnType<typeof app>["app"], claims: object, returnTo = "/") {
  const login = await instance.inject({ url: `/auth/login?returnTo=${encodeURIComponent(returnTo)}` });
  assert.equal(login.statusCode, 302);
  const location = new URL(login.headers.location as string);
  const callback = await instance.inject({
    url: `/auth/callback?code=${encodeURIComponent(
      JSON.stringify({ nonce: location.searchParams.get("nonce"), ...claims }),
    )}&state=${location.searchParams.get("state")}`,
    headers: { cookie: cookieHeader(login.headers["set-cookie"]) },
  });
  return { callback, cookie: cookieHeader(callback.headers["set-cookie"]).split("; ").find((c) => c.startsWith("portal_session=")) };
}

test("API requires a session", async () => {
  const { app: instance } = app();
  assert.equal((await instance.inject({ url: "/api/me" })).statusCode, 401);
  assert.equal((await instance.inject({ url: "/api/system/status" })).statusCode, 401);
});

test("login redirects to Keycloak with PKCE and sets a sealed login cookie", async () => {
  const { app: instance } = app();
  const response = await instance.inject({ url: "/auth/login" });
  const location = new URL(response.headers.location as string);
  assert.equal(location.origin, "http://keycloak.test");
  assert.ok(location.searchParams.get("code_challenge"));
  assert.match(String(response.headers["set-cookie"]), /portal_login=.+HttpOnly/);
});

test("callback creates a session with portal roles only, then returns to the page", async () => {
  const { app: instance, oidc } = app();
  const { callback, cookie } = await signIn(
    instance,
    { sub: "u1", preferred_username: "support.clerk", name: "Support Clerk", roles: ["support", "offline_access"] },
    "/prescriptions",
  );
  assert.equal(callback.statusCode, 302);
  assert.equal(callback.headers.location, "/prescriptions");
  assert.ok(oidc.lastVerifier);
  const me = await instance.inject({ url: "/api/me", headers: { cookie: cookie! } });
  assert.deepEqual(me.json().roles, ["support"]);
  assert.equal(me.json().username, "support.clerk");
});

test("callback rejects a state that does not match the login", async () => {
  const { app: instance } = app();
  const login = await instance.inject({ url: "/auth/login" });
  const callback = await instance.inject({
    url: `/auth/callback?code=${encodeURIComponent(JSON.stringify({ sub: "u1" }))}&state=forged`,
    headers: { cookie: cookieHeader(login.headers["set-cookie"]) },
  });
  assert.equal(callback.headers.location, "/?loginError=invalid_login_state");
  assert.doesNotMatch(String(callback.headers["set-cookie"]), /portal_session=[^;]/);
});

test("returnTo never leaves the portal", () => {
  assert.equal(safeReturnTo("/users?x=1"), "/users?x=1");
  for (const bad of ["//evil.example", "/\\evil.example", "https://evil.example", "users", undefined]) {
    assert.equal(safeReturnTo(bad), "/");
  }
});

test("status needs a portal role and reads through OpenHIM as the signed-in user", async () => {
  const { app: instance, calls } = app();
  const noRole = await signIn(instance, { sub: "u2", preferred_username: "nobody", roles: [] });
  assert.equal((await instance.inject({ url: "/api/system/status", headers: { cookie: noRole.cookie! } })).statusCode, 403);

  const manager = await signIn(instance, { sub: "u3", preferred_username: "programme.manager", roles: ["programme-manager"] });
  const status = await instance.inject({ url: "/api/system/status", headers: { cookie: manager.cookie! } });
  assert.equal(status.statusCode, 200);
  assert.deepEqual(status.json().totals, { tasks: 3 });
  assert.equal(status.json().fhir.fhirVersion, "4.0.1");
  assert.ok(calls.every((call) => call.user === "programme.manager"));
});

test("status reports an OpenHIM refusal instead of failing", async () => {
  const { app: instance } = app({ metadata: { status: 401, elapsedMs: 3, body: {} }, Task: taskCount });
  const admin = await signIn(instance, { sub: "u4", preferred_username: "repo.admin", roles: ["repo-admin"] });
  const status = await instance.inject({ url: "/api/system/status", headers: { cookie: admin.cookie! } });
  assert.equal(status.json().fhir.reachable, false);
  assert.match(status.json().fhir.error, /OpenHIM refused/);
});

test("logout clears the session and returns the Keycloak logout URL", async () => {
  const { app: instance } = app();
  const response = await instance.inject({ method: "POST", url: "/auth/logout" });
  assert.match(response.json().logoutUrl, /post_logout_redirect_uri=http%3A%2F%2Fportal.test%2F/);
  assert.match(String(response.headers["set-cookie"]), /portal_session=;/);
});
