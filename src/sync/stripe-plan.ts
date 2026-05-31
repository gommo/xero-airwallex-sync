import { db } from "../db/db.js";
import { config } from "../config.js";
import type { PlannedPosting } from "./plan.js";

/**
 * Stripe planner. Stripe settles everything to AUD, so unlike the Airwallex
 * planner there is no per-currency wallet or external FX: the balance_transaction
 * `net` (minor units, AUD) is authoritative. We post one BankTransaction per
 * balance transaction on the Stripe AUD bank account, keyed by reporting_category.
 *
 * Income is posted NET (gross minus the Stripe fee embedded in that txn) so the
 * Stripe bank account reconciles exactly to payouts. Whether to instead split
 * gross income + a separate fee expense is an accounting choice still to confirm.
 *
 * Excluded (not P&L): payouts (reconcile in Xero as a Transfer to the real bank)
 * and connect reserve movements (balance-sheet). Transfers to connected accounts
 * are organiser money passing through - flagged as clearing, not OWR P&L.
 */

interface StripeRow {
  id: string;
  reporting_category: string | null;
  type: string;
  currency: string;
  amount: number;
  fee: number;
  net: number;
  exchange_rate: number | null;
  presentment_currency: string | null;
  presentment_amount: number | null;
  product_name: string | null;
  created: string;
}

type Rule = {
  kind: "SPEND" | "RECEIVE";
  code: string | undefined;
  label: string;
  /** Money moving, not OWR income/expense - flagged in notes for review. */
  clearing?: boolean;
};

function ruleFor(cat: string | null): Rule | null {
  const REV = config.XERO_REVENUE_CODE;
  const EXP = config.XERO_EXPENSE_CODE;
  switch (cat) {
    case "charge":
      return { kind: "RECEIVE", code: REV, label: "Sales (subscriptions + entries)" };
    case "platform_earning":
      return { kind: "RECEIVE", code: REV, label: "Ticketing platform fee" };
    case "fee":
      return { kind: "SPEND", code: EXP, label: "Stripe fees" };
    case "refund":
      return { kind: "SPEND", code: REV, label: "Refund (contra-revenue)" };
    case "transfer":
      return { kind: "SPEND", code: EXP, label: "Transfer to connected account", clearing: true };
    // payout, connect_reserved_funds: intentionally not posted here.
    default:
      return null;
  }
}

function aetDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-CA", { timeZone: "Australia/Sydney" });
}

export function planStripePostings(): PlannedPosting[] {
  const rows = db
    .prepare(
      `SELECT id, reporting_category, type, currency, amount, fee, net, exchange_rate,
              presentment_currency, presentment_amount, product_name, created
       FROM stripe_balance_transactions
       ORDER BY created`,
    )
    .all() as StripeRow[];

  const plans: PlannedPosting[] = [];
  for (const r of rows) {
    const rule = ruleFor(r.reporting_category);
    if (!rule) continue; // payout / reserve / unknown - skip

    const aud = Math.abs(r.net) / 100;
    const presentmentCcy = (r.presentment_currency ?? r.currency).toUpperCase();
    const presentment = (r.presentment_amount ?? r.amount) / 100;
    const date = aetDate(r.created);
    const contact =
      r.reporting_category === "charge" && r.product_name
        ? r.product_name
        : rule.label;
    const reference =
      presentmentCcy === "AUD"
        ? `Stripe ${rule.label} AUD ${aud.toFixed(2)}`
        : `Stripe ${rule.label} ${presentmentCcy} ${Math.abs(presentment).toFixed(2)} → AUD ${aud.toFixed(2)} @ ${(r.exchange_rate ?? 1).toFixed(5)}`;

    plans.push({
      kind: rule.kind,
      source: "stripe",
      source_id: r.id,
      currency: presentmentCcy,
      ccy_amount: presentment,
      aud_amount: aud,
      fx_rate: r.exchange_rate ?? 1,
      fx_source: "stripe",
      fx_date: date,
      date,
      xero_account_id: "", // Stripe AUD bank account - to be configured before posting
      xero_account_code: rule.code ?? "",
      tracking: [], // category/product → tracking mapping is the next step
      contact_name: contact,
      description: r.product_name ?? rule.label,
      reference,
      notes: rule.clearing
        ? `${r.reporting_category} (CLEARING - not P&L)`
        : `${r.reporting_category} (${r.type})`,
    });
  }
  return plans;
}
