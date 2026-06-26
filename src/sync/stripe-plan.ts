import { db } from "../db/db.js";
import { config } from "../config.js";
import { log } from "../log.js";
import type { PlannedPosting } from "./plan.js";

/**
 * Stripe planner. Stripe settles everything to AUD, so unlike the Airwallex
 * planner there is no per-currency wallet or external FX: the balance_transaction
 * amounts (minor units, AUD) are authoritative.
 *
 * Income is posted GROSS to the relevant revenue account, with the embedded
 * Stripe fee posted as a SEPARATE expense line (so fees are visible). Gross minus
 * fee = net, so the Stripe bank account still reconciles to payouts. The fee line
 * reuses the income txn's id with a ":fee" suffix as its dedupe key.
 *
 * Routing by reporting_category (+ product for charges):
 *   charge        -> Subscriptions, or Sponsorship if the sponsorship product
 *   platform_earning -> Tournament Fees
 *   fee           -> Stripe Fees (standalone Stripe/Connect fees)
 *   refund        -> contra to Subscriptions
 * Excluded (not posted; need a balance-sheet/clearing decision):
 *   transfer (organiser money), connect_reserved_funds (reserve), payout (bank Transfer).
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
  product_id: string | null;
  product_name: string | null;
  created: string;
}

function aetDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-CA", { timeZone: "Australia/Sydney" });
}

export function planStripePostings(): PlannedPosting[] {
  const BANK = config.STRIPE_BANK_ACCOUNT_ID ?? "";
  const SUBS = config.STRIPE_CODE_SUBSCRIPTIONS ?? "";
  const SPON = config.STRIPE_CODE_SPONSORSHIP ?? "";
  const TICK = config.STRIPE_CODE_TICKETING ?? "";
  const FEES = config.STRIPE_CODE_FEES ?? "";
  const CLEARING = config.STRIPE_CODE_CLEARING ?? "";
  const RESERVE = config.STRIPE_CODE_RESERVE ?? "";
  const SPON_PROD = config.STRIPE_SPONSORSHIP_PRODUCT_ID ?? "";
  const tracking =
    config.STRIPE_TRACKING_CATEGORY_ID && config.STRIPE_TRACKING_OPTION_ID
      ? [{ categoryId: config.STRIPE_TRACKING_CATEGORY_ID, optionId: config.STRIPE_TRACKING_OPTION_ID }]
      : [];

  const rows = db
    .prepare(
      `SELECT id, reporting_category, type, currency, amount, fee, net, exchange_rate,
              presentment_currency, presentment_amount, product_id, product_name, created
       FROM stripe_balance_transactions
       ORDER BY created`,
    )
    .all() as StripeRow[];

  const plans: PlannedPosting[] = [];
  const skipped: Record<string, number> = {};

  for (const r of rows) {
    const date = aetDate(r.created);
    const presentmentCcy = (r.presentment_currency ?? r.currency).toUpperCase();
    const presentment = (r.presentment_amount ?? r.amount) / 100;
    // Revenue GST follows the currency the customer was billed in: AUD sales are
    // taxable (GST on Income), anything billed in a foreign currency is an export
    // (GST Free Exports). Refunds are contra-revenue, so they follow the same rule.
    const revenueTax = presentmentCcy === "AUD" ? "OUTPUT" : "EXEMPTEXPORT";

    const base = {
      source: "stripe" as const,
      fx_rate: r.exchange_rate ?? 1,
      fx_source: "stripe" as const,
      fx_date: date,
      date,
      xero_account_id: BANK,
      tracking,
      // Default for balance-sheet movements (transfers, reserve): BAS Excluded,
      // makes no GST claim. Income/fee lines override this below (revenueTax / INPUT).
      tax_type: "BASEXCLUDED",
    };

    const incomeLine = (code: string, label: string): PlannedPosting => ({
      ...base,
      tax_type: revenueTax,
      kind: "RECEIVE",
      source_id: r.id,
      currency: presentmentCcy,
      ccy_amount: presentment,
      aud_amount: Math.abs(r.amount) / 100, // GROSS in AUD
      xero_account_code: code,
      contact_name: r.product_name ?? label,
      description: r.product_name ?? label,
      reference:
        presentmentCcy === "AUD"
          ? `Stripe ${label} AUD ${(Math.abs(r.amount) / 100).toFixed(2)}`
          : `Stripe ${label} ${presentmentCcy} ${Math.abs(presentment).toFixed(2)} → AUD ${(Math.abs(r.amount) / 100).toFixed(2)} @ ${(r.exchange_rate ?? 1).toFixed(5)}`,
      notes: `${r.reporting_category} gross`,
    });

    const feeLine = (): PlannedPosting => ({
      ...base,
      tax_type: "INPUT", // Stripe charges AU GST on its fees -> GST on Expenses
      kind: "SPEND",
      source_id: `${r.id}:fee`,
      currency: "AUD",
      ccy_amount: Math.abs(r.fee) / 100,
      aud_amount: Math.abs(r.fee) / 100,
      fx_rate: 1,
      xero_account_code: FEES,
      contact_name: "Stripe",
      description: `Stripe fee on ${r.product_name ?? r.reporting_category}`,
      reference: `Stripe processing fee AUD ${(Math.abs(r.fee) / 100).toFixed(2)}`,
      notes: `${r.reporting_category} fee`,
    });

    switch (r.reporting_category) {
      case "charge": {
        const code = r.product_id === SPON_PROD ? SPON : SUBS;
        const label = r.product_id === SPON_PROD ? "Sponsorship" : "Subscriptions/entries";
        plans.push(incomeLine(code, label));
        if (r.fee > 0) plans.push(feeLine());
        break;
      }
      case "platform_earning": {
        plans.push(incomeLine(TICK, "Tournament platform fee"));
        if (r.fee > 0) plans.push(feeLine());
        break;
      }
      case "fee": {
        // Standalone Stripe/Connect fee debit.
        plans.push({
          ...base,
          tax_type: "INPUT", // GST on Expenses
          kind: "SPEND",
          source_id: r.id,
          currency: "AUD",
          ccy_amount: Math.abs(r.net) / 100,
          aud_amount: Math.abs(r.net) / 100,
          fx_rate: 1,
          xero_account_code: FEES,
          contact_name: "Stripe",
          description: "Stripe fee",
          reference: `Stripe fee AUD ${(Math.abs(r.net) / 100).toFixed(2)}`,
          notes: `${r.reporting_category} (${r.type})`,
        });
        break;
      }
      case "refund": {
        plans.push({
          ...base,
          tax_type: revenueTax, // contra-revenue -> mirror the charge's GST treatment
          kind: "SPEND", // contra-revenue
          source_id: r.id,
          currency: presentmentCcy,
          ccy_amount: Math.abs(presentment),
          aud_amount: Math.abs(r.net) / 100,
          xero_account_code: SUBS,
          contact_name: r.product_name ?? "Refund",
          description: `Refund: ${r.product_name ?? "Stripe"}`,
          reference: `Stripe refund AUD ${(Math.abs(r.net) / 100).toFixed(2)}`,
          notes: `${r.reporting_category} (contra-revenue)`,
        });
        break;
      }
      case "transfer": {
        // Organiser money moving out to a connected account -> clearing liability.
        plans.push({
          ...base,
          kind: r.net < 0 ? "SPEND" : "RECEIVE",
          source_id: r.id,
          currency: "AUD",
          ccy_amount: Math.abs(r.net) / 100,
          aud_amount: Math.abs(r.net) / 100,
          fx_rate: 1,
          xero_account_code: CLEARING,
          contact_name: "Connected account",
          description: "Transfer to connected account",
          reference: `Stripe Connect transfer AUD ${(Math.abs(r.net) / 100).toFixed(2)}`,
          notes: `${r.reporting_category} (clearing liability)`,
        });
        break;
      }
      case "connect_reserved_funds": {
        // Rolling reserve held by Stripe -> reserve asset. Funding reduces the
        // bank balance (SPEND into the asset); release adds it back (RECEIVE).
        plans.push({
          ...base,
          kind: r.net < 0 ? "SPEND" : "RECEIVE",
          source_id: r.id,
          currency: "AUD",
          ccy_amount: Math.abs(r.net) / 100,
          aud_amount: Math.abs(r.net) / 100,
          fx_rate: 1,
          xero_account_code: RESERVE,
          contact_name: "Stripe",
          description: r.net < 0 ? "Connect reserve held" : "Connect reserve released",
          reference: `Stripe Connect reserve AUD ${(Math.abs(r.net) / 100).toFixed(2)}`,
          notes: `${r.reporting_category} (reserve asset)`,
        });
        break;
      }
      default:
        // payout: not posted - reconcile as a bank Transfer to the real bank.
        skipped[r.reporting_category ?? "unknown"] = (skipped[r.reporting_category ?? "unknown"] ?? 0) + 1;
    }
  }

  for (const [cat, n] of Object.entries(skipped)) {
    log.info({ category: cat, count: n }, "stripe planner: not posted (needs balance-sheet/clearing decision)");
  }
  return plans;
}
