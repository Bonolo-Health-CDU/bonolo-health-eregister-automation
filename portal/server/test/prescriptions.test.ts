import assert from "node:assert/strict";
import { test } from "node:test";
import { buildApp } from "../src/app.ts";
import {
  BadRequest,
  buildTimeline,
  cursorFromLink,
  pagingQueryFromCursor,
  searchParams,
  toSearchResult,
} from "../src/prescriptions.ts";
import { fakeFhir, fakeOidc, ok, sessionCookie, testConfig } from "./helpers.ts";

const FS = "http://fhir.health.gov.ls/bonolo-cdu/CodeSystem/cdu-fulfilment-status";
const BASE = "http://fhir.health.gov.ls/bonolo-cdu/StructureDefinition";
const SID = "http://fhir.health.gov.ls/sid";

const patient = {
  resourceType: "Patient",
  id: "10",
  identifier: [
    { system: `${SID}/eregister-id`, value: "E0000000001/26" },
    { system: `${SID}/hiv-program-id`, value: "HIV-1" },
  ],
  name: [{ use: "official", family: "Mokoena", given: ["Palesa"] }],
  gender: "female",
  birthDate: "1990-05-14",
  telecom: [
    { system: "phone", value: "+26650000002", rank: 2 },
    { system: "phone", value: "+26650000001", rank: 1 },
  ],
  address: [{ district: "Maseru", country: "LS" }],
};
const medicationRequest = (version: string, changes: Record<string, unknown> = {}) => ({
  resourceType: "MedicationRequest",
  id: "12",
  // v1 with the publication; later versions are amendments after the return (03:00).
  meta: { versionId: version, lastUpdated: version === "1" ? "2026-10-01T01:00:00Z" : "2026-10-01T03:30:00Z" },
  status: "active",
  identifier: [{ system: `${SID}/eregister-order-uuid`, value: "order-1" }],
  extension: [
    { url: `${BASE}/pickup-point`, valueReference: { reference: "Location/pup-501" } },
    { url: `${BASE}/requested-pickup-date`, valueDate: "2026-10-08" },
  ],
  medicationCodeableConcept: { coding: [{ code: "1j", display: "TDF-3TC-DTG" }] },
  dosageInstruction: [{ patientInstruction: "Take one tablet daily" }],
  dispenseRequest: { expectedSupplyDuration: { value: 90, unit: "days", code: "d" }, numberOfRepeatsAllowed: 0 },
  requester: { display: "Dr Lerotholi" },
  ...changes,
});
const task = (version: string, status: string, business: string | null, extra: Record<string, unknown> = {}) => ({
  resourceType: "Task",
  id: "13",
  meta: { versionId: version, lastUpdated: `2026-10-01T0${version}:00:00Z` },
  identifier: [{ system: `${SID}/cdu-fulfilment-task`, value: "order-1" }],
  status,
  ...(business ? { businessStatus: { coding: [{ system: FS, code: business }] } } : {}),
  focus: { reference: "MedicationRequest/12" },
  for: { reference: "Patient/10" },
  requester: { reference: "Organization/A2681" },
  owner: { reference: "Organization/1-LESOTHO-CDU" },
  authoredOn: "2026-10-01T09:00:00+02:00",
  ...extra,
});

test("filters become a Task search with the right FHIR parameters", () => {
  const params = searchParams({
    eregisterId: " E0000000001/26 ",
    name: "Palesa",
    facility: "A2681",
    status: "returned-to-facility",
    from: "2026-09-01",
    to: "2026-09-30",
  });
  assert.equal(params["patient.identifier"], `${SID}/eregister-id|E0000000001/26`);
  assert.equal(params["patient.name"], "Palesa");
  assert.equal(params.requester, "Organization/A2681");
  assert.equal(params["business-status"], `${FS}|returned-to-facility`);
  assert.equal(params["status:not"], "requested");
  assert.deepEqual(params["authored-on"], ["ge2026-09-01", "le2026-09-30"]);
  assert.deepEqual(params._include, ["Task:focus", "Task:patient", "Task:requester"]);
  assert.equal(searchParams({ status: "sent-to-cdu" }).status, "requested");
});

