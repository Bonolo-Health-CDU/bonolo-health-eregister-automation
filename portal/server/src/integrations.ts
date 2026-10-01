import type { Fhir } from "./fhir.ts";
import { timestampFilter, type OpenHim, type OpenHimClient, type OpenHimTransaction } from "./openhim.ts";

/**
 * Integration health: OpenHIM and the FHIR server, traffic and failures per
 * client, and the transactions behind a single prescription.
 *
 * Request bodies (which carry patient data) are never returned; from response
 * bodies only OperationOutcome diagnostics are extracted.
 */

const IG_BASE = "http://fhir.health.gov.ls/bonolo-cdu";

export const WINDOWS = { "24h": 24, "7d": 168 } as const;
export type HealthWindow = keyof typeof WINDOWS;

export type ProblemCategory =
  | "refused"
  | "contract-rejection"
  | "not-found"
  | "version-conflict"
  | "client-error"
  | "server-error";

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

export interface Problem extends TransactionRow {
  category: ProblemCategory;
  diagnostics: string | null;
}

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

const SERVER_ERROR = { $or: [{ "response.status": { $gte: 500 } }, { status: "Failed" }] };

export function categorize(httpStatus: number | null, txStatus: string, hasOutcome: boolean): ProblemCategory {
  if (httpStatus === null || httpStatus >= 500 || txStatus === "Failed") return "server-error";
  if (httpStatus === 401 || httpStatus === 403) return "refused";
  if (httpStatus === 404) return "not-found";
  if (httpStatus === 409) return "version-conflict";
  if ([400, 412, 422].includes(httpStatus) && hasOutcome) return "contract-rejection";
  return "client-error";
}

/** Error/fatal diagnostics from an OperationOutcome response body, if that is what it is. */
export function outcomeDiagnostics(body: string | undefined): string | null {
  if (!body) return null;
  try {
    const outcome = JSON.parse(body);
    if (outcome?.resourceType !== "OperationOutcome") return null;
    const messages = (outcome.issue ?? [])
      .filter((issue: any) => ["error", "fatal"].includes(issue.severity))
      .map((issue: any) => issue.diagnostics ?? issue.details?.text ?? issue.code)
      .filter(Boolean);
    const text = messages.join(" · ");
    return text ? (text.length > 600 ? `${text.slice(0, 600)}…` : text) : null;
  } catch {
    return null;
  }
}

export function toRow(
  transaction: OpenHimTransaction,
  clients: Map<string, OpenHimClient>,
  channels: Map<string, string>,
): TransactionRow {
  const started = Date.parse(transaction.request.timestamp);
  const ended = Date.parse(transaction.response?.timestamp ?? "");
  const query = transaction.request.querystring ? `?${transaction.request.querystring}` : "";
  return {
    id: transaction._id,
    at: transaction.request.timestamp,
    client: transaction.clientID ? (clients.get(transaction.clientID)?.clientID ?? "unknown client") : "no client",
    channel: transaction.channelID ? (channels.get(transaction.channelID) ?? null) : null,
    method: transaction.request.method,
    path: `${transaction.request.path}${query}`.slice(0, 300),
    httpStatus: transaction.response?.status ?? null,
    status: transaction.status,
    durationMs: Number.isNaN(started) || Number.isNaN(ended) ? null : ended - started,
  };
}

export function toProblem(
  transaction: OpenHimTransaction,
  clients: Map<string, OpenHimClient>,
  channels: Map<string, string>,
): Problem {
  const row = toRow(transaction, clients, channels);
  const diagnostics = outcomeDiagnostics(transaction.response?.body);
  return { ...row, category: categorize(row.httpStatus, row.status, diagnostics !== null), diagnostics };
}

