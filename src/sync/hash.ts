import { createHash } from "node:crypto";
import type { PlannedPosting } from "./plan.js";

/** Stable hash of the fields we push to Xero. Used to detect "no change since last push". */
export function planHash(plan: PlannedPosting): string {
  const s = [
    plan.contact_name,
    plan.description,
    plan.xero_account_code,
    plan.reference,
    plan.aud_amount.toFixed(2),
    plan.date,
    plan.kind,
  ].join("|");
  return createHash("sha256").update(s).digest("hex").slice(0, 16);
}
