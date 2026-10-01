import { STATUSES, statusOf, type Stage } from "./dashboard.ts";
import type { Fhir, FhirParams, FhirResponse } from "./fhir.ts";
import type { ReferenceData } from "./reference.ts";

/**
 * Prescription search and detail for support staff and administrators.
 * Unlike the dashboard this returns patient-level data, so the routes are
 * limited to roles with the "prescriptions" feature.
 */

const SID = "http://fhir.health.gov.ls/sid";
const BASE = "http://fhir.health.gov.ls/bonolo-cdu";
const SYSTEMS = {
  eregisterId: `${SID}/eregister-id`,
  nationalId: `${SID}/national-id`,
  hivProgramId: `${SID}/hiv-program-id`,
  orderId: `${SID}/eregister-order-uuid`,
  taskId: `${SID}/cdu-fulfilment-task`,
  fulfilmentStatus: `${BASE}/CodeSystem/cdu-fulfilment-status`,
  rejectionReason: `${BASE}/CodeSystem/cdu-rejection-reason`,
};
const EXT = {
  pickupPoint: `${BASE}/StructureDefinition/pickup-point`,
  requestedPickupDate: `${BASE}/StructureDefinition/requested-pickup-date`,
  originatingFacility: `${BASE}/StructureDefinition/originating-facility`,
  nextClinicalVisitDate: `${BASE}/StructureDefinition/next-clinical-visit-date`,
};
const NO_KNOWN_ALLERGY_CODES = new Set(["716186003", "409137002"]);
const REJECTION_REASONS: Record<string, string> = {
  "missing-demographics": "Missing patient demographic information",
  "missing-medicine": "Missing medicine information",
  "missing-clinical": "Missing patient clinical information",
  "missing-collection": "Missing medicine collection information",
  duplicate: "Duplicate prescription",
  "out-of-stock": "Out of stock",
};

type Resource = Record<string, any>;

export const PAGE_SIZE = 25;
const FHIR_ID = /^[A-Za-z0-9\-.]{1,64}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

export class BadRequest extends Error {}

// --------------------------------------------------------------- helpers
const identifier = (resource: Resource | undefined, system: string): string | null =>
  (resource?.identifier ?? []).find((item: Resource) => item.system === system && item.value)?.value ?? null;

const extension = (resource: Resource | undefined, url: string): Resource | undefined =>
  (resource?.extension ?? []).find((item: Resource) => item.url === url);

const refId = (reference: string | undefined): string | null => reference?.split("/").pop() ?? null;

export function patientName(patient: Resource | undefined): string | null {
  const names: Resource[] = patient?.name ?? [];
  const name = names.find((item) => item.use === "official") ?? names[0];
  if (!name) return null;
  return name.text ?? ([...(name.given ?? []), name.family].filter(Boolean).join(" ") || null);
}

function statusInfo(task: Resource) {
  const code = statusOf(task);
  const status = STATUSES.find((item) => item.code === code)!;
  return { code, label: status.label, stage: status.stage as Stage };
}

function regimen(medicationRequest: Resource | undefined) {
  const concept = medicationRequest?.medicationCodeableConcept ?? {};
  const coding = (concept.coding ?? [])[0] ?? {};
  return {
    code: coding.code ?? null,
    display: coding.display ?? concept.text ?? null,
  };
}

// ---------------------------------------------------------------- search
export interface SearchQuery {
  eregisterId?: string;
  orderId?: string;
  name?: string;
  facility?: string;
  status?: string;
  from?: string;
  to?: string;
  cursor?: string;
}

const clean = (value: unknown, max = 100): string | undefined => {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  if (trimmed.length > max) throw new BadRequest("Search value is too long.");
  return trimmed;
};