const settle = async <T>(promise: Promise<T>): Promise<{ ok: true; value: T } | { ok: false; error: string }> => {
  try {
    return { ok: true, value: await promise };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
};

interface ChannelRecord {
  _id: string;
  name: string;
  status?: string;
  methods?: string[];
  allow?: string[];
  urlPattern?: string;
  priority?: number;
}

export async function loadIntegrationHealth(
  openhim: OpenHim,
  fhir: Fhir,
  portalUser: string,
  options: { window: HealthWindow; now: Date; cduClientId: string },
): Promise<IntegrationHealth> {
  const since = new Date(options.now.getTime() - WINDOWS[options.window] * 3600_000).toISOString();
  const inWindow = timestampFilter({ $gte: since });

  // First, alone: a fresh OpenHIM sign-in checks a bcrypt hash, which stalls
  // OpenHIM for ~2 s and would distort the FHIR latency measured below.
  const heartbeat = await settle(openhim.get<{ master?: number }>("heartbeat"));
  const [about, channelList, clients, metadata, profiles] = await Promise.all([
    settle(openhim.get<{ currentCoreVersion?: string }>("about")),
    settle(openhim.get<ChannelRecord[]>("channels")),
    settle(openhim.clients()),
    settle(fhir.get("metadata", { _summary: "true" }, portalUser)),
    settle(
      fhir.get(
        "StructureDefinition",
        { "url:below": IG_BASE, _elements: "url,version,name,title,status", _count: "100" },
        portalUser,
      ),
    ),
  ]);

  const health: IntegrationHealth = {
    generatedAt: options.now.toISOString(),
    window: options.window,
    openhim: heartbeat.ok
      ? {
          reachable: true,
          version: about.ok ? (about.value.currentCoreVersion ?? null) : null,
          uptimeSeconds: typeof heartbeat.value.master === "number" ? Math.round(heartbeat.value.master) : null,
        }
      : { reachable: false, error: "The OpenHIM API could not be reached." },
    fhir:
      metadata.ok && metadata.value.status === 200
        ? {
            reachable: true,
            software: (metadata.value.body.software as any)?.name ?? null,
            version: (metadata.value.body.software as any)?.version ?? null,
            fhirVersion: (metadata.value.body.fhirVersion as string) ?? null,
            latencyMs: metadata.value.elapsedMs,
          }
        : {
            reachable: false,
            error: metadata.ok ? `The FHIR server answered HTTP ${metadata.value.status}.` : "The FHIR server could not be reached through OpenHIM.",
          },
    contract: { version: null, profiles: [] },
    clients: [],
    statusPublications: { total: 0, failed: 0 },
    contractRejections: 0,
    problems: [],
    channels: [],
  };

  if (profiles.ok && profiles.value.status === 200) {
    const list = ((profiles.value.body.entry ?? []) as { resource: any }[]).map(({ resource }) => ({
      name: resource.title ?? resource.name ?? resource.url,
      url: resource.url,
      version: resource.version ?? null,
      status: resource.status ?? null,
    }));
    list.sort((a, b) => a.name.localeCompare(b.name));
    const versions = [...new Set(list.map((profile) => profile.version).filter(Boolean))];
    health.contract = { version: versions.length === 1 ? versions[0] : versions.join(", ") || null, profiles: list };
  }

  if (!heartbeat.ok || !clients.ok || !channelList.ok) return health;

  const channelNames = new Map(channelList.value.map((channel) => [channel._id, channel.name]));
  health.channels = channelList.value
    .map((channel) => ({
      name: channel.name,
      status: channel.status ?? "enabled",
      methods: channel.methods ?? [],
      allow: channel.allow ?? [],
      urlPattern: channel.urlPattern ?? "",
      priority: channel.priority ?? null,
    }))
    .sort((a, b) => (a.priority ?? 99) - (b.priority ?? 99));

  const clientList = [...clients.value.values()];
  const cdu = clientList.find((client) => client.clientID === options.cduClientId);
  const taskWrites = cdu
    ? { ...inWindow, clientID: cdu._id, "request.method": { $in: ["PUT", "PATCH"] }, "request.path": "^/fhir/Task/" }
    : null;

  const [perClient, publications, publicationFailures, rejections, problems] = await Promise.all([
    Promise.all(
      clientList.map(async (client) => {
        const mine = { ...inWindow, clientID: client._id };
        const [requests, clientErrors, serverErrors, last] = await Promise.all([
          openhim.count(mine),
          openhim.count({ ...mine, "response.status": { $gte: 400, $lt: 500 } }),
          openhim.count({ ...mine, ...SERVER_ERROR }),
          openhim.transactions({ clientID: client._id }, 1, "simpledetails"),
        ]);
        return {
          clientId: client.clientID,
          name: client.name,
          roles: client.roles ?? [],
          requests,
          clientErrors,
          serverErrors,
          lastSeen: last[0]?.request.timestamp ?? null,
        };
      }),
    ),
    taskWrites ? openhim.count(taskWrites) : 0,
    taskWrites ? openhim.count({ ...taskWrites, $or: [{ "response.status": { $gte: 400 } }, { status: "Failed" }] }) : 0,
    openhim.count({ ...inWindow, "response.status": { $in: [400, 412, 422] } }),
    openhim.transactions(
      { ...inWindow, $or: [{ "response.status": { $gte: 400 } }, { status: "Failed" }] },
      50,
      "full",
    ),
  ]);

  health.clients = perClient.sort((a, b) => b.requests - a.requests);
  health.statusPublications = { total: publications, failed: publicationFailures };
  health.contractRejections = rejections;
  health.problems = problems.map((transaction) => toProblem(transaction, clients.value, channelNames));
  return health;
}

const escapeRegex = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * The OpenHIM transactions that changed one prescription: writes to its Task
 * and MedicationRequest, and the eRegister transaction Bundle that created it
 * (found by time, then confirmed by the Task location in its response).
 */
export async function transactionsForPrescription(
  openhim: OpenHim,
  ids: { taskId: string; medicationRequestId: string | null; publishedAt: string | null },
): Promise<TransactionRow[]> {
  const [clients, channelList] = await Promise.all([openhim.clients(), openhim.get<ChannelRecord[]>("channels")]);
  const channelNames = new Map(channelList.map((channel) => [channel._id, channel.name]));
  const writes = (type: string, id: string) =>
    openhim.transactions(
      { "request.path": `^/fhir/${type}/${escapeRegex(id)}(/|$)`, "request.method": { $ne: "GET" } },
      100,
      "simpledetails",
    );

  const published = ids.publishedAt ? Date.parse(ids.publishedAt) : NaN;
  const [taskWrites, requestWrites, bundles] = await Promise.all([
    writes("Task", ids.taskId),
    ids.medicationRequestId ? writes("MedicationRequest", ids.medicationRequestId) : [],
    Number.isNaN(published)
      ? []
      : openhim.transactions(
          {
            "request.method": "POST",
            "request.path": "^/fhir/?$",
            ...timestampFilter({
              $gte: new Date(published - 60_000).toISOString(),
              $lte: new Date(published + 5_000).toISOString(),
            }),
          },
          10,
          "full",
        ),
  ]);
  const publication = bundles.filter((bundle) => (bundle.response?.body ?? "").includes(`Task/${ids.taskId}/`));

  const seen = new Set<string>();
  return [...publication, ...taskWrites, ...requestWrites]
    .filter((transaction) => !seen.has(transaction._id) && seen.add(transaction._id))
    .map((transaction) => toRow(transaction, clients, channelNames))
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
}
