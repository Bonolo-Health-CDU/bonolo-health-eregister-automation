import assert from "node:assert/strict";
import { test } from "node:test";
import { buildApp } from "../src/app.ts";
import { aggregate, localDate, statusOf } from "../src/dashboard.ts";
import { createFhirClient, rerootLink } from "../src/fhir.ts";
import { cookieHeader, fakeFhir, fakeOidc, testConfig } from "./helpers.ts";

const FS = "http://fhir.health.gov.ls/bonolo-cdu/CodeSystem/cdu-fulfilment-status";
const PICKUP = "http://fhir.health.gov.ls/bonolo-cdu/StructureDefinition/pickup-point";
const NOW = new Date("2026-10-01T12:00:00Z"); // 14:00 in Maseru

function task(id: string, status: string, business: string | null, opts: Record<string, any> = {}) {
  return {
    resourceType: "Task",
    id,
    status,
    ...(business ? { businessStatus: { coding: [{ system: FS, code: business }] } } : {}),
    requester: { reference: opts.facility ?? "Organization/A2681" },
    focus: { reference: `MedicationRequest/mr-${id}` },
    authoredOn: opts.authoredOn ?? "2026-10-01T09:00:00+02:00",
    meta: { lastUpdated: opts.lastUpdated ?? "2026-10-01T11:30:00Z" },
  };
}
function medicationRequest(id: string, status = "active", pickup = "Location/pup-501") {
  return {
    resourceType: "MedicationRequest",
    id: `mr-${id}`,
    status,
    extension: [{ url: PICKUP, valueReference: { reference: pickup } }],
  };
}

test("statusOf follows the Status Map", () => {
  assert.equal(statusOf(task("1", "requested", "returned-to-facility")), "sent-to-cdu");
  assert.equal(statusOf(task("1", "accepted", "received")), "received");
  assert.equal(statusOf(task("1", "rejected", "returned-to-facility")), "returned-to-facility");
  assert.equal(statusOf(task("1", "completed", null)), "collected");
  assert.equal(statusOf(task("1", "in-progress", "made-up-code")), "in-preparation");
});

test("aggregate counts stages, facilities, pickup points, days and alerts", () => {
  const resources = [
    task("1", "requested", null, { lastUpdated: "2026-10-01T08:00:00Z" }), // waiting 4h -> over threshold
    task("2", "requested", null), // waiting 30 min
    task("3", "accepted", "received", { facility: "Organization/D5011", authoredOn: "2026-09-29T10:00:00+02:00" }),
    task("4", "in-progress", "dispatched"),
    task("5", "cancelled", "cancelled"),
    task("6", "cancelled", "cancelled"),
    task("7", "rejected", "returned-to-facility"),
    medicationRequest("1"),
    medicationRequest("2"),
    medicationRequest("3", "active", "Location/pup-612"),
    medicationRequest("4"),
    medicationRequest("5", "cancelled"), // eRegister cancelled
    medicationRequest("6"), // CDU cancelled
    medicationRequest("7"),
  ];
  const result = aggregate({
    resources,
    organizationNames: new Map([["A2681", "Maseru Regional Hospital"], ["D5011", "Mabote Filter Clinic"]]),
    locationNames: new Map([["pup-501", "Maseru Mall Collect&Go"]]),
    now: NOW,
    days: 7,
    unclaimedHours: 2,
    timeZone: "Africa/Maseru",
    truncated: false,
  });

  assert.equal(result.total, 7);
  assert.deepEqual(result.period, { days: 7, since: "2026-09-25", until: "2026-10-01" });
  assert.deepEqual(result.stages, { waiting: 2, atCdu: 1, withFacility: 1, onTheWay: 1, completed: 0, problem: 0, cancelled: 2 });
  assert.equal(result.statuses.find((s) => s.code === "sent-to-cdu")!.count, 2);
  assert.equal(result.unclaimedOverThreshold, 1);
  assert.deepEqual(result.cancelled, { byFacility: 1, byCdu: 1 });
  assert.equal(result.daily.length, 7);
  assert.deepEqual(result.daily.at(-1), { date: "2026-10-01", count: 6 });
  assert.deepEqual(result.daily.find((d) => d.date === "2026-09-29"), { date: "2026-09-29", count: 1 });

  assert.deepEqual(result.facilities.map((f) => [f.name, f.total]), [["Maseru Regional Hospital", 6], ["Mabote Filter Clinic", 1]]);
  assert.equal(result.facilities[0].cancelled, 2);
  // Unknown names fall back to the id rather than hiding the row.
  assert.deepEqual(result.pickupPoints.map((p) => [p.name, p.total]), [["Maseru Mall Collect&Go", 6], ["pup-612", 1]]);
});

