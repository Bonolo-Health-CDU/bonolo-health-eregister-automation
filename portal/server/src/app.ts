import { existsSync } from "node:fs";
import { join } from "node:path";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import cookie from "@fastify/cookie";
import fastifyStatic from "@fastify/static";
import type { Config } from "./config.ts";
import { DASHBOARD_PERIODS, loadDashboard, STATUSES, type Dashboard } from "./dashboard.ts";
import type { Fhir } from "./fhir.ts";
import { loadIntegrationHealth, transactionsForPrescription, WINDOWS, type HealthWindow, type IntegrationHealth } from "./integrations.ts";
import { createOpenHim, type OpenHim } from "./openhim.ts";
import {
  BadRequest,
  loadPrescription,
  prescriptionIds,
  searchPrescriptions,
  type SearchQuery,
} from "./prescriptions.ts";
import { createReferenceData } from "./reference.ts";
import { createKeycloakAdmin, KeycloakAdminError } from "./keycloakAdmin.ts";
import { createUserDirectory, parseNewUser, parseRoles, UserInputError, type UserDirectory } from "./users.ts";
import { codeChallenge, randomToken, type Oidc } from "./oidc.ts";
import { canUse, portalRoles, type Feature, type PortalRole } from "./roles.ts";
import { createSealer } from "./seal.ts";

export interface SessionUser {
  sub: string;
  username: string;
  name: string;
  email: string | null;
  roles: PortalRole[];
}

interface PendingLogin {
  state: string;
  nonce: string;
  verifier: string;
  returnTo: string;
}

declare module "fastify" {
  interface FastifyRequest {
    portalUser: SessionUser | null;
  }
}

const SESSION_COOKIE = "portal_session";
const LOGIN_COOKIE = "portal_login";
const LOGIN_TTL_SECONDS = 600;

/** Only same-site paths: never let returnTo send the browser elsewhere. */
export function safeReturnTo(value: unknown): string {
  return typeof value === "string" && /^\/(?![/\\])/.test(value) ? value : "/";
}

export interface AppDeps {
  config: Config;
  oidc: Oidc;
  fhir: Fhir;
  /** Read-only OpenHIM API; defaults to one built from config.openhim, if set. */
  openhim?: OpenHim | null;
  /** Portal users in Keycloak; defaults to one built from config.keycloak.admin, if set. */
  users?: UserDirectory | null;
  logger?: boolean;
  now?: () => Date;
}