/** Turn the portal's filters into a Task search with everything a result row needs included. */
export function searchParams(query: SearchQuery): FhirParams {
  const params: FhirParams = {
    _include: ["Task:focus", "Task:patient", "Task:requester"],
    _sort: "-authored-on",
    _count: String(PAGE_SIZE),
    _total: "accurate",
  };
  const eregisterId = clean(query.eregisterId);
  if (eregisterId) params["patient.identifier"] = `${SYSTEMS.eregisterId}|${eregisterId}`;
  const orderId = clean(query.orderId);
  if (orderId) params.identifier = `${SYSTEMS.taskId}|${orderId}`;
  const name = clean(query.name);
  if (name) params["patient.name"] = name;

  const facility = clean(query.facility);
  if (facility) {
    if (!FHIR_ID.test(facility)) throw new BadRequest("Unknown facility.");
    params.requester = `Organization/${facility}`;
  }

  const status = clean(query.status);
  if (status) {
    if (!STATUSES.some((item) => item.code === status)) throw new BadRequest("Unknown status.");
    if (status === "sent-to-cdu") params.status = "requested";
    else {
      params["business-status"] = `${SYSTEMS.fulfilmentStatus}|${status}`;
      params["status:not"] = "requested";
    }
  }

  const dates: string[] = [];
  for (const [bound, value] of [["ge", query.from], ["le", query.to]] as const) {
    const date = clean(value, 10);
    if (!date) continue;
    if (!DATE.test(date)) throw new BadRequest("Dates must be YYYY-MM-DD.");
    dates.push(`${bound}${date}`);
  }
  if (dates.length) params["authored-on"] = dates;
  return params;
}

/**
 * Paging cursors wrap the query part of HAPI's next/previous links. Only the
 * keys HAPI itself puts there are accepted, so a cursor can never be turned
 * into an arbitrary request.
 */
const PAGING_KEYS = new Set(["_getpages", "_getpagesoffset", "_count", "_pretty", "_bundletype"]);

export function cursorFromLink(link: string | undefined): string | null {
  if (!link) return null;
  return Buffer.from(new URL(link).search.slice(1)).toString("base64url");
}

export function pagingQueryFromCursor(cursor: string): string {
  const query = Buffer.from(cursor, "base64url").toString("utf8");
  const params = new URLSearchParams(query);
  const keys = [...params.keys()];
  if (
    !keys.length ||
    keys.some((key) => !PAGING_KEYS.has(key)) ||
    !/^[A-Za-z0-9-]{1,64}$/.test(params.get("_getpages") ?? "") ||
    !/^\d{1,7}$/.test(params.get("_getpagesoffset") ?? "0")
  ) {
    throw new BadRequest("Invalid page.");
  }
  return params.toString();
}

export interface PrescriptionSummary {
  taskId: string;
  orderId: string | null;
  authoredOn: string | null;
  lastUpdated: string | null;
  status: { code: string; label: string; stage: Stage };
  patient: { name: string | null; eregisterId: string | null };
  facility: { id: string | null; name: string | null };
  pickupPoint: { id: string | null; name: string | null };
  regimen: { code: string | null; display: string | null };
}

export function summarize(task: Resource, index: Map<string, Resource>, locations: Map<string, string>): PrescriptionSummary {
  const medicationRequest = index.get(task.focus?.reference);
  const patient = index.get(task.for?.reference);
  const organization = index.get(task.requester?.reference);
  const pickupId = refId(extension(medicationRequest, EXT.pickupPoint)?.valueReference?.reference);
  return {
    taskId: task.id,
    orderId: identifier(task, SYSTEMS.taskId) ?? identifier(medicationRequest, SYSTEMS.orderId),
    authoredOn: task.authoredOn ?? null,
    lastUpdated: task.meta?.lastUpdated ?? null,
    status: statusInfo(task),
    patient: { name: patientName(patient), eregisterId: identifier(patient, SYSTEMS.eregisterId) },
    facility: { id: refId(task.requester?.reference), name: organization?.name ?? refId(task.requester?.reference) },
    pickupPoint: { id: pickupId, name: pickupId ? (locations.get(pickupId) ?? pickupId) : null },
    regimen: regimen(medicationRequest),
  };
}

export interface SearchResult {
  total: number | null;
  offset: number;
  items: PrescriptionSummary[];
  next: string | null;
  previous: string | null;
}

export function toSearchResult(bundle: Resource, locations: Map<string, string>): SearchResult {
  const resources: Resource[] = (bundle.entry ?? []).map((entry: Resource) => entry.resource).filter(Boolean);
  const index = new Map(resources.map((resource) => [`${resource.resourceType}/${resource.id}`, resource]));
  const link = (relation: string) => (bundle.link ?? []).find((item: Resource) => item.relation === relation)?.url;
  const self = link("self");
  const offset = self ? Number(new URL(self).searchParams.get("_getpagesoffset") ?? 0) : 0;
  return {
    total: typeof bundle.total === "number" ? bundle.total : null,
    offset,
    items: (bundle.entry ?? [])
      .filter((entry: Resource) => entry.resource?.resourceType === "Task" && (entry.search?.mode ?? "match") === "match")
      .map((entry: Resource) => summarize(entry.resource, index, locations)),
    next: cursorFromLink(link("next")),
    previous: cursorFromLink(link("previous")),
  };
}

