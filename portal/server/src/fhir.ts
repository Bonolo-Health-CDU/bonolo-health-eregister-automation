import type { Config } from "./config.ts";

export interface FhirResponse {
  status: number;
  body: Record<string, unknown>;
  elapsedMs: number;
}

export interface FhirSearchResult {
  /** Matches and _include-d resources from every page, in server order. */
  resources: Record<string, unknown>[];
  /** True when maxPages was reached before the last page. */
  truncated: boolean;
}

/** Search parameters; an array repeats the parameter (e.g. two authored-on bounds). */
export type FhirParams = Record<string, string | string[]>;

export interface Fhir {
  get(path: string, params: FhirParams, portalUser: string): Promise<FhirResponse>;
  /** Fetch a page of an earlier search, from the query part of HAPI's next/previous link. */
  page(pagingQuery: string, portalUser: string): Promise<FhirResponse>;
  searchAll(path: string, params: FhirParams, portalUser: string, maxPages: number): Promise<FhirSearchResult>;
}

export function toSearchParams(params: FhirParams): URLSearchParams {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    for (const item of Array.isArray(value) ? value : [value]) search.append(key, item);
  }
  return search;
}

export class FhirError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/**
 * HAPI builds paging links from its public address (http://localhost:5001/fhir),
 * which is not reachable from this container. Keep the query and re-root it on
 * the configured base URL.
 */
export function rerootLink(link: string, baseUrl: string): string {
  const url = new URL(link);
  const basePath = new URL(baseUrl).pathname.replace(/\/+$/, "");
  const rest = url.pathname.startsWith(basePath) ? url.pathname.slice(basePath.length) : url.pathname;
  return `${baseUrl}${rest.replace(/\/+$/, "")}${url.search}`;
}

/**
 * Read-only FHIR client. Calls go through OpenHIM as the `portal` client;
 * X-Portal-User names the signed-in person, so OpenHIM's transaction log
 * shows who viewed what.
 */
export function createFhirClient(config: Config, fetchImpl: typeof fetch = fetch): Fhir {
  const { baseUrl, clientId, password, timeoutMs } = config.fhir;
  const authorization = `Basic ${Buffer.from(`${clientId}:${password}`).toString("base64")}`;

  async function fetchJson(url: URL | string, portalUser: string): Promise<FhirResponse> {
    const started = performance.now();
    const response = await fetchImpl(url, {
      headers: {
        Accept: "application/fhir+json",
        Authorization: authorization,
        "Cache-Control": "no-cache",
        "X-Portal-User": portalUser,
      },
      signal: AbortSignal.timeout(timeoutMs),
    });
    const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    return { status: response.status, body, elapsedMs: Math.round(performance.now() - started) };
  }

  function get(path: string, params: FhirParams, portalUser: string): Promise<FhirResponse> {
    const url = new URL(`${baseUrl}/${path.replace(/^\/+/, "")}`);
    url.search = toSearchParams(params).toString();
    return fetchJson(url, portalUser);
  }

  function page(pagingQuery: string, portalUser: string): Promise<FhirResponse> {
    return fetchJson(`${baseUrl}?${pagingQuery}`, portalUser);
  }

  async function searchAll(
    path: string,
    params: FhirParams,
    portalUser: string,
    maxPages: number,
  ): Promise<FhirSearchResult> {
    const resources: Record<string, unknown>[] = [];
    let response = await get(path, params, portalUser);
    for (let page = 1; ; page++) {
      if (response.status !== 200) {
        throw new FhirError(response.status, `FHIR search ${path} answered HTTP ${response.status}`);
      }
      for (const entry of (response.body.entry ?? []) as { resource?: Record<string, unknown> }[]) {
        if (entry.resource) resources.push(entry.resource);
      }
      const next = ((response.body.link ?? []) as { relation?: string; url?: string }[]).find(
        (link) => link.relation === "next",
      )?.url;
      if (!next) return { resources, truncated: false };
      if (page >= maxPages) return { resources, truncated: true };
      response = await fetchJson(rerootLink(next, baseUrl), portalUser);
    }
  }

  return { get, page, searchAll };
}