export function buildApp({
  config,
  oidc,
  fhir,
  openhim = config.openhim ? createOpenHim(config.openhim) : null,
  users = (() => {
    const admin = createKeycloakAdmin(config);
    return admin ? createUserDirectory(admin) : null;
  })(),
  logger = true,
  now = () => new Date(),
}: AppDeps): FastifyInstance {
  const app = Fastify({ logger, trustProxy: true });
  const sealer = createSealer(config.sessionSecret);
  const reference = createReferenceData(fhir);
  const cookieOptions = {
    httpOnly: true,
    sameSite: "lax" as const,
    secure: config.publicUrl.startsWith("https://"),
    path: "/",
  };

  app.register(cookie);
  app.decorateRequest("portalUser", null);

  // Sessions are re-checked against Keycloak (at most once a minute per user),
  // so disabling a user or changing their roles takes effect without waiting
  // for the 8-hour cookie to expire. If Keycloak cannot be asked, the roles in
  // the session stand.
  const accessCache = new Map<string, { at: number; value: Promise<{ roles: PortalRole[] } | null> }>();
  const currentAccess = (sub: string) => {
    const cached = accessCache.get(sub);
    if (cached && Date.now() - cached.at < 60_000) return cached.value;
    const value = users!.currentAccess(sub);
    accessCache.set(sub, { at: Date.now(), value });
    value.catch(() => accessCache.delete(sub));
    return value;
  };

  app.addHook("onRequest", async (request, reply) => {
    const session = sealer.unseal<SessionUser>(request.cookies[SESSION_COOKIE]);
    request.portalUser = session;
    const path = request.url.split("?")[0];
    if (!path.startsWith("/api/")) return;

    // CSRF: browsers cannot add custom headers to cross-site form posts.
    if (!["GET", "HEAD"].includes(request.method) && request.headers["x-portal-request"] !== "1") {
      return reply.code(403).send({ error: "missing_csrf_header" });
    }

    if (session && users) {
      try {
        const access = await currentAccess(session.sub);
        if (!access) {
          request.log.info({ user: session.username }, "session ended: account disabled or removed");
          request.portalUser = null;
          reply.clearCookie(SESSION_COOKIE, cookieOptions);
        } else {
          request.portalUser = { ...session, roles: access.roles };
        }
      } catch (err) {
        request.log.warn({ err }, "could not re-check the session with Keycloak; using session roles");
      }
    }
  });

  app.addHook("onSend", async (_request, reply) => {
    reply.header("X-Content-Type-Options", "nosniff");
    reply.header("Referrer-Policy", "same-origin");
    reply.header("X-Frame-Options", "DENY");
    reply.header(
      "Content-Security-Policy",
      "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'self'",
    );
  });

  const requireFeature = (feature: Feature) => async (request: FastifyRequest, reply: FastifyReply) => {
    if (!request.portalUser) return reply.code(401).send({ error: "not_signed_in" });
    if (!canUse(request.portalUser.roles, feature)) return reply.code(403).send({ error: "forbidden" });
  };

  // ---------------------------------------------------------------- auth
  app.get<{ Querystring: { returnTo?: string } }>("/auth/login", async (request, reply) => {
    const pending: PendingLogin = {
      state: randomToken(),
      nonce: randomToken(),
      verifier: randomToken(),
      returnTo: safeReturnTo(request.query.returnTo),
    };
    reply.setCookie(LOGIN_COOKIE, sealer.seal(pending, LOGIN_TTL_SECONDS), {
      ...cookieOptions,
      maxAge: LOGIN_TTL_SECONDS,
    });
    return reply.redirect(
      oidc.authorizationUrl({
        state: pending.state,
        nonce: pending.nonce,
        codeChallenge: codeChallenge(pending.verifier),
      }),
    );
  });

  app.get<{ Querystring: { code?: string; state?: string; error?: string } }>(
    "/auth/callback",
    async (request, reply) => {
      const pending = sealer.unseal<PendingLogin>(request.cookies[LOGIN_COOKIE]);
      reply.clearCookie(LOGIN_COOKIE, cookieOptions);
      const { code, state, error } = request.query;
      if (error) return reply.redirect(`/?loginError=${encodeURIComponent(error)}`);
      if (!pending || !code || state !== pending.state) {
        return reply.redirect("/?loginError=invalid_login_state");
      }
      try {
        const { idToken } = await oidc.exchangeCode(code, pending.verifier);
        const claims = await oidc.verifyIdToken(idToken, pending.nonce);
        const user: SessionUser = {
          sub: claims.sub,
          username: claims.preferred_username ?? claims.sub,
          name: claims.name ?? claims.preferred_username ?? claims.sub,
          email: claims.email ?? null,
          roles: portalRoles(claims.roles),
        };
        const ttl = config.sessionHours * 3600;
        reply.setCookie(SESSION_COOKIE, sealer.seal(user, ttl), { ...cookieOptions, maxAge: ttl });
        request.log.info({ user: user.username, roles: user.roles }, "portal sign-in");
        return reply.redirect(pending.returnTo);
      } catch (err) {
        request.log.warn({ err }, "portal sign-in failed");
        return reply.redirect("/?loginError=sign_in_failed");
      }
    },
  );

  app.post("/auth/logout", async (request, reply) => {
    reply.clearCookie(SESSION_COOKIE, cookieOptions);
    return { logoutUrl: oidc.logoutUrl(`${config.publicUrl}/`) };
  });

  // ----------------------------------------------------------------- api
  app.get("/healthz", async () => ({ ok: true }));

  app.get("/api/me", async (request, reply) => {
    if (!request.portalUser) return reply.code(401).send({ error: "not_signed_in" });
    return request.portalUser;
  });

  app.get("/api/system/status", { preHandler: requireFeature("dashboard") }, async (request) => {
    const user = request.portalUser!.username;
    try {
      const [metadata, tasks] = await Promise.all([
        fhir.get("metadata", { _summary: "true" }, user),
        fhir.get("Task", { _summary: "count" }, user),
      ]);
      if (metadata.status !== 200) {
        return { fhir: { reachable: false, error: describeFailure(metadata.status) } };
      }
      const software = (metadata.body.software ?? {}) as { name?: string; version?: string };
      return {
        fhir: {
          reachable: true,
          via: "OpenHIM",
          software: software.name ?? null,
          softwareVersion: software.version ?? null,
          fhirVersion: metadata.body.fhirVersion ?? null,
          latencyMs: metadata.elapsedMs,
        },
        totals: { tasks: tasks.status === 200 ? (tasks.body.total ?? null) : null },
      };
    } catch (err) {
      request.log.warn({ err }, "FHIR repository unreachable");
      return { fhir: { reachable: false, error: "The FHIR repository could not be reached through OpenHIM." } };
    }
  });

  // Aggregates are the same for every viewer, so one cached copy per period
  // spares the repository. "fresh" bypasses the cache (the Refresh button).
  const dashboardCache = new Map<number, { at: number; data: Promise<Dashboard> }>();
  app.get<{ Querystring: { days?: string; fresh?: string } }>(
    "/api/dashboard",
    { preHandler: requireFeature("dashboard") },
    async (request, reply) => {
      const days = Number(request.query.days ?? 30);
      if (!(DASHBOARD_PERIODS as readonly number[]).includes(days)) {
        return reply.code(400).send({ error: "invalid_period", allowed: DASHBOARD_PERIODS });
      }
      const cached = dashboardCache.get(days);
      const age = cached ? Date.now() - cached.at : Infinity;
      const maxAge = request.query.fresh ? 5_000 : config.dashboard.cacheSeconds * 1000;
      if (!cached || age > maxAge) {
        const data = loadDashboard(fhir, reference, request.portalUser!.username, {
          days,
          now: now(),
          unclaimedHours: config.dashboard.unclaimedHours,
          timeZone: config.dashboard.timeZone,
        });
        dashboardCache.set(days, { at: Date.now(), data });
        data.catch(() => dashboardCache.delete(days));
      }
      try {
        return await dashboardCache.get(days)!.data;
      } catch (err) {
        request.log.warn({ err }, "dashboard query failed");
        return reply.code(502).send({ error: "repository_unavailable" });
      }
    },
  );

  // --------------------------------------------- prescriptions (patient data)
  const repositoryCall = async <T>(request: FastifyRequest, reply: FastifyReply, work: () => Promise<T>) => {
    try {
      return await work();
    } catch (err) {
      if (err instanceof BadRequest) return reply.code(400).send({ error: "bad_request", message: err.message });
      request.log.warn({ err }, "repository call failed");
      return reply.code(502).send({ error: "repository_unavailable" });
    }
  };

  app.get("/api/reference", { preHandler: requireFeature("prescriptions") }, (request, reply) =>
    repositoryCall(request, reply, async () => {
      const names = await reference.names(request.portalUser!.username);
      const list = (map: Map<string, string>) =>
        [...map].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name));
      return {
        facilities: list(names.organizations),
        pickupPoints: list(names.locations),
        statuses: STATUSES,
      };
    }),
  );

  app.get<{ Querystring: SearchQuery }>(
    "/api/prescriptions",
    { preHandler: requireFeature("prescriptions") },
    (request, reply) =>
      repositoryCall(request, reply, () =>
        searchPrescriptions(fhir, reference, request.portalUser!.username, request.query),
      ),
  );

  app.get<{ Params: { taskId: string } }>(
    "/api/prescriptions/:taskId",
    { preHandler: requireFeature("prescriptions") },
    (request, reply) =>
      repositoryCall(request, reply, async () => {
        const detail = await loadPrescription(fhir, reference, request.portalUser!.username, request.params.taskId);
        return detail ?? reply.code(404).send({ error: "not_found" });
      }),
  );

  // -------------------------------------------------- integration health
  const notConfigured = (reply: FastifyReply) =>
    reply.code(503).send({ error: "openhim_not_configured", message: "The portal has no OpenHIM API access configured." });

  const healthCache = new Map<HealthWindow, { at: number; data: Promise<IntegrationHealth> }>();
  app.get<{ Querystring: { window?: string; fresh?: string } }>(
    "/api/integrations",
    { preHandler: requireFeature("integrations") },
    async (request, reply) => {
      if (!openhim) return notConfigured(reply);
      const window = (request.query.window ?? "24h") as HealthWindow;
      if (!(window in WINDOWS)) return reply.code(400).send({ error: "invalid_window", allowed: Object.keys(WINDOWS) });
      const cached = healthCache.get(window);
      const maxAge = request.query.fresh ? 5_000 : 30_000;
      if (!cached || Date.now() - cached.at > maxAge) {
        const data = loadIntegrationHealth(openhim, fhir, request.portalUser!.username, {
          window,
          now: now(),
          cduClientId: config.openhim!.cduClientId,
        });
        healthCache.set(window, { at: Date.now(), data });
        data.catch(() => healthCache.delete(window));
      }
      return repositoryCall(request, reply, () => healthCache.get(window)!.data);
    },
  );

  app.get<{ Params: { taskId: string } }>(
    "/api/prescriptions/:taskId/transactions",
    { preHandler: requireFeature("prescriptions") },
    (request, reply) =>
      repositoryCall(request, reply, async () => {
        if (!openhim) return notConfigured(reply);
        const ids = await prescriptionIds(fhir, request.portalUser!.username, request.params.taskId);
        if (!ids) return reply.code(404).send({ error: "not_found" });
        return { items: await transactionsForPrescription(openhim, ids) };
      }),
  );

  // ------------------------------------------------------ user management
  const userCall = async <T>(request: FastifyRequest, reply: FastifyReply, action: string, work: (directory: UserDirectory) => Promise<T>) => {
    if (!users) {
      return reply.code(503).send({ error: "user_management_not_configured", message: "The portal has no Keycloak admin access configured." });
    }
    try {
      const result = await work(users);
      if (action !== "list") {
        request.log.info({ actor: request.portalUser!.username, action, target: (request.params as { id?: string }).id }, "user management");
      }
      return result;
    } catch (err) {
      if (err instanceof UserInputError) return reply.code(400).send({ error: "bad_request", message: err.message });
      if (err instanceof KeycloakAdminError && err.status === 404) return reply.code(404).send({ error: "not_found" });
      if (err instanceof KeycloakAdminError && err.status === 400) {
        return reply.code(400).send({ error: "bad_request", message: err.detail ?? "Keycloak rejected the request." });
      }
      request.log.warn({ err }, "Keycloak admin call failed");
      return reply.code(502).send({ error: "keycloak_unavailable", message: "Keycloak could not complete the request." });
    }
  };
  // A change made here applies to that user's next request, not a minute later.
  const forget = (id: string) => accessCache.delete(id);
  const usersOnly = { preHandler: requireFeature("users") };

  app.get<{ Querystring: { search?: string } }>("/api/users", usersOnly, (request, reply) =>
    userCall(request, reply, "list", (directory) => directory.list(request.query.search)),
  );
  app.post("/api/users", usersOnly, (request, reply) =>
    userCall(request, reply, "create", (directory) => directory.create(parseNewUser(request.body))),
  );
  app.put<{ Params: { id: string }; Body: { roles?: unknown } }>("/api/users/:id/roles", usersOnly, (request, reply) =>
    userCall(request, reply, "set-roles", async (directory) => {
      const result = await directory.setRoles(request.params.id, parseRoles(request.body?.roles), request.portalUser!.sub);
      forget(request.params.id);
      return result;
    }),
  );
  app.put<{ Params: { id: string }; Body: { enabled?: unknown } }>("/api/users/:id/enabled", usersOnly, (request, reply) =>
    userCall(request, reply, request.body?.enabled === true ? "enable" : "disable", async (directory) => {
      if (typeof request.body?.enabled !== "boolean") throw new UserInputError("enabled must be true or false.");
      const result = await directory.setEnabled(request.params.id, request.body.enabled, request.portalUser!.sub);
      forget(request.params.id);
      return result;
    }),
  );
  app.post<{ Params: { id: string } }>("/api/users/:id/reset-password", usersOnly, (request, reply) =>
    userCall(request, reply, "reset-password", (directory) => directory.resetPassword(request.params.id)),
  );
  app.post<{ Params: { id: string } }>("/api/users/:id/reset-mfa", usersOnly, (request, reply) =>
    userCall(request, reply, "reset-mfa", (directory) => directory.resetMfa(request.params.id)),
  );

  // ------------------------------------------------------- web frontend
  const hasWeb = existsSync(join(config.webRoot, "index.html"));
  if (hasWeb) {
    app.register(fastifyStatic, { root: config.webRoot, wildcard: false });
  }
  app.setNotFoundHandler((request, reply) => {
    const path = request.url.split("?")[0];
    if (!hasWeb || request.method !== "GET" || /^\/(api|auth)(\/|$)/.test(path)) {
      return reply.code(404).send({ error: "not_found" });
    }
    return reply.sendFile("index.html");
  });

  return app;
}

function describeFailure(status: number): string {
  if (status === 401 || status === 403) return `OpenHIM refused the portal client (HTTP ${status}). Check its credentials and channel access.`;
  return `The FHIR repository answered HTTP ${status}.`;
}
