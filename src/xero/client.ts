import { config } from "../config.js";
import { getXeroToken } from "./auth.js";
import { log } from "../log.js";

const BASE = "https://api.xero.com/api.xro/2.0";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Xero limits: 60 calls/min/tenant + 5 concurrent; a 429 carries a Retry-After
// header (whole seconds). Honour it and retry rather than failing the row, so
// large backfills and the unattended daily job ride through rate limits.
async function xeroFetch(method: "GET" | "POST" | "PUT", path: string, url: string | URL, body?: unknown): Promise<Response> {
  if (!config.XERO_TENANT_ID) throw new Error("XERO_TENANT_ID missing");
  const maxRetries = 10;
  for (let attempt = 0; ; attempt++) {
    const token = await getXeroToken();
    const res = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        "Xero-Tenant-Id": config.XERO_TENANT_ID,
        Accept: "application/json",
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    // Retry on rate limit (429) and transient server errors (5xx).
    if ((res.status === 429 || res.status >= 500) && attempt < maxRetries) {
      const retryAfter = Number(res.headers.get("Retry-After"));
      const waitMs = Number.isFinite(retryAfter) && retryAfter > 0 ? (retryAfter + 1) * 1000 : Math.min(2 ** attempt, 30) * 1000;
      log.warn({ path, status: res.status, attempt: attempt + 1, wait_s: Math.round(waitMs / 1000) }, "Xero throttled, backing off");
      await sleep(waitMs);
      continue;
    }
    return res;
  }
}

export async function xeroGet<T>(path: string, params?: Record<string, string | undefined>): Promise<T> {
  const url = new URL(`${BASE}${path}`);
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined) url.searchParams.set(k, v);
    }
  }
  const res = await xeroFetch("GET", path, url);
  if (!res.ok) throw new Error(`Xero GET ${path} ${res.status}: ${await res.text()}`);
  return (await res.json()) as T;
}

export async function xeroPost<T>(path: string, body: unknown): Promise<T> {
  const res = await xeroFetch("POST", path, `${BASE}${path}`, body);
  if (!res.ok) throw new Error(`Xero POST ${path} ${res.status}: ${await res.text()}`);
  return (await res.json()) as T;
}

export async function xeroPut<T>(path: string, body: unknown): Promise<T> {
  const res = await xeroFetch("PUT", path, `${BASE}${path}`, body);
  if (!res.ok) throw new Error(`Xero PUT ${path} ${res.status}: ${await res.text()}`);
  return (await res.json()) as T;
}

export interface XeroAccount {
  AccountID: string;
  Code?: string;
  Name: string;
  Type: string;
  BankAccountNumber?: string;
  CurrencyCode?: string;
  Status: string;
}