test("a prescription written just after midnight in Maseru counts on that day, even when sent in UTC", () => {
  const result = aggregate({
    resources: [task("1", "accepted", "received", { authoredOn: "2026-09-30T22:30:00Z" }), medicationRequest("1")],
    organizationNames: new Map(),
    locationNames: new Map(),
    now: NOW,
    days: 7,
    unclaimedHours: 2,
    timeZone: "Africa/Maseru",
    truncated: false,
  });
  assert.deepEqual(result.daily.at(-1), { date: "2026-10-01", count: 1 });
});

test("localDate uses the configured time zone", () => {
  assert.equal(localDate(new Date("2026-09-30T23:30:00Z"), "Africa/Maseru"), "2026-10-01");
});

test("paging links from HAPI are re-rooted on the internal base URL", () => {
  assert.equal(
    rerootLink("http://localhost:5001/fhir?_getpages=abc&_getpagesoffset=500", "http://openhim-core:5001/fhir"),
    "http://openhim-core:5001/fhir?_getpages=abc&_getpagesoffset=500",
  );
});

test("searchAll follows next links and flags truncation", async () => {
  const requested: string[] = [];
  const page = (n: number, next: boolean) => ({
    resourceType: "Bundle",
    entry: [{ resource: { resourceType: "Task", id: String(n) } }],
    link: next ? [{ relation: "next", url: `http://localhost:5001/fhir?_getpages=x&page=${n + 1}` }] : [],
  });
  const fetchImpl = (async (url: URL | string) => {
    requested.push(String(url));
    const n = requested.length;
    return new Response(JSON.stringify(page(n, n < 3)), { status: 200 });
  }) as typeof fetch;
  const fhir = createFhirClient(testConfig, fetchImpl);

  const all = await fhir.searchAll("Task", { _count: "1" }, "repo.admin", 10);
  assert.deepEqual(all.resources.map((r) => r.id), ["1", "2", "3"]);
  assert.equal(all.truncated, false);
  assert.equal(requested[1], "http://openhim.test/fhir?_getpages=x&page=2");

  requested.length = 0;
  const partial = await fhir.searchAll("Task", { _count: "1" }, "repo.admin", 2);
  assert.equal(partial.resources.length, 2);
  assert.equal(partial.truncated, true);
});

async function managerSession(instance: ReturnType<typeof buildApp>) {
  const login = await instance.inject({ url: "/auth/login" });
  const location = new URL(login.headers.location as string);
  const claims = { sub: "m", preferred_username: "programme.manager", roles: ["programme-manager"], nonce: location.searchParams.get("nonce") };
  const callback = await instance.inject({
    url: `/auth/callback?code=${encodeURIComponent(JSON.stringify(claims))}&state=${location.searchParams.get("state")}`,
    headers: { cookie: cookieHeader(login.headers["set-cookie"]) },
  });
  return cookieHeader(callback.headers["set-cookie"]).split("; ").find((c) => c.startsWith("portal_session="))!;
}

test("dashboard endpoint: managers allowed, periods validated, results cached", async () => {
  let taskSearches = 0;
  const { fhir, calls } = fakeFhir({}, {
    Task: async () => {
      taskSearches++;
      return { resources: [task("1", "accepted", "received"), medicationRequest("1")], truncated: false };
    },
    Organization: { resources: [{ resourceType: "Organization", id: "A2681", name: "Maseru Regional Hospital" }], truncated: false },
    Location: { resources: [], truncated: false },
  });
  const instance = buildApp({ config: testConfig, oidc: fakeOidc(), fhir, logger: false, now: () => NOW });
  const cookie = await managerSession(instance);

  const bad = await instance.inject({ url: "/api/dashboard?days=12", headers: { cookie } });
  assert.equal(bad.statusCode, 400);

  const first = await instance.inject({ url: "/api/dashboard?days=7", headers: { cookie } });
  assert.equal(first.statusCode, 200);
  assert.equal(first.json().facilities[0].name, "Maseru Regional Hospital");
  assert.equal(calls.find((c) => c.path === "Task")!.params["authored-on"], "ge2026-09-25");
  assert.equal(calls.find((c) => c.path === "Task")!.user, "programme.manager");

  await instance.inject({ url: "/api/dashboard?days=7", headers: { cookie } });
  assert.equal(taskSearches, 1);
});

test("dashboard endpoint reports an unavailable repository with 502", async () => {
  const { fhir } = fakeFhir({}, {
    Task: async () => {
      throw new Error("boom");
    },
    Organization: { resources: [], truncated: false },
    Location: { resources: [], truncated: false },
  });
  const instance = buildApp({ config: testConfig, oidc: fakeOidc(), fhir, logger: false, now: () => NOW });
  const cookie = await managerSession(instance);
  const response = await instance.inject({ url: "/api/dashboard?days=30", headers: { cookie } });
  assert.equal(response.statusCode, 502);
});
