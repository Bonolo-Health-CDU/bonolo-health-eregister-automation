import assert from "node:assert/strict";
import { test } from "node:test";
import { buildApp } from "../src/app.ts";
import {
  categorize,
  loadIntegrationHealth,
  outcomeDiagnostics,
  toProblem,
  transactionsForPrescription,
} from "../src/integrations.ts";
import type { OpenHim, OpenHimClient, OpenHimTransaction } from "../src/openhim.ts";
import { fakeFhir, fakeOidc, ok, sessionCookie, testConfig } from "./helpers.ts";

const NOW = new Date("2026-10-01T12:00:00Z");
const CLIENTS: OpenHimClient[] = [
  { _id: "c-ereg", clientID: "eregister", name: "eRegister", roles: ["eregister"] },
  { _id: "c-cdu", clientID: "cdu", name: "CDU (Odoo)", roles: ["cdu"] },
];
const CHANNELS = [
  { _id: "ch-read", name: "INT-02 Repository read", status: "enabled", methods: ["GET"], allow: ["cdu"], urlPattern: "^/fhir(/.*)?$", priority: 10 },
  { _id: "ch-task", name: "INT-03 Task updates", status: "enabled", methods: ["PUT", "PATCH"], allow: ["cdu"], urlPattern: "^/fhir/Task(/.*)?$", priority: 2 },
];
const OUTCOME = JSON.stringify({
  resourceType: "OperationOutcome",
  issue: [
    { severity: "error", diagnostics: "HAPI-0575: Patient does not declare conformance to profile" },
    { severity: "warning", diagnostics: "ignored" },
  ],
});

function transaction(id: string, overrides: Partial<OpenHimTransaction> = {}): OpenHimTransaction {
  return {
    _id: id,
    status: "Successful",
    clientID: "c-cdu",
    channelID: "ch-task",
    request: { method: "PUT", path: "/fhir/Task/13", timestamp: "2026-10-01T11:00:00.000Z" },
    response: { status: 200, timestamp: "2026-10-01T11:00:00.150Z" },
    ...overrides,
  };
}

function fakeOpenHim(handlers: {
  count?: (filters: Record<string, any>) => number;
  transactions?: (filters: Record<string, any>, limit: number, representation: string) => OpenHimTransaction[];
  down?: boolean;
} = {}) {
  const counts: Record<string, any>[] = [];
  const queries: { filters: Record<string, any>; representation: string }[] = [];
  const openhim: OpenHim = {
    async get<T>(path: string): Promise<T> {
      if (handlers.down) throw new Error("connect ECONNREFUSED");
      const answers: Record<string, unknown> = {
        about: { currentCoreVersion: "8.5.0" },
        heartbeat: { master: 3600.4 },
        channels: CHANNELS,
      };
      return answers[path] as T;
    },
    async transactions(filters, limit, representation) {
      queries.push({ filters, representation });
      return handlers.transactions?.(filters, limit, representation) ?? [];
    },
    async count(filters) {
      counts.push(filters);
      return handlers.count?.(filters) ?? 0;
    },
    async clients() {
      if (handlers.down) throw new Error("connect ECONNREFUSED");
      return new Map(CLIENTS.map((client) => [client._id, client]));
    },
  };
  return { openhim, counts, queries };
}

const fhirForHealth = () =>
  fakeFhir({
    metadata: { status: 200, elapsedMs: 42, body: { fhirVersion: "4.0.1", software: { name: "HAPI FHIR Server", version: "8.12.0" } } },
    StructureDefinition: ok({
      entry: [
        { resource: { url: "http://fhir.health.gov.ls/bonolo-cdu/StructureDefinition/bonolo-patient", name: "BonoloPatient", title: "Bonolo Patient", version: "0.2.0", status: "draft" } },
        { resource: { url: "http://fhir.health.gov.ls/bonolo-cdu/StructureDefinition/pickup-point", name: "PickupPoint", version: "0.2.0", status: "draft" } },
      ],
    }),
  }).fhir;

