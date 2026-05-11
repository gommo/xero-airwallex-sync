import { db } from "../db/db.js";

export interface ConversionPair {
  source_id: string;
  currency_pair: string;
  client_rate: number;
  status: string;
  created_at: string;
  buy_id: string;
  buy_currency: string;
  buy_amount: number;
  sell_id: string;
  sell_currency: string;
  sell_amount: number;
}

export function listConversionPairs(filter?: { status?: string; currency?: string }): ConversionPair[] {
  const clauses: string[] = [];
  const params: Record<string, string> = {};
  if (filter?.status) {
    clauses.push("status = @status");
    params.status = filter.status;
  }
  if (filter?.currency) {
    clauses.push("(buy_currency = @currency OR sell_currency = @currency)");
    params.currency = filter.currency;
  }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  return db
    .prepare(`SELECT * FROM conversion_pairs ${where} ORDER BY created_at`)
    .all(params) as ConversionPair[];
}

export function findConversionPair(airwallexId: string): ConversionPair | undefined {
  return db
    .prepare(`SELECT * FROM conversion_pairs WHERE buy_id = @id OR sell_id = @id`)
    .get({ id: airwallexId }) as ConversionPair | undefined;
}