test("invalid filters are rejected", () => {
  assert.throws(() => searchParams({ status: "bogus" }), BadRequest);
  assert.throws(() => searchParams({ facility: "A2681&_include=*" }), BadRequest);
  assert.throws(() => searchParams({ from: "01/09/2026" }), BadRequest);
  assert.throws(() => searchParams({ name: "x".repeat(101) }), BadRequest);
});

test("cursors only carry HAPI paging keys", () => {
  const cursor = cursorFromLink("http://localhost:5001/fhir?_getpages=abc-123&_getpagesoffset=25&_count=25&_bundletype=searchset")!;
  assert.equal(pagingQueryFromCursor(cursor), "_getpages=abc-123&_getpagesoffset=25&_count=25&_bundletype=searchset");
  const forged = Buffer.from("_getpages=abc&_include=Patient:*").toString("base64url");
  assert.throws(() => pagingQueryFromCursor(forged), BadRequest);
  const pathy = Buffer.from("_getpages=../Patient").toString("base64url");
  assert.throws(() => pagingQueryFromCursor(pathy), BadRequest);
});

test("search results combine Task, prescription, patient and facility", () => {
  const result = toSearchResult(
    {
      total: 1,
      link: [{ relation: "self", url: "http://localhost:5001/fhir/Task?x=1" }],
      entry: [
        { resource: task("2", "accepted", "received"), search: { mode: "match" } },
        { resource: medicationRequest("1"), search: { mode: "include" } },
        { resource: patient, search: { mode: "include" } },
        { resource: { resourceType: "Organization", id: "A2681", name: "Maseru Regional Hospital" }, search: { mode: "include" } },
      ],
    },
    new Map([["pup-501", "Maseru Mall Collect&Go"]]),
  );
  assert.equal(result.total, 1);
  assert.equal(result.next, null);
  assert.deepEqual(result.items[0], {
    taskId: "13",
    orderId: "order-1",
    authoredOn: "2026-10-01T09:00:00+02:00",
    lastUpdated: "2026-10-01T02:00:00Z",
    status: { code: "received", label: "Received", stage: "atCdu" },
    patient: { name: "Palesa Mokoena", eregisterId: "E0000000001/26" },
    facility: { id: "A2681", name: "Maseru Regional Hospital" },
    pickupPoint: { id: "pup-501", name: "Maseru Mall Collect&Go" },
    regimen: { code: "1j", display: "TDF-3TC-DTG" },
  });
});

test("timeline tells the story of a returned and resubmitted prescription", () => {
  const events = buildTimeline(
    [
      task("1", "requested", null),
      task("2", "accepted", "received"),
      task("3", "rejected", "returned-to-facility", {
        statusReason: { coding: [{ code: "missing-demographics" }], text: "Missing patient Demographic Information" },
      }),
      task("4", "requested", "returned-to-facility"),
      task("5", "accepted", "received"),
      task("6", "accepted", "received", { lastModified: "2026-10-01T06:30:00Z" }), // no visible change
      task("7", "in-progress", "in-preparation"),
    ],
    [medicationRequest("1"), medicationRequest("2", { dosageInstruction: [{ patientInstruction: "Take at night" }] })],
  );
  assert.deepEqual(
    events.map((event) => [event.actor, event.title, event.detail]),
    [
      ["eRegister", "Published by the facility", null],
      ["CDU", "Received by the CDU", null],
      ["CDU", "Returned to facility", "Missing patient Demographic Information"],
      ["eRegister", "Prescription amended by the facility", "Changed: dosage"],
      ["eRegister", "Re-sent to the CDU by the facility", null],
      ["CDU", "Received by the CDU", null],
      ["CDU", "In preparation", null],
    ],
  );
});

test("timeline attributes a cancellation to the facility when the prescription was cancelled too", () => {
  const events = buildTimeline(
    [task("1", "requested", null), task("2", "cancelled", "cancelled")],
    [medicationRequest("1"), medicationRequest("2", { status: "cancelled" })],
  );
  assert.deepEqual(events.map((event) => event.title), [
    "Published by the facility",
    "Cancelled by the facility",
    "Prescription cancelled in eRegister",
  ]);
  const cduCancelled = buildTimeline([task("1", "requested", null), task("2", "cancelled", "cancelled")], [medicationRequest("1")]);
  assert.deepEqual(cduCancelled.map((event) => [event.actor, event.title]).at(-1), ["CDU", "Cancelled"]);
});

