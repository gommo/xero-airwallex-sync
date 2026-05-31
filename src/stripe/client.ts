import { config } from "../config.js";

/**
 * Minimal Stripe GET helper. Uses the restricted read-only key (rk_live_…) as a
 * Bearer token. Supports array params (e.g. expand[]) by passing string[] values.
 */
export async function stripeGet<T>(
  path: string,
  params?: Record<string, string | number | string[] | undefined>,
): Promise<T> {
  if (!config.STRIPE_API_READONLY_KEY) {
    throw new Error("missing STRIPE_API_READONLY_KEY in .env.local");
  }
  const url = new URL(`${config.STRIPE_BASE_URL}/v1${path}`);
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      if (v === undefined) continue;
      if (Array.isArray(v)) {
        for (const item of v) url.searchParams.append(`${k}[]`, item);
      } else {
        url.searchParams.set(k, String(v));
      }
    }
  }
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${config.STRIPE_API_READONLY_KEY}` },
  });
  if (!res.ok) {
    throw new Error(`Stripe ${path} ${res.status}: ${await res.text()}`);
  }
  return (await res.json()) as T;
}

/** Generic shape of a Stripe `list` response. */
export interface StripeList<T> {
  object: "list";
  data: T[];
  has_more: boolean;
}

/**
 * Cursor-paginate a Stripe list endpoint, yielding every item. Stripe uses
 * `starting_after=<last id>` rather than page numbers.
 */
export async function* stripeList<T extends { id: string }>(
  path: string,
  params: Record<string, string | number | string[] | undefined>,
): AsyncGenerator<T> {
  let startingAfter: string | undefined;
  while (true) {
    const page = await stripeGet<StripeList<T>>(path, {
      ...params,
      limit: 100,
      starting_after: startingAfter,
    });
    for (const item of page.data) yield item;
    if (!page.has_more || page.data.length === 0) break;
    startingAfter = page.data[page.data.length - 1]!.id;
  }
}

// ---- Resource shapes (only the fields we persist) -------------------------

/** A balance transaction's `source` when expanded. We only read a few fields. */
export interface ExpandedSource {
  id: string;
  object: string; // "charge" | "application_fee" | "payout" | "refund" | ...
  amount?: number; // presentment amount (minor units)
  currency?: string; // presentment currency
  description?: string | null;
  [k: string]: unknown;
}

export interface BalanceTransaction {
  id: string; // txn_…
  type: string; // charge | application_fee | stripe_fee | payout | reserve_transaction | refund | ...
  reporting_category?: string | null; // charge | platform_earning | fee | connect_reserved_funds | payout | ...
  currency: string; // settlement currency (AUD)
  amount: number; // gross, settlement ccy, minor units
  fee: number; // Stripe fee, minor units
  net: number; // net, minor units
  exchange_rate?: number | null; // presentment → settlement rate (null if same ccy)
  description?: string | null;
  created: number; // unix seconds
  source?: string | ExpandedSource | null;
  [k: string]: unknown;
}

export interface Payout {
  id: string; // po_…
  amount: number;
  currency: string;
  status: string; // paid | pending | in_transit | ...
  method?: string; // standard | instant
  automatic?: boolean;
  arrival_date?: number; // unix seconds
  created: number; // unix seconds
  [k: string]: unknown;
}
