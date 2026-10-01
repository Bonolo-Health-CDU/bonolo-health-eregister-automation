import { readFileSync } from "node:fs";
import { request } from "node:https";
import type { Config } from "./config.ts";

export class OpenHimError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export interface OpenHimClient {
  _id: string;
  clientID: string;
  name: string;
  roles: string[];
}

export interface OpenHimTransaction {
  _id: string;
  status: string;
  clientID?: string;
  channelID?: string;
  request: { method: string; path: string; querystring?: string; timestamp: string };
  response?: { status?: number; timestamp?: string; body?: string };
}

export type Representation = "simpledetails" | "full";

export interface OpenHim {
  get<T>(path: string, query?: Record<string, string>): Promise<T>;
  /** Transactions matching a Mongo-style filter, newest first. */
  transactions(filters: Record<string, unknown>, limit: number, representation: Representation): Promise<OpenHimTransaction[]>;
  count(filters: Record<string, unknown>): Promise<number>;
  clients(): Promise<Map<string, OpenHimClient>>;
}

/** OpenHIM parses request.timestamp from a JSON string inside the filter. */
export const timestampFilter = (range: { $gte?: string; $lte?: string }) => ({
  "request.timestamp": JSON.stringify(range),
});

/**
 * Read-only client for the OpenHIM management API, signed in as the
 * portal-monitor user. The API uses HTTPS, with a self-signed certificate in
 * the demo stack: trust it via OPENHIM_API_CA_FILE, or for local demos only
 * set OPENHIM_API_INSECURE_TLS=true.
 *
 * OpenHIM checks a bcrypt hash on every basic-auth request (about 2 s each),
 * so the client signs in once and reuses the session cookie, signing in
 * again when the session expires.
 */
export function createOpenHim(config: NonNullable<Config["openhim"]>): OpenHim {
  const ca = config.caFile ? readFileSync(config.caFile) : undefined;
  let clientCache: { at: number; value: Promise<Map<string, OpenHimClient>> } | null = null;
  let session: Promise<string> | null = null;

  function send(
    method: "GET" | "POST",
    url: URL,
    headers: Record<string, string>,
    body?: string,
  ): Promise<{ status: number; text: string; cookies: string[] }> {
    return new Promise((resolve, reject) => {
      const req = request(
        url,
        { method, headers, ca, rejectUnauthorized: !config.insecureTls, timeout: config.timeoutMs },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (chunk: Buffer) => chunks.push(chunk));
          res.on("end", () =>
            resolve({
              status: res.statusCode ?? 0,
              text: Buffer.concat(chunks).toString("utf8"),
              cookies: (res.headers["set-cookie"] ?? []).map((cookie) => cookie.split(";")[0]),
            }),
          );
        },
      );
      req.on("timeout", () => req.destroy(new Error(`OpenHIM API ${url.pathname} timed out`)));
      req.on("error", reject);
      req.end(body);
    });
  }

  function signIn(): Promise<string> {
    session ??= send(
      "POST",
      new URL(`${config.apiUrl}/authenticate/local`),
      { "Content-Type": "application/json", Accept: "application/json" },
      JSON.stringify({ username: config.user, password: config.password }),
    ).then((response) => {
      if (response.status !== 200 || !response.cookies.length) {
        throw new OpenHimError(response.status, `OpenHIM sign-in as ${config.user} failed (HTTP ${response.status})`);
      }
      return response.cookies.join("; ");
    });
    session.catch(() => {
      session = null;
    });
    return session;
  }

  async function get<T>(path: string, query: Record<string, string> = {}): Promise<T> {
    const url = new URL(`${config.apiUrl}/${path.replace(/^\/+/, "")}`);
    url.search = new URLSearchParams(query).toString();
    let response;
    for (let attempt = 0; attempt < 2; attempt++) {
      const cookie = await signIn();
      response = await send("GET", url, { Accept: "application/json", Cookie: cookie });
      if (response.status !== 401) break;
      if (session && (await session) === cookie) session = null; // expired: sign in again once
    }
    if (response!.status < 200 || response!.status >= 300) {
      throw new OpenHimError(response!.status, `OpenHIM API ${url.pathname} answered HTTP ${response!.status}`);
    }
    try {
      return JSON.parse(response!.text) as T;
    } catch {
      throw new OpenHimError(response!.status, `OpenHIM API ${url.pathname} returned invalid JSON`);
    }
  }

  return {
    get,
    transactions(filters, limit, representation) {
      return get<OpenHimTransaction[]>("transactions", {
        filterLimit: String(limit),
        filterPage: "0",
        filterRepresentation: representation,
        filters: JSON.stringify(filters),
      });
    },
    async count(filters) {
      // "bulkrerun" is OpenHIM's count-only representation.
      const result = await get<{ count: number }>("transactions", {
        filterRepresentation: "bulkrerun",
        filters: JSON.stringify(filters),
      });
      return result.count;
    },
    clients() {
      if (!clientCache || Date.now() - clientCache.at > 300_000) {
        const value = get<OpenHimClient[]>("clients").then((list) => new Map(list.map((client) => [client._id, client])));
        clientCache = { at: Date.now(), value };
        value.catch(() => {
          clientCache = null;
        });
      }
      return clientCache.value;
    },
  };
}
