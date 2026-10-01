import type { Fhir } from "./fhir.ts";
import type { ReferenceData } from "./reference.ts";

/**
 * Aggregate dashboard figures. Only counts leave this module: programme
 * managers see the dashboard, and they never see patient-level data.
 */

const FULFILMENT_STATUS_SYSTEM = "http://fhir.health.gov.ls/bonolo-cdu/CodeSystem/cdu-fulfilment-status";
const EXT_PICKUP_POINT = "http://fhir.health.gov.ls/bonolo-cdu/StructureDefinition/pickup-point";

export type Stage = "waiting" | "atCdu" | "withFacility" | "onTheWay" | "completed" | "problem" | "cancelled";

// Order and labels follow the "Status Map" tab of the data-mapping sheet.
export const STATUSES: { code: string; label: string; stage: Stage }[] = [
  { code: "sent-to-cdu", label: "Sent to CDU", stage: "waiting" },
  { code: "received", label: "Received", stage: "atCdu" },
  { code: "query-raised", label: "Query raised", stage: "atCdu" },
  { code: "returned-to-facility", label: "Returned to facility", stage: "withFacility" },
  { code: "in-preparation", label: "In preparation", stage: "atCdu" },
  { code: "ready-for-dispatch", label: "Ready for dispatch", stage: "atCdu" },
  { code: "dispatched", label: "Dispatched", stage: "onTheWay" },
  { code: "collected", label: "Collected", stage: "completed" },
  { code: "uncollected-returned", label: "Returned uncollected", stage: "problem" },
  { code: "cancelled", label: "Cancelled", stage: "cancelled" },
];
const STAGE_BY_STATUS = new Map(STATUSES.map((status) => [status.code, status.stage]));

// Used only when a Task carries no recognised businessStatus.
const STATUS_BY_TASK_STATUS: Record<string, string> = {
  accepted: "received",
  "in-progress": "in-preparation",
  "on-hold": "query-raised",
  rejected: "returned-to-facility",
  completed: "collected",
  failed: "uncollected-returned",
  cancelled: "cancelled",
};

export type StageCounts = Record<Stage, number>;
export interface BreakdownRow extends StageCounts {
  id: string;
  name: string;
  total: number;
}

export interface Dashboard {
  generatedAt: string;
  period: { days: number; since: string; until: string };
  unclaimedHours: number;
  truncated: boolean;
  total: number;
  stages: StageCounts;
  statuses: { code: string; label: string; stage: Stage; count: number }[];
  unclaimedOverThreshold: number;
  cancelled: { byFacility: number; byCdu: number };
  daily: { date: string; count: number }[];
  facilities: BreakdownRow[];
  pickupPoints: BreakdownRow[];
}

type Resource = Record<string, any>;

const emptyStages = (): StageCounts => ({
  waiting: 0,
  atCdu: 0,
  withFacility: 0,
  onTheWay: 0,
  completed: 0,
  problem: 0,
  cancelled: 0,
});

/** The Status Map bucket for a Task. A 'requested' Task is with the CDU's queue whatever its old businessStatus. */
export function statusOf(task: Resource): string {
  if (task.status === "requested") return "sent-to-cdu";
  const code = (task.businessStatus?.coding ?? []).find(
    (coding: Resource) => coding.system === FULFILMENT_STATUS_SYSTEM && STAGE_BY_STATUS.has(coding.code),
  )?.code;
  return code ?? STATUS_BY_TASK_STATUS[task.status] ?? "received";
}

/** Calendar date (YYYY-MM-DD) of an instant in the given time zone. */
export function localDate(instant: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(
    instant,
  );
}

/** The calendar day a prescription was written, in the portal's time zone (eRegister may send UTC). */
function authoredLocalDate(authoredOn: unknown, timeZone: string): string | undefined {
  if (typeof authoredOn !== "string") return undefined;
  if (/^\d{4}-\d{2}-\d{2}$/.test(authoredOn)) return authoredOn;
  const instant = new Date(authoredOn);
  return Number.isNaN(instant.getTime()) ? undefined : localDate(instant, timeZone);
}