export async function searchPrescriptions(
  fhir: Fhir,
  reference: ReferenceData,
  portalUser: string,
  query: SearchQuery,
): Promise<SearchResult> {
  const cursor = clean(query.cursor, 400);
  const [response, names] = await Promise.all([
    cursor ? fhir.page(pagingQueryFromCursor(cursor), portalUser) : fhir.get("Task", searchParams(query), portalUser),
    reference.names(portalUser),
  ]);
  if (response.status === 404 || response.status === 410) {
    throw new BadRequest("These results have expired. Please search again.");
  }
  expectOk(response, "Task search");
  return toSearchResult(response.body, names.locations);
}

// ---------------------------------------------------------------- detail
export interface TimelineEvent {
  at: string;
  actor: "eRegister" | "CDU";
  title: string;
  detail: string | null;
  stage: Stage | null;
}

const statusReasonText = (task: Resource): string | null => {
  const reason = task.statusReason;
  if (!reason) return null;
  if (reason.text) return reason.text;
  return (reason.coding ?? []).map((coding: Resource) => REJECTION_REASONS[coding.code] ?? coding.code).join(", ") || null;
};

const AMENDABLE: [string, (mr: Resource) => unknown][] = [
  ["regimen", (mr) => regimen(mr).code],
  ["dosage", (mr) => JSON.stringify(mr.dosageInstruction ?? [])],
  ["pickup point", (mr) => extension(mr, EXT.pickupPoint)?.valueReference?.reference],
  ["requested pickup date", (mr) => extension(mr, EXT.requestedPickupDate)?.valueDate],
  ["next clinical visit", (mr) => extension(mr, EXT.nextClinicalVisitDate)?.valueDate],
  ["supply", (mr) => JSON.stringify(mr.dispenseRequest ?? {})],
];

/**
 * What happened to the prescription, oldest first, from the version history
 * of its Task and MedicationRequest. The actor follows from the contract:
 * only eRegister writes MedicationRequests or sets a Task back to
 * 'requested', and eRegister cancels the MedicationRequest with the Task.
 */
export function buildTimeline(taskVersions: Resource[], requestVersions: Resource[]): TimelineEvent[] {
  const events: TimelineEvent[] = [];
  const byVersion = (a: Resource, b: Resource) => Number(a.meta?.versionId ?? 0) - Number(b.meta?.versionId ?? 0);
  const tasks = [...taskVersions].sort(byVersion);
  const requests = [...requestVersions].sort(byVersion);
  const requestCancelled = requests.some((request) => request.status === "cancelled");

  let previous: Resource | null = null;
  for (const task of tasks) {
    const at = task.meta?.lastUpdated ?? task.lastModified ?? task.authoredOn;
    const status = statusInfo(task);
    if (!previous) {
      events.push({ at, actor: "eRegister", title: "Published by the facility", detail: null, stage: "waiting" });
    } else {
      const changed =
        previous.status !== task.status ||
        statusOf(previous) !== status.code ||
        statusReasonText(previous) !== statusReasonText(task);
      if (changed) {
        if (task.status === "requested") {
          events.push({ at, actor: "eRegister", title: "Re-sent to the CDU by the facility", detail: null, stage: "waiting" });
        } else if (status.code === "cancelled" && requestCancelled) {
          events.push({ at, actor: "eRegister", title: "Cancelled by the facility", detail: null, stage: "cancelled" });
        } else {
          events.push({
            at,
            actor: "CDU",
            title: status.code === "received" && previous.status === "requested" ? "Received by the CDU" : status.label,
            detail: statusReasonText(task),
            stage: status.stage,
          });
        }
      }
    }
    previous = task;
  }

  let previousRequest: Resource | null = null;
  for (const request of requests) {
    if (previousRequest) {
      const at = request.meta?.lastUpdated;
      if (request.status === "cancelled" && previousRequest.status !== "cancelled") {
        events.push({ at, actor: "eRegister", title: "Prescription cancelled in eRegister", detail: null, stage: "cancelled" });
      } else {
        const changes = AMENDABLE.filter(
          ([, read]) => JSON.stringify(read(request)) !== JSON.stringify(read(previousRequest!)),
        ).map(([label]) => label);
        if (changes.length) {
          events.push({ at, actor: "eRegister", title: "Prescription amended by the facility", detail: `Changed: ${changes.join(", ")}`, stage: null });
        }
      }
    }
    previousRequest = request;
  }

  return events.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
}