test("problems are categorised by HTTP status and OperationOutcome", () => {
  assert.equal(categorize(422, "Completed", true), "contract-rejection");
  assert.equal(categorize(400, "Completed", false), "client-error");
  assert.equal(categorize(401, "Completed", false), "refused");
  assert.equal(categorize(404, "Completed", true), "not-found");
  assert.equal(categorize(409, "Completed", true), "version-conflict");
  assert.equal(categorize(502, "Completed", false), "server-error");
  assert.equal(categorize(null, "Failed", false), "server-error");
  assert.equal(outcomeDiagnostics(OUTCOME), "HAPI-0575: Patient does not declare conformance to profile");
  assert.equal(outcomeDiagnostics("<html>"), null);
  assert.equal(outcomeDiagnostics(JSON.stringify({ resourceType: "Patient" })), null);
});

test("a problem never carries request or response bodies", () => {
  const problem = toProblem(
    transaction("t1", { response: { status: 422, timestamp: "2026-10-01T11:00:00.090Z", body: OUTCOME } }),
    new Map(CLIENTS.map((client) => [client._id, client])),
    new Map([["ch-task", "INT-03 Task updates"]]),
  );
  assert.equal(problem.category, "contract-rejection");
  assert.equal(problem.client, "cdu");
  assert.equal(problem.channel, "INT-03 Task updates");
  assert.equal(problem.durationMs, 90);
  assert.ok(!("body" in problem) && !JSON.stringify(problem).includes("resourceType"));
});

test("integration health counts traffic per client and status publications by the CDU", async () => {
  const { openhim, counts, queries } = fakeOpenHim({
    count: (filters) => {
      if (filters["request.path"] === "^/fhir/Task/") return filters.$or ? 1 : 12;
      if (filters["response.status"]?.$in) return 3;
      if (filters.clientID === "c-cdu") return filters["response.status"] ? 2 : filters.$or ? 1 : 40;
      return filters["response.status"] || filters.$or ? 0 : 5;
    },
    transactions: (filters, limit, representation) =>
      representation === "full"
        ? [transaction("p1", { clientID: "c-ereg", channelID: "ch-read", request: { method: "POST", path: "/fhir/Patient", timestamp: "2026-10-01T11:30:00Z" }, response: { status: 422, body: OUTCOME } })]
        : [transaction(`last-${filters.clientID}`)],
  });

  const health = await loadIntegrationHealth(openhim, fhirForHealth(), "repo.admin", { window: "24h", now: NOW, cduClientId: "cdu" });

  assert.deepEqual(health.openhim, { reachable: true, version: "8.5.0", uptimeSeconds: 3600 });
  assert.equal(health.fhir.reachable && health.fhir.software, "HAPI FHIR Server");
  assert.equal(health.contract.version, "0.2.0");
  assert.deepEqual(health.contract.profiles.map((profile) => profile.name), ["Bonolo Patient", "PickupPoint"]);
  assert.deepEqual(health.clients.map((client) => [client.clientId, client.requests, client.clientErrors, client.serverErrors]), [
    ["cdu", 40, 2, 1],
    ["eregister", 5, 0, 0],
  ]);
  assert.deepEqual(health.statusPublications, { total: 12, failed: 1 });
  assert.equal(health.contractRejections, 3);
  assert.equal(health.problems[0].category, "contract-rejection");
  assert.equal(health.channels[0].name, "INT-03 Task updates"); // by priority

  const window = JSON.parse(counts[0]["request.timestamp"]);
  assert.equal(window.$gte, "2026-09-30T12:00:00.000Z");
  const publication = counts.find((filters) => filters["request.path"] === "^/fhir/Task/")!;
  assert.equal(publication.clientID, "c-cdu");
  assert.deepEqual(publication["request.method"], { $in: ["PUT", "PATCH"] });
  assert.ok(queries.some((query) => query.representation === "full"));
});