function addDays(date: string, days: number): string {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

export interface AggregateInput {
  resources: Resource[];
  organizationNames: Map<string, string>;
  locationNames: Map<string, string>;
  now: Date;
  days: number;
  unclaimedHours: number;
  timeZone: string;
  truncated: boolean;
}

export function aggregate(input: AggregateInput): Dashboard {
  const until = localDate(input.now, input.timeZone);
  const since = addDays(until, -(input.days - 1));
  const tasks = input.resources.filter((resource) => resource.resourceType === "Task");
  const medicationRequests = new Map(
    input.resources
      .filter((resource) => resource.resourceType === "MedicationRequest")
      .map((resource) => [`MedicationRequest/${resource.id}`, resource]),
  );
  const unclaimedBefore = input.now.getTime() - input.unclaimedHours * 3600_000;

  const stages = emptyStages();
  const statusCounts = new Map<string, number>();
  const daily = new Map<string, number>();
  for (let date = since; date <= until; date = addDays(date, 1)) daily.set(date, 0);
  const facilities = new Map<string, BreakdownRow>();
  const pickupPoints = new Map<string, BreakdownRow>();
  const cancelled = { byFacility: 0, byCdu: 0 };
  let unclaimedOverThreshold = 0;

  const row = (rows: Map<string, BreakdownRow>, reference: string | undefined, names: Map<string, string>) => {
    const id = reference?.split("/").pop() ?? "unknown";
    let entry = rows.get(id);
    if (!entry) {
      entry = { id, name: names.get(id) ?? (reference ? id : "Not recorded"), total: 0, ...emptyStages() };
      rows.set(id, entry);
    }
    return entry;
  };

  for (const task of tasks) {
    const status = statusOf(task);
    const stage = STAGE_BY_STATUS.get(status)!;
    const medicationRequest = medicationRequests.get(task.focus?.reference);

    stages[stage]++;
    statusCounts.set(status, (statusCounts.get(status) ?? 0) + 1);

    const authoredDate = authoredLocalDate(task.authoredOn, input.timeZone);
    if (authoredDate && daily.has(authoredDate)) daily.set(authoredDate, daily.get(authoredDate)! + 1);

    if (status === "sent-to-cdu") {
      const lastChanged = Date.parse(task.meta?.lastUpdated ?? task.lastModified ?? task.authoredOn ?? "");
      if (!Number.isNaN(lastChanged) && lastChanged < unclaimedBefore) unclaimedOverThreshold++;
    }
    if (status === "cancelled") {
      // eRegister cancels the MedicationRequest too; the CDU never touches it.
      if (medicationRequest?.status === "cancelled") cancelled.byFacility++;
      else cancelled.byCdu++;
    }

    const facility = row(facilities, task.requester?.reference, input.organizationNames);
    facility.total++;
    facility[stage]++;

    const pickupReference = (medicationRequest?.extension ?? []).find(
      (extension: Resource) => extension.url === EXT_PICKUP_POINT,
    )?.valueReference?.reference;
    const pickupPoint = row(pickupPoints, pickupReference, input.locationNames);
    pickupPoint.total++;
    pickupPoint[stage]++;
  }

  const byTotal = (a: BreakdownRow, b: BreakdownRow) => b.total - a.total || a.name.localeCompare(b.name);
  return {
    generatedAt: input.now.toISOString(),
    period: { days: input.days, since, until },
    unclaimedHours: input.unclaimedHours,
    truncated: input.truncated,
    total: tasks.length,
    stages,
    statuses: STATUSES.map((status) => ({ ...status, count: statusCounts.get(status.code) ?? 0 })),
    unclaimedOverThreshold,
    cancelled,
    daily: [...daily].map(([date, count]) => ({ date, count })),
    facilities: [...facilities.values()].sort(byTotal),
    pickupPoints: [...pickupPoints.values()].sort(byTotal),
  };
}

export const DASHBOARD_PERIODS = [7, 30, 90, 365] as const;
const PAGE_SIZE = "500";
const MAX_TASK_PAGES = 40; // 20,000 prescriptions per period before the figures are flagged as partial

export interface DashboardOptions {
  days: number;
  now: Date;
  unclaimedHours: number;
  timeZone: string;
}

export async function loadDashboard(
  fhir: Fhir,
  reference: ReferenceData,
  portalUser: string,
  options: DashboardOptions,
): Promise<Dashboard> {
  const since = addDays(localDate(options.now, options.timeZone), -(options.days - 1));
  const [tasks, names] = await Promise.all([
    fhir.searchAll(
      "Task",
      {
        "authored-on": `ge${since}`,
        _include: "Task:focus",
        _elements: "status,businessStatus,requester,focus,authoredOn,lastModified",
        _count: PAGE_SIZE,
      },
      portalUser,
      MAX_TASK_PAGES,
    ),
    reference.names(portalUser),
  ]);
  return aggregate({
    resources: tasks.resources,
    organizationNames: names.organizations,
    locationNames: names.locations,
    truncated: tasks.truncated,
    ...options,
  });
}
