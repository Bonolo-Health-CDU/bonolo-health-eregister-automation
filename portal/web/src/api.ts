import type { PortalRole } from "./roles";

export interface PortalUser {
  sub: string;
  username: string;
  name: string;
  email: string | null;
  roles: PortalRole[];
}

export interface SystemStatus {
  fhir:
    | {
        reachable: true;
        via: string;
        software: string | null;
        softwareVersion: string | null;
        fhirVersion: string | null;
        latencyMs: number;
      }
    | { reachable: false; error: string };
  totals?: { tasks: number | null };
}

export type Stage = "waiting" | "atCdu" | "withFacility" | "onTheWay" | "completed" | "problem" | "cancelled";
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

export interface StatusInfo {
  code: string;
  label: string;
  stage: Stage;
}

export interface PrescriptionSummary {
  taskId: string;
  orderId: string | null;
  authoredOn: string | null;
  lastUpdated: string | null;
  status: StatusInfo;
  patient: { name: string | null; eregisterId: string | null };
  facility: { id: string | null; name: string | null };
  pickupPoint: { id: string | null; name: string | null };
  regimen: { code: string | null; display: string | null };
}

export interface SearchResult {
  total: number | null;
  offset: number;
  items: PrescriptionSummary[];
  next: string | null;
  previous: string | null;
}

export interface TimelineEvent {
  at: string;
  actor: "eRegister" | "CDU";
  title: string;
  detail: string | null;
  stage: Stage | null;
}

export interface PrescriptionDetail {
  summary: PrescriptionSummary;
  fulfilment: {
    taskStatus: string;
    statusReason: string | null;
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

export interface TransactionRow {
  id: string;
  at: string;
  client: string;
  channel: string | null;
  method: string;
  path: string;
  httpStatus: number | null;
  status: string;
  durationMs: number | null;
}

export type ProblemCategory =
  | "refused"
  | "contract-rejection"
  | "not-found"
  | "version-conflict"
  | "client-error"
  | "server-error";

export interface Problem extends TransactionRow {
  category: ProblemCategory;
  diagnostics: string | null;
}

export type HealthWindow = "24h" | "7d";

export interface IntegrationHealth {
  generatedAt: string;
  window: HealthWindow;
  openhim: { reachable: true; version: string | null; uptimeSeconds: number | null } | { reachable: false; error: string };
  fhir:
    | { reachable: true; software: string | null; version: string | null; fhirVersion: string | null; latencyMs: number }
    | { reachable: false; error: string };
  contract: { version: string | null; profiles: { name: string; url: string; version: string | null; status: string | null }[] };
  clients: {
    clientId: string;
    name: string;
    roles: string[];
    requests: number;
    clientErrors: number;
    serverErrors: number;
    lastSeen: string | null;
  }[];
  statusPublications: { total: number; failed: number };
  contractRejections: number;
  problems: Problem[];
  channels: { name: string; status: string; methods: string[]; allow: string[]; urlPattern: string; priority: number | null }[];
}

export interface ReferenceLists {
  facilities: { id: string; name: string }[];
  pickupPoints: { id: string; name: string }[];
  statuses: StatusInfo[];
}

export class ApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function getJson<T>(path: string): Promise<T> {
  const response = await fetch(path, { headers: { Accept: "application/json" }, credentials: "same-origin" });
  // Session ended (expired, or the account was disabled): back to sign-in.
  if (response.status === 401 && path !== "/api/me") signIn();
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { message?: string };
    throw new ApiError(response.status, body.message ?? `${path} answered ${response.status}`);
  }
  return (await response.json()) as T;
}

/** Changing requests carry X-Portal-Request, which the server requires (CSRF protection). */
async function send<T>(method: "POST" | "PUT", path: string, body?: unknown): Promise<T> {
  const response = await fetch(path, {
    method,
    credentials: "same-origin",
    headers: { Accept: "application/json", "Content-Type": "application/json", "X-Portal-Request": "1" },
    body: JSON.stringify(body ?? {}),
  });
  if (response.status === 401) signIn();
  if (!response.ok) {
    const error = (await response.json().catch(() => ({}))) as { message?: string };
    throw new ApiError(response.status, error.message ?? `${path} answered ${response.status}`);
  }
  return (await response.json()) as T;
}

export type MfaState = "configured" | "required" | "none";

export interface ManagedUser {
  id: string;
  username: string;
  firstName: string | null;
  lastName: string | null;
  email: string | null;
  enabled: boolean;
  roles: PortalRole[];
  mfa: MfaState;
  passwordChangeRequired: boolean;
  createdAt: string | null;
}

export interface NewUserInput {
  username: string;
  firstName: string;
  lastName: string;
  email: string;
  roles: PortalRole[];
  requireMfa: boolean;
}

export const api = {
  me: () => getJson<PortalUser>("/api/me"),
  systemStatus: () => getJson<SystemStatus>("/api/system/status"),
  reference: () => getJson<ReferenceLists>("/api/reference"),
  integrations: (window: HealthWindow, fresh = false) =>
    getJson<IntegrationHealth>(`/api/integrations?window=${window}${fresh ? "&fresh=1" : ""}`),
  prescriptionTransactions: (taskId: string) =>
    getJson<{ items: TransactionRow[] }>(`/api/prescriptions/${encodeURIComponent(taskId)}/transactions`),
  prescriptions: (query: URLSearchParams) => getJson<SearchResult>(`/api/prescriptions?${query}`),
  prescription: (taskId: string) => getJson<PrescriptionDetail>(`/api/prescriptions/${encodeURIComponent(taskId)}`),
  users: (search = "") => getJson<ManagedUser[]>(`/api/users${search ? `?search=${encodeURIComponent(search)}` : ""}`),
  createUser: (input: NewUserInput) =>
    send<{ user: ManagedUser; temporaryPassword: string }>("POST", "/api/users", input),
  setUserRoles: (id: string, roles: PortalRole[]) => send<ManagedUser>("PUT", `/api/users/${id}/roles`, { roles }),
  setUserEnabled: (id: string, enabled: boolean) => send<ManagedUser>("PUT", `/api/users/${id}/enabled`, { enabled }),
  resetUserPassword: (id: string) =>
    send<{ user: ManagedUser; temporaryPassword: string }>("POST", `/api/users/${id}/reset-password`),
  resetUserMfa: (id: string) => send<ManagedUser>("POST", `/api/users/${id}/reset-mfa`),
  dashboard: (days: number, fresh = false) =>
    getJson<Dashboard>(`/api/dashboard?days=${days}${fresh ? "&fresh=1" : ""}`),
  async logout() {
    const response = await fetch("/auth/logout", { method: "POST", credentials: "same-origin" });
    const { logoutUrl } = (await response.json()) as { logoutUrl: string };
    window.location.assign(logoutUrl);
  },
};

export const signIn = (returnTo = window.location.pathname + window.location.search) =>
  window.location.assign(`/auth/login?returnTo=${encodeURIComponent(returnTo)}`);
