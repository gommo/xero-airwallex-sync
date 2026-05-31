import { createHash } from "node:crypto";
import type { PlannedPosting } from "./plan.js";

/** Stable hash of the fields we push to Xero. Used to detect "no change since last push". */
export function planHash(plan: PlannedPosting): string {
  const parts = [
    plan.contact_name,
    plan.description,
    plan.xero_account_code,
    plan.reference,
    plan.aud_amount.toFixed(2),
    plan.date,
    plan.kind,
  ];
  // Only fold tracking into the hash when present, so rows with no mapping-tracking
  // keep their pre-tracking hash and stay "in sync" (never re-pushed, never clobbered).
  const trackingStr = plan.tracking
    .map((t) => `${t.categoryId}:${t.optionId}`)
    .sort()
    .join(",");
  if (trackingStr) parts.push(`track=${trackingStr}`);
  const s = parts.join("|");
  return createHash("sha256").update(s).digest("hex").slice(0, 16);
}