test("integration health still reports the FHIR server when OpenHIM is down", async () => {
  const { openhim } = fakeOpenHim({ down: true });
  const health = await loadIntegrationHealth(openhim, fhirForHealth(), "repo.admin", { window: "7d", now: NOW, cduClientId: "cdu" });
  assert.equal(health.openhim.reachable, false);
  assert.equal(health.fhir.reachable, true);
  assert.deepEqual(health.clients, []);
});

test("a prescription's transactions: its writes plus the bundle that created it", async () => {
  const { openhim, queries } = fakeOpenHim({
    transactions: (filters) => {
      if (filters["request.path"] === "^/fhir/Task/13(/|$)") {
        return [transaction("claim", { request: { method: "PUT", path: "/fhir/Task/13", timestamp: "2026-10-01T11:05:00Z" } })];
      }
      if (filters["request.path"] === "^/fhir/?$") {
        return [
          transaction("other", { clientID: "c-ereg", request: { method: "POST", path: "/fhir", timestamp: "2026-10-01T11:00:01Z" }, response: { status: 200, body: '{"location":"Task/99/_history/1"}' } }),
          transaction("bundle", { clientID: "c-ereg", request: { method: "POST", path: "/fhir", timestamp: "2026-10-01T11:00:00Z" }, response: { status: 200, body: '{"location":"Task/13/_history/1"}' } }),
        ];
      }
      return [];
    },
  });
  const rows = await transactionsForPrescription(openhim, { taskId: "13", medicationRequestId: "12", publishedAt: "2026-10-01T11:00:00.500Z" });
  assert.deepEqual(rows.map((row) => [row.id, row.client, row.method]), [
    ["bundle", "eregister", "POST"],
    ["claim", "cdu", "PUT"],
  ]);
  assert.ok(queries.some((query) => query.filters["request.path"] === "^/fhir/MedicationRequest/12(/|$)"));
  const escaped = await transactionsForPrescription(openhim, { taskId: "a.b", medicationRequestId: null, publishedAt: null });
  assert.deepEqual(escaped, []);
  assert.ok(queries.some((query) => query.filters["request.path"] === "^/fhir/Task/a\\.b(/|$)"));
});

test("integration routes: roles, configuration and validation", async () => {
  const { openhim } = fakeOpenHim();
  const withOpenHim = buildApp({
    config: { ...testConfig, openhim: { apiUrl: "https://openhim.test:8080", user: "u", password: "p", caFile: null, insecureTls: false, cduClientId: "cdu", timeoutMs: 1000 } },
    oidc: fakeOidc(),
    fhir: fhirForHealth(),
    openhim,
    logger: false,
    now: () => NOW,
  });
  const manager = await sessionCookie(withOpenHim, { sub: "m", preferred_username: "programme.manager", roles: ["programme-manager"] });
  const support = await sessionCookie(withOpenHim, { sub: "s", preferred_username: "support.clerk", roles: ["support"] });
  assert.equal((await withOpenHim.inject({ url: "/api/integrations", headers: { cookie: manager } })).statusCode, 403);
  assert.equal((await withOpenHim.inject({ url: "/api/integrations?window=1y", headers: { cookie: support } })).statusCode, 400);
  const ok200 = await withOpenHim.inject({ url: "/api/integrations?window=7d", headers: { cookie: support } });
  assert.equal(ok200.statusCode, 200);
  assert.equal(ok200.json().window, "7d");

  const withoutOpenHim = buildApp({ config: testConfig, oidc: fakeOidc(), fhir: fhirForHealth(), openhim: null, logger: false });
  const admin = await sessionCookie(withoutOpenHim, { sub: "a", preferred_username: "repo.admin", roles: ["repo-admin"] });
  const missing = await withoutOpenHim.inject({ url: "/api/integrations", headers: { cookie: admin } });
  assert.equal(missing.statusCode, 503);
});