function portal() {
  const { fhir, calls } = fakeFhir(
    {
      Task: (params) =>
        params._id === "13"
          ? ok({
              entry: [
                { resource: task("2", "accepted", "received") },
                { resource: medicationRequest("1") },
                { resource: patient },
                { resource: { resourceType: "Organization", id: "A2681", name: "Maseru Regional Hospital" } },
                { resource: { resourceType: "Organization", id: "1-LESOTHO-CDU", name: "Lesotho CDU" } },
              ],
            })
          : ok({ entry: [] }),
      "Task/13/_history": ok({ entry: [{ resource: task("2", "accepted", "received") }, { resource: task("1", "requested", null) }] }),
      "MedicationRequest/12/_history": ok({ entry: [{ resource: medicationRequest("1") }] }),
      AllergyIntolerance: ok({
        entry: [{ resource: { resourceType: "AllergyIntolerance", code: { coding: [{ code: "716186003" }] } } }],
      }),
      MedicationDispense: ok({ entry: [] }),
    },
    {
      Organization: { resources: [{ resourceType: "Organization", id: "A2681", name: "Maseru Regional Hospital" }], truncated: false },
      Location: { resources: [{ resourceType: "Location", id: "pup-501", name: "Maseru Mall Collect&Go" }], truncated: false },
    },
    { "_getpages=abc&_getpagesoffset=25": { status: 410, elapsedMs: 1, body: {} } },
  );
  return { app: buildApp({ config: testConfig, oidc: fakeOidc(), fhir, logger: false }), calls };
}

test("prescription routes are closed to programme managers", async () => {
  const { app } = portal();
  const cookie = await sessionCookie(app, { sub: "m", preferred_username: "programme.manager", roles: ["programme-manager"] });
  for (const url of ["/api/prescriptions", "/api/prescriptions/13", "/api/reference"]) {
    assert.equal((await app.inject({ url, headers: { cookie } })).statusCode, 403, url);
  }
});

test("support staff can open a prescription's full detail", async () => {
  const { app, calls } = portal();
  const cookie = await sessionCookie(app, { sub: "s", preferred_username: "support.clerk", roles: ["support"] });
  const response = await app.inject({ url: "/api/prescriptions/13", headers: { cookie } });
  assert.equal(response.statusCode, 200);
  const detail = response.json();
  assert.equal(detail.patient.name, "Palesa Mokoena");
  assert.deepEqual(detail.patient.phones, ["+26650000001", "+26650000002"]);
  assert.equal(detail.noKnownAllergies, true);
  assert.equal(detail.fulfilment.owner, "Lesotho CDU");
  assert.equal(detail.prescription.supplyDays, 90);
  assert.equal(detail.summary.pickupPoint.name, "Maseru Mall Collect&Go");
  assert.deepEqual(detail.timeline.map((event: { title: string }) => event.title), ["Published by the facility", "Received by the CDU"]);
  assert.ok(calls.filter((call) => call.path !== "Organization" && call.path !== "Location").every((call) => call.user === "support.clerk"));
});

test("bad ids, unknown prescriptions and expired pages get clear answers", async () => {
  const { app } = portal();
  const cookie = await sessionCookie(app, { sub: "a", preferred_username: "repo.admin", roles: ["repo-admin"] });
  assert.equal((await app.inject({ url: "/api/prescriptions/..%2Fmetadata", headers: { cookie } })).statusCode, 400);
  assert.equal((await app.inject({ url: "/api/prescriptions/99", headers: { cookie } })).statusCode, 404);
  const expired = await app.inject({
    url: `/api/prescriptions?cursor=${Buffer.from("_getpages=abc&_getpagesoffset=25").toString("base64url")}`,
    headers: { cookie },
  });
  assert.equal(expired.statusCode, 400);
  assert.match(expired.json().message, /expired/);
});