export interface PrescriptionDetail {
  summary: PrescriptionSummary;
  fulfilment: {
    taskStatus: string;
    statusReason: string | null;
    /** When eRegister created the Task (its first version). */
    publishedAt: string | null;
    owner: string | null;
    lastModified: string | null;
    lastUpdated: string | null;
    version: string | null;
  };
  prescription: {
    id: string | null;
    status: string | null;
    category: string | null;
    dosage: string | null;
    prescriber: string | null;
    requestedPickupDate: string | null;
    nextClinicalVisitDate: string | null;
    supplyDays: number | null;
    repeatsAllowed: number | null;
  };
  patient: {
    id: string | null;
    name: string | null;
    eregisterId: string | null;
    nationalId: string | null;
    hivProgramId: string | null;
    gender: string | null;
    birthDate: string | null;
    phones: string[];
    address: string | null;
  };
  allergies: { label: string; status: string | null }[];
  noKnownAllergies: boolean;
  dispenses: {
    id: string;
    status: string | null;
    whenPrepared: string | null;
    whenHandedOver: string | null;
    quantity: string | null;
    daysSupply: number | null;
  }[];
  timeline: TimelineEvent[];
}

export function firstVersionTime(versions: Resource[]): string | null {
  const first = [...versions].sort((a, b) => Number(a.meta?.versionId ?? 0) - Number(b.meta?.versionId ?? 0))[0];
  return first?.meta?.lastUpdated ?? null;
}

/** The ids needed to find a prescription's OpenHIM transactions. */
export async function prescriptionIds(fhir: Fhir, portalUser: string, taskId: string) {
  if (!FHIR_ID.test(taskId)) throw new BadRequest("Invalid prescription id.");
  const history = await fhir.get(`Task/${taskId}/_history`, { _count: "100" }, portalUser);
  if (history.status === 404 || history.status === 410) return null;
  expectOk(history, "Task history");
  const versions = entries(history);
  if (!versions.length) return null;
  const latest = [...versions].sort((a, b) => Number(b.meta?.versionId ?? 0) - Number(a.meta?.versionId ?? 0))[0];
  return {
    taskId,
    medicationRequestId: refId(latest.focus?.reference),
    publishedAt: firstVersionTime(versions),
  };
}

function expectOk(response: FhirResponse, what: string) {
  if (response.status !== 200) {
    throw new Error(`${what} answered HTTP ${response.status}`);
  }
}

const entries = (response: FhirResponse): Resource[] =>
  ((response.body.entry ?? []) as Resource[]).map((entry) => entry.resource).filter(Boolean);

