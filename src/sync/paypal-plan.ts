import { db } from "../db/db.js";
import { config } from "../config.js";
import { log } from "../log.js";
import { getRate } from "../fx/rates.js";
import type { PlannedPosting } from "./plan.js";

/**
 * PayPal planner. The Xero account "Paypal USD (Manual)" is AUD-denominated
 * with no feed, so Patreon creator payouts (USD credits from Patreon Inc) are
 * posted as RECEIVE lines converted at the ECB daily rate, the same way the
 * Airwallex planner handles non-AUD wallets. PayPal applies its own rate when
 * the balance is later swept to AUD; that difference lands in the account as a
 * small residual and is cleared with the sweep transfer.
 *
 *   Patreon credit (USD, status S) -> PAYPAL_PATREON_CODE (212), EXEMPTEXPORT,
 *                                     tracking PAYPAL_TRACKING_* (Project: OldWorldFanatics)
 *   Currency conversions, withdrawals to bank, other credits -> NOT posted; logged
 *   as manual hints (reconcile as Transfer in Xero, or add a mapping later).
 *
 * PAYPAL_POST_FROM is a date floor: anything earlier was keyed by hand before
 * this sync existed and must not be posted again.
 */

interface Row {
  id: string;
  event_code: string | null;
  status: string | null;
  currency: string;
  amount: number;
  fee: number;
  initiated_at: string;
  payer_email: string | null;
  payer_name: string | null;
}

function aetDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-CA", { timeZone: "Australia/Sydney" });
}

const isPatreon = (r: Row) => /patreon/i.test(`${r.payer_name ?? ""} ${r.payer_email ?? ""}`);

export async function planPaypalPostings(): Promise<PlannedPosting[]> {
  const BANK = config.PAYPAL_BANK_ACCOUNT_ID ?? "";
  const CODE = config.PAYPAL_PATREON_CODE ?? "";
  const floor = config.PAYPAL_POST_FROM ?? "1970-01-01";
  const tracking =
    config.PAYPAL_TRACKING_CATEGORY_ID && config.PAYPAL_TRACKING_OPTION_ID
      ? [{ categoryId: config.PAYPAL_TRACKING_CATEGORY_ID, optionId: config.PAYPAL_TRACKING_OPTION_ID }]
      : [];
  if (!BANK || !CODE) {
    log.warn("PAYPAL_BANK_ACCOUNT_ID / PAYPAL_PATREON_CODE not set; paypal planner has nothing to target");
    return [];
  }

  const rows = db
    .prepare(
      `SELECT id, event_code, status, currency, amount, fee, initiated_at, payer_email, payer_name
       FROM paypal_transactions ORDER BY initiated_at`,
    )
    .all() as Row[];

  const plans: PlannedPosting[] = [];
  const skipped: Record<string, number> = {};
  for (const r of rows) {
    const date = aetDate(r.initiated_at);
    if (date < floor) continue; // hand-keyed era
    if (r.status !== "S") { skipped[`status ${r.status}`] = (skipped[`status ${r.status}`] ?? 0) + 1; continue; }
    const code = r.event_code ?? "";
    // T02xx currency conversion, T03xx/T04xx bank deposits & withdrawals: balance-sheet moves.
    if (/^T0[234]/.test(code)) {
      log.info({ date, code, amount: r.amount, currency: r.currency, id: r.id }, "[manual] PayPal balance move: reconcile as Transfer in Xero");
      continue;
    }
    if (r.amount <= 0 || !isPatreon(r)) {
      const k = `${code || "?"} ${r.payer_name ?? r.payer_email ?? "unknown"}`;
      skipped[k] = (skipped[k] ?? 0) + 1;
      continue;
    }
    const ccyPerAud = r.currency === "AUD" ? 1 : await getRate(date, "AUD", r.currency);
    const aud = Number((r.amount / ccyPerAud).toFixed(2));
    plans.push({
      kind: "RECEIVE",
      source: "paypal",
      source_id: r.id,
      currency: r.currency,
      ccy_amount: r.amount,
      aud_amount: aud,
      fx_rate: ccyPerAud,
      fx_source: "frankfurter.app",
      fx_date: date,
      date,
      xero_account_id: BANK,
      xero_account_code: CODE,
      tracking,
      tax_type: "EXEMPTEXPORT",
      contact_name: "Patreon",
      description: `Patreon creator payout, Old World Fanatics. ${r.currency} ${r.amount.toFixed(2)} → AUD ${aud.toFixed(2)} @ ${ccyPerAud.toFixed(5)} (ECB daily rate; PayPal converts at sweep)`,
      reference: `Patreon payout ${date} ${r.currency} ${r.amount.toFixed(2)}`,
      notes: `${code} patreon`,
    });
  }
  for (const [k, n] of Object.entries(skipped)) log.info({ what: k, count: n }, "paypal planner: not posted");
  return plans;
}
