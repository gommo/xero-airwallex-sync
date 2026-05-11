import { db } from "../db/db.js";

export interface MerchantMapping {
  pattern: string;
  account_code: string;
  account_kind: "EXPENSE" | "REVENUE";
}

const upsert = db.prepare(`
  INSERT INTO merchant_mappings (pattern, account_code, account_kind)
  VALUES (@pattern, @code, @kind)
  ON CONFLICT(pattern) DO UPDATE SET
    account_code = excluded.account_code,
    account_kind = excluded.account_kind
`);

const remove = db.prepare(`DELETE FROM merchant_mappings WHERE pattern = ?`);

const listAll = db.prepare(`SELECT pattern, account_code, account_kind FROM merchant_mappings ORDER BY pattern`);

export function addMapping(pattern: string, code: string, kind: "EXPENSE" | "REVENUE" = "EXPENSE"): void {
  upsert.run({ pattern: pattern.toUpperCase(), code, kind });
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
