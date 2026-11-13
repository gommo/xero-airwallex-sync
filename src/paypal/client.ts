import { config } from "../config.js";
import { log } from "../log.js";

/**
 * Minimal PayPal REST client for the Transaction Search API.
 * Needs a Live REST app (developer.paypal.com) with the "Transaction Search"
 * feature ticked; client-credentials grant, no user OAuth dance.
 */

let cached: { token: string; expiresAt: number } | null = null;

async function token(): Promise<string> {
  if (cached && cached.expiresAt > Date.now() + 60_000) return cached.token;
  if (!config.PAYPAL_CLIENT_ID || !config.PAYPAL_CLIENT_SECRET) {
    throw new Error("PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET missing from .env.local");
  }
  const basic = Buffer.from(`${config.PAYPAL_CLIENT_ID}:${config.PAYPAL_CLIENT_SECRET}`).toString("base64");
  const res = await fetch(`${config.PAYPAL_BASE_URL}/v1/oauth2/token`, {
    method: "POST",
    headers: { Authorization: `Basic ${basic}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: "grant_type=client_credentials",
  });
  if (!res.ok) throw new Error(`PayPal token ${res.status}: ${await res.text()}`);
  const body = (await res.json()) as { access_token: string; expires_in: number };
  cached = { token: body.access_token, expiresAt: Date.now() + body.expires_in * 1000 };
  return cached.token;
}

export async function paypalGet<T>(path: string, params: Record<string, string | number | undefined>): Promise<T> {
  const url = new URL(`${config.PAYPAL_BASE_URL}${path}`);
  for (const [k, v] of Object.entries(params)) if (v !== undefined) url.searchParams.set(k, String(v));
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, { headers: { Authorization: `Bearer ${await token()}`, Accept: "application/json" } });
    if ((res.status === 429 || res.status >= 500) && attempt < 5) {
      const wait = Math.min(2 ** attempt, 30) * 1000;
      log.warn({ path, status: res.status, wait_ms: wait }, "PayPal throttled, backing off");
      await new Promise((r) => setTimeout(r, wait));
      continue;
    }
    if (!res.ok) throw new Error(`PayPal GET ${path} ${res.status}: ${await res.text()}`);
    return (await res.json()) as T;
  }
}

// ---- Transaction Search shapes (only what we persist) ----------------------

export interface Money {
  currency_code: string;
  value: string;
}
export interface TransactionInfo {
  transaction_id: string;
  paypal_reference_id?: string;
  paypal_reference_id_type?: string;
  transaction_event_code?: string;
  transaction_initiation_date: string;
  transaction_updated_date?: string;
  transaction_amount: Money;
  fee_amount?: Money;
  transaction_status?: string; // S success, P pending, D denied, V reversed
  transaction_subject?: string;
  transaction_note?: string;
  ending_balance?: Money;
  [k: string]: unknown;
}
export interface PayerInfo {
  email_address?: string;
  account_id?: string;
  payer_name?: { given_name?: string; surname?: string; alternate_full_name?: string };
  [k: string]: unknown;
}
export interface TransactionDetail {
  transaction_info: TransactionInfo;
  payer_info?: PayerInfo;
  [k: string]: unknown;
}
interface SearchResponse {
  transaction_details?: TransactionDetail[];
  total_items?: number;
  total_pages?: number;
  page?: number;
}

const MAX_WINDOW_DAYS = 31; // PayPal caps each search at 31 days

function iso(d: Date): string {
  return d.toISOString().replace(/\.\d{3}Z$/, "Z");
}

/** Yields every transaction between from..to, walking 31-day windows and pages. */
export async function* searchTransactions(from: Date, to: Date): AsyncGenerator<TransactionDetail> {
  let winStart = new Date(from);
  while (winStart < to) {
    const winEnd = new Date(Math.min(to.getTime(), winStart.getTime() + MAX_WINDOW_DAYS * 86_400_000 - 1000));
    for (let page = 1; ; page++) {
      const res = await paypalGet<SearchResponse>("/v1/reporting/transactions", {
        start_date: iso(winStart),
        end_date: iso(winEnd),
        fields: "transaction_info,payer_info",
        page_size: 500,
        page,
      });
      for (const t of res.transaction_details ?? []) yield t;
      if (!res.total_pages || page >= res.total_pages) break;
    }
    winStart = new Date(winEnd.getTime() + 1000);
  }
}
