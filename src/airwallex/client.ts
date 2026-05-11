import { config } from "../config.js";
import { getAirwallexToken } from "./auth.js";

export async function airwallexGet<T>(
  path: string,
  params?: Record<string, string | number | undefined>,
): Promise<T> {
  const token = await getAirwallexToken();
  const url = new URL(`${config.AIRWALLEX_BASE_URL}${path}`);
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined) url.searchParams.set(k, String(v));
    }
  }
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) {
    throw new Error(`Airwallex ${path} ${res.status}: ${await res.text()}`);
  }
  return (await res.json()) as T;
}

export type AirwallexStatus = "PENDING" | "SETTLED" | "CANCELLED";

export type AirwallexTransactionType =
  | "ISSUING_AUTHORISATION_HOLD"
  | "ISSUING_AUTHORISATION_RELEASE"
  | "ISSUING_CAPTURE"
  | "CONVERSION_BUY"
  | "CONVERSION_SELL"
  | "DEPOSIT";

export type AirwallexSourceType = "CARD_PURCHASE" | "CONVERSION" | "DEPOSIT";

export interface FinancialTransaction {
  id: string;
  batch_id: string | null;
  source_id: string | null;
  funding_source_id: string | null;
  source_type: AirwallexSourceType | string;
  transaction_type: AirwallexTransactionType | string;
  status: AirwallexStatus | string;
  currency: string;
  amount: number;
  net: number;
  fee: number;
  client_rate: number | null;
  currency_pair: string | null;
  description: string | null;
  created_at: string;
  settled_at: string | null;
  estimated_settled_at: string | null;
  [k: string]: unknown;
}

export interface FinancialTransactionsResponse {
  has_more?: boolean;
  items?: FinancialTransaction[];
}
