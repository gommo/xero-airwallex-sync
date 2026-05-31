import { db } from "../db/db.js";

export interface MerchantMapping {
  pattern: string;
  account_code: string;
  account_kind: "EXPENSE" | "REVENUE";
  tracking_1_id: string | null;
  tracking_1_option_id: string | null;
  tracking_2_id: string | null;
  tracking_2_option_id: string | null;
}

export interface MappingInput {
  pattern: string;
  code: string;
  kind?: "EXPENSE" | "REVENUE";
  tracking_1_id?: string | null;
  tracking_1_option_id?: string | null;
  tracking_2_id?: string | null;
  tracking_2_option_id?: string | null;
}

const upsert = db.prepare(`
  INSERT INTO merchant_mappings
    (pattern, account_code, account_kind,
     tracking_1_id, tracking_1_option_id, tracking_2_id, tracking_2_option_id)
  VALUES
    (@pattern, @code, @kind,
     @tracking_1_id, @tracking_1_option_id, @tracking_2_id, @tracking_2_option_id)
  ON CONFLICT(pattern) DO UPDATE SET
    account_code = excluded.account_code,
    account_kind = excluded.account_kind,
    tracking_1_id = excluded.tracking_1_id,
    tracking_1_option_id = excluded.tracking_1_option_id,
    tracking_2_id = excluded.tracking_2_id,
    tracking_2_option_id = excluded.tracking_2_option_id
`);

const remove = db.prepare(`DELETE FROM merchant_mappings WHERE pattern = ?`);

const listAll = db.prepare(`
  SELECT pattern, account_code, account_kind,
         tracking_1_id, tracking_1_option_id, tracking_2_id, tracking_2_option_id
  FROM merchant_mappings ORDER BY pattern
`);

export function addMapping(input: MappingInput): void {
  upsert.run({
    pattern: input.pattern.toUpperCase(),
    code: input.code,
    kind: input.kind ?? "EXPENSE",
    tracking_1_id: input.tracking_1_id ?? null,
    tracking_1_option_id: input.tracking_1_option_id ?? null,
    tracking_2_id: input.tracking_2_id ?? null,
    tracking_2_option_id: input.tracking_2_option_id ?? null,
  });
}

export function removeMapping(pattern: string): number {
  return remove.run(pattern.toUpperCase()).changes;
}

export function listMappings(): MerchantMapping[] {
  return listAll.all() as MerchantMapping[];
}

/** Case-insensitive substring lookup of mappings against a merchant string. */
export function resolveMapping(merchant: string | null | undefined): MerchantMapping | null {
  if (!merchant) return null;
  const upper = merchant.toUpperCase();
  const all = listMappings();
  // longest pattern wins, so "RENDER.COM" beats "RENDER" if both exist
  const matches = all.filter((m) => upper.includes(m.pattern));
  matches.sort((a, b) => b.pattern.length - a.pattern.length);
  return matches[0] ?? null;
}