export async function loadPrescription(
  fhir: Fhir,
  reference: ReferenceData,
  portalUser: string,
  taskId: string,
): Promise<PrescriptionDetail | null> {
  if (!FHIR_ID.test(taskId)) throw new BadRequest("Invalid prescription id.");
  const [found, names] = await Promise.all([
    fhir.get(
      "Task",
      { _id: taskId, _include: ["Task:focus", "Task:patient", "Task:requester", "Task:owner"] },
      portalUser,
    ),
    reference.names(portalUser),
  ]);
  expectOk(found, "Task read");
  const resources = entries(found);
  const task = resources.find((resource) => resource.resourceType === "Task");
  if (!task) return null;
  const index = new Map(resources.map((resource) => [`${resource.resourceType}/${resource.id}`, resource]));
  const medicationRequest = index.get(task.focus?.reference);
  const patient = index.get(task.for?.reference);
  const owner = index.get(task.owner?.reference);

  const [taskHistory, requestHistory, allergies, dispenses] = await Promise.all([
    fhir.get(`Task/${task.id}/_history`, { _count: "100" }, portalUser),
    medicationRequest
      ? fhir.get(`MedicationRequest/${medicationRequest.id}/_history`, { _count: "100" }, portalUser)
      : null,
    patient ? fhir.get("AllergyIntolerance", { patient: `Patient/${patient.id}`, _count: "50" }, portalUser) : null,
    medicationRequest
      ? fhir.get("MedicationDispense", { prescription: `MedicationRequest/${medicationRequest.id}`, _count: "50" }, portalUser)
      : null,
  ]);
  for (const [response, what] of [
    [taskHistory, "Task history"],
    [requestHistory, "MedicationRequest history"],
    [allergies, "AllergyIntolerance search"],
    [dispenses, "MedicationDispense search"],
  ] as const) {
    if (response) expectOk(response, what);
  }

  const allergyResources = allergies ? entries(allergies) : [];
  const activeAllergies = allergyResources.filter((allergy) => {
    const clinical = allergy.clinicalStatus?.coding?.[0]?.code;
    const verification = allergy.verificationStatus?.coding?.[0]?.code;
    return !["inactive", "resolved"].includes(clinical) && !["refuted", "entered-in-error"].includes(verification);
  });
  const realAllergies = activeAllergies.filter(
    (allergy) => !(allergy.code?.coding ?? []).every((coding: Resource) => NO_KNOWN_ALLERGY_CODES.has(coding.code)),
  );

  const supply = medicationRequest?.dispenseRequest?.expectedSupplyDuration;
  return {
    summary: summarize(task, index, names.locations),
    fulfilment: {
      taskStatus: task.status,
      statusReason: statusReasonText(task),
      publishedAt: firstVersionTime(entries(taskHistory)),
      owner: owner?.name ?? refId(task.owner?.reference),
      lastModified: task.lastModified ?? null,
      lastUpdated: task.meta?.lastUpdated ?? null,
      version: task.meta?.versionId ?? null,
    },
    prescription: {
      id: medicationRequest?.id ?? null,
      status: medicationRequest?.status ?? null,
      category: medicationRequest?.category?.[0]?.coding?.[0]?.code ?? null,
      dosage:
        (medicationRequest?.dosageInstruction ?? [])
          .map((dosage: Resource) => dosage.patientInstruction ?? dosage.text)
          .filter(Boolean)
          .join("\n") || null,
      prescriber: medicationRequest?.requester?.display ?? null,
      requestedPickupDate: extension(medicationRequest, EXT.requestedPickupDate)?.valueDate ?? null,
      nextClinicalVisitDate: extension(medicationRequest, EXT.nextClinicalVisitDate)?.valueDate ?? null,
      supplyDays: supply?.code === "d" || supply?.unit === "days" ? (supply?.value ?? null) : null,
      repeatsAllowed: medicationRequest?.dispenseRequest?.numberOfRepeatsAllowed ?? null,
    },
    patient: {
      id: patient?.id ?? null,
      name: patientName(patient),
      eregisterId: identifier(patient, SYSTEMS.eregisterId),
      nationalId: identifier(patient, SYSTEMS.nationalId),
      hivProgramId: identifier(patient, SYSTEMS.hivProgramId),
      gender: patient?.gender ?? null,
      birthDate: patient?.birthDate ?? null,
      phones: [...(patient?.telecom ?? [])]
        .filter((telecom: Resource) => ["phone", "sms"].includes(telecom.system) && telecom.value)
        .sort((a: Resource, b: Resource) => (a.rank ?? 999) - (b.rank ?? 999))
        .map((telecom: Resource) => telecom.value),
      address: (() => {
        const address = patient?.address?.[0];
        if (!address) return null;
        return address.text ?? ([...(address.line ?? []), address.city, address.district].filter(Boolean).join(", ") || null);
      })(),
    },
    allergies: realAllergies.map((allergy) => ({
      label: allergy.code?.text ?? allergy.code?.coding?.[0]?.display ?? "Recorded allergy",
      status: allergy.clinicalStatus?.coding?.[0]?.code ?? null,
    })),
    noKnownAllergies: activeAllergies.length > 0 && realAllergies.length === 0,
    dispenses: (dispenses ? entries(dispenses) : []).map((dispense) => ({
      id: dispense.id,
      status: dispense.status ?? null,
      whenPrepared: dispense.whenPrepared ?? null,
      whenHandedOver: dispense.whenHandedOver ?? null,
      quantity: dispense.quantity ? `${dispense.quantity.value} ${dispense.quantity.unit ?? ""}`.trim() : null,
      daysSupply: dispense.daysSupply?.value ?? null,
    })),
    timeline: buildTimeline(entries(taskHistory), requestHistory ? entries(requestHistory) : []),
  };
}
