import { db } from "../db/db.js";
import { config } from "../config.js";
import { log } from "../log.js";
import type { PlannedPosting } from "./plan.js";
import { getRate } from "../fx/rates.js";
import { matchStripePayouts, stripeMajor } from "./stripe-payouts.js";

/**
 * Stripe planner. Xero has no multicurrency here, so EVERYTHING posted is AUD.
 * Stripe keeps a separate balance per settlement currency (AUD, USD, NZD, ...):
 *   - AUD-settled rows: the balance_transaction amounts are already AUD.
 *   - Non-AUD rows: amounts are in that currency and are converted to AUD at the
 *     ECB daily rate for the transaction date (same as the Airwallex planner).
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
 *   transfer      -> Connect clearing liability
 *   connect_reserved_funds -> reserve asset
 *   currency_conversion -> foreign -> AUD inside Stripe: only the cost is posted
 *                    (conversion fee + rate difference); the money stays in the account
 *   payout (non-AUD) -> bank TRANSFER to the Airwallex wallet of that currency,
 *                    once the matching Airwallex deposit has arrived
 * Not posted: AUD payouts (reconciled by hand as a Transfer to the real bank).
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
  description: string | null;
  created: string;
}

function aetDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-CA", { timeZone: "Australia/Sydney" });
}

export async function planStripePostings(): Promise<PlannedPosting[]> {
  const BANK = config.STRIPE_BANK_ACCOUNT_ID ?? "";
  const SUBS = config.STRIPE_CODE_SUBSCRIPTIONS ?? "";
  const SPON = config.STRIPE_CODE_SPONSORSHIP ?? "";
  const TICK = config.STRIPE_CODE_TICKETING ?? "";
  const FEES = config.STRIPE_CODE_FEES ?? "";
  const CLEARING = config.STRIPE_CODE_CLEARING ?? "";
  const RESERVE = config.STRIPE_CODE_RESERVE ?? "";
  const FX = config.STRIPE_CODE_FX ?? FEES;
  const SPON_PROD = config.STRIPE_SPONSORSHIP_PRODUCT_ID ?? "";
  const tracking =
    config.STRIPE_TRACKING_CATEGORY_ID && config.STRIPE_TRACKING_OPTION_ID
      ? [{ categoryId: config.STRIPE_TRACKING_CATEGORY_ID, optionId: config.STRIPE_TRACKING_OPTION_ID }]
      : [];

  const rows = db
    .prepare(
      `SELECT id, reporting_category, type, currency, amount, fee, net, exchange_rate,
              presentment_currency, presentment_amount, product_id, product_name, description, created
       FROM stripe_balance_transactions
       ORDER BY created`,
    )
    .all() as StripeRow[];

  const plans: PlannedPosting[] = [];
  const skipped: Record<string, number> = {};

  // Non-AUD payouts paired with the Airwallex deposit they turned into.
  const payouts = matchStripePayouts();
  const payoutByTxn = new Map(payouts.matched.map((m) => [m.balance_txn_id, m]));
  const pendingPayouts = new Set(payouts.pending.map((p) => p.balance_txn_id));
  const wallets = new Map(
    (db.prepare("SELECT currency, xero_account_id FROM wallets").all() as Array<{ currency: string; xero_account_id: string | null }>)
      .filter((w) => w.xero_account_id)
      .map((w) => [w.currency, w.xero_account_id!]),
  );

  // The AUD leg of each "foreign -> AUD" conversion, keyed by timestamp + description
  // (Stripe writes the two legs as separate balance transactions).
  const audConversionLegs = new Map<string, StripeRow>();
  for (const r of rows) {
    if (r.reporting_category === "currency_conversion" && r.currency.toLowerCase() === "aud") {
      audConversionLegs.set(`${r.created}|${r.description ?? ""}`, r);
    }
  }

  for (const r of rows) {
    const date = aetDate(r.created);
    const ccy = r.currency.toUpperCase(); // the Stripe balance this row sits in
    const isAud = ccy === "AUD";
    const ccyPerAud = isAud ? 1 : await getRate(date, "AUD", ccy);
    /** Stripe minor units (this row's currency) -> absolute major units. */
    const major = (minor: number): number => Math.abs(stripeMajor(minor, ccy));
    /** Stripe minor units (this row's currency) -> absolute AUD. */
    const aud = (minor: number): number => (isAud ? major(minor) : Number((major(minor) / ccyPerAud).toFixed(2)));
    /** "AUD 12.34", or "USD 7.00 → AUD 10.19 @ 0.68708" for a foreign balance. */
    const amt = (minor: number): string =>
      isAud
        ? `AUD ${major(minor).toFixed(2)}`
        : `${ccy} ${major(minor).toFixed(2)} → AUD ${aud(minor).toFixed(2)} @ ${ccyPerAud.toFixed(5)}`;

    const presentmentCcy = (r.presentment_currency ?? r.currency).toUpperCase();
    const presentment = stripeMajor(r.presentment_amount ?? r.amount, presentmentCcy);
    // Revenue GST follows the currency the customer was billed in: AUD sales are
    // taxable (GST on Income), anything billed in a foreign currency is an export
    // (GST Free Exports). Refunds are contra-revenue, so they follow the same rule.
    const revenueTax = presentmentCcy === "AUD" ? "OUTPUT" : "EXEMPTEXPORT";

    const base = {
      source: "stripe" as const,
      // AUD balance: Stripe's own presentment -> AUD rate. Foreign balance: ECB daily rate.
      fx_rate: isAud ? (r.exchange_rate ?? 1) : ccyPerAud,
      fx_source: isAud ? ("stripe" as const) : ("frankfurter.app" as const),
      fx_date: date,
      date,
      xero_account_id: BANK,
      tracking,
      // Default for balance-sheet movements (transfers, reserve): BAS Excluded,
      // makes no GST claim. Income/fee lines override this below (revenueTax / INPUT).
      tax_type: "BASEXCLUDED",
    };

    /** Currency + amounts for a line valued from this row's own balance currency. */
    const money = (minor: number) => ({ currency: ccy, ccy_amount: major(minor), aud_amount: aud(minor) });

    const incomeLine = (code: string, label: string): PlannedPosting => ({
      ...base,
      tax_type: revenueTax,
      kind: "RECEIVE",
      source_id: r.id,
      currency: isAud ? presentmentCcy : ccy,
      ccy_amount: isAud ? presentment : major(r.amount),
      aud_amount: aud(r.amount), // GROSS in AUD
      xero_account_code: code,
      contact_name: r.product_name ?? label,
      description: r.product_name ?? label,
      reference: !isAud
        ? `Stripe ${label} ${amt(r.amount)}`
        : presentmentCcy === "AUD"
          ? `Stripe ${label} AUD ${(Math.abs(r.amount) / 100).toFixed(2)}`
          : `Stripe ${label} ${presentmentCcy} ${Math.abs(presentment).toFixed(2)} → AUD ${(Math.abs(r.amount) / 100).toFixed(2)} @ ${(r.exchange_rate ?? 1).toFixed(5)}`,
      notes: `${r.reporting_category} gross`,
    });

    const feeLine = (): PlannedPosting => ({
      ...base,
      ...money(r.fee),
      tax_type: "INPUT", // Stripe charges AU GST on its fees -> GST on Expenses
      kind: "SPEND",
      source_id: `${r.id}:fee`,
      xero_account_code: FEES,
      contact_name: "Stripe",
      description: `Stripe fee on ${r.product_name ?? r.reporting_category}`,
      reference: `Stripe processing fee ${amt(r.fee)}`,
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
          ...money(r.net),
          xero_account_code: FEES,
          contact_name: "Stripe",
          description: "Stripe fee",
          reference: `Stripe fee ${amt(r.net)}`,
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
          currency: isAud ? presentmentCcy : ccy,
          ccy_amount: isAud ? Math.abs(presentment) : major(r.net),
          aud_amount: aud(r.net),
          xero_account_code: SUBS,
          contact_name: r.product_name ?? "Refund",
          description: `Refund: ${r.product_name ?? "Stripe"}`,
          reference: `Stripe refund ${amt(r.net)}`,
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
          ...money(r.net),
          xero_account_code: CLEARING,
          contact_name: "Connected account",
          description: "Transfer to connected account",
          reference: `Stripe Connect transfer ${amt(r.net)}`,
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
          ...money(r.net),
          xero_account_code: RESERVE,
          contact_name: "Stripe",
          description: r.net < 0 ? "Connect reserve held" : "Connect reserve released",
          reference: `Stripe Connect reserve ${amt(r.net)}`,
          notes: `${r.reporting_category} (reserve asset)`,
        });
        break;
      }
      case "currency_conversion": {
        // Stripe converting a foreign balance to AUD. Both balances live in the one
        // AUD-valued Xero account, so the money does not move; only the cost of the
        // conversion is posted, off the foreign leg: Stripe's conversion fee, plus the
        // gap between the AUD actually received and the ECB value of what was sold.
        if (isAud) break; // AUD leg: accounted for via the foreign leg below
        const audLeg = audConversionLegs.get(`${r.created}|${r.description ?? ""}`);
        if (!audLeg || r.amount >= 0) {
          skipped["currency_conversion (not foreign -> AUD)"] = (skipped["currency_conversion (not foreign -> AUD)"] ?? 0) + 1;
          break;
        }
        const audReceived = Math.abs(audLeg.amount) / 100;
        if (r.fee > 0) {
          plans.push({
            ...base,
            ...money(r.fee),
            tax_type: "INPUT",
            kind: "SPEND",
            source_id: `${r.id}:fee`,
            xero_account_code: FEES,
            contact_name: "Stripe",
            description: `Stripe currency conversion fee (${ccy} to AUD)`,
            reference: `Stripe conversion fee ${amt(r.fee)}`,
            notes: `${r.reporting_category} fee`,
          });
        }
        const diff = Number((audReceived - aud(r.amount)).toFixed(2));
        if (Math.abs(diff) >= 0.01) {
          plans.push({
            ...base,
            kind: diff < 0 ? "SPEND" : "RECEIVE",
            source_id: r.id,
            currency: "AUD",
            ccy_amount: Math.abs(diff),
            aud_amount: Math.abs(diff),
            xero_account_code: FX,
            contact_name: "Stripe",
            description: `Stripe currency conversion ${ccy} to AUD: rate difference`,
            reference: `Stripe conversion ${ccy} ${major(r.amount).toFixed(2)} → AUD ${audReceived.toFixed(2)} (ECB value AUD ${aud(r.amount).toFixed(2)})`,
            notes: `${r.reporting_category} (rate difference)`,
          });
        }
        break;
      }
      case "payout": {
        // AUD payouts go to the real bank and are reconciled by hand as a Transfer.
        // Non-AUD payouts land in the Airwallex wallet of the same currency: post one
        // bank transfer, valued in AUD at the rate on the day the deposit arrived.
        const match = payoutByTxn.get(r.id);
        if (!match) {
          const why = isAud ? "payout (AUD, reconcile by hand)" : pendingPayouts.has(r.id) ? "payout (awaiting Airwallex deposit)" : "payout (unmatched)";
          skipped[why] = (skipped[why] ?? 0) + 1;
          break;
        }
        const toAccount = wallets.get(ccy);
        if (!toAccount) {
          log.warn({ currency: ccy, payout: match.payout_id }, "no Xero wallet account for payout currency, skipping");
          break;
        }
        const arrived = aetDate(match.deposit_at);
        const rate = await getRate(arrived, "AUD", ccy);
        const audValue = Number((match.amount / rate).toFixed(2));
        plans.push({
          ...base,
          kind: "TRANSFER",
          source_id: r.id,
          linked_source_ids: [match.deposit_id],
          currency: ccy,
          ccy_amount: match.amount,
          aud_amount: audValue,
          fx_rate: rate,
          fx_source: "frankfurter.app",
          fx_date: arrived,
          date: arrived,
          to_account_id: toAccount,
          xero_account_code: "",
          contact_name: "Stripe",
          description: `Stripe payout to Airwallex ${ccy} wallet`,
          reference: `Stripe payout ${ccy} ${match.amount.toFixed(2)} → AUD ${audValue.toFixed(2)} @ ${rate.toFixed(5)}`,
          notes: `${r.reporting_category} (transfer to Airwallex ${ccy})`,
        });
        break;
      }
      default:
        skipped[r.reporting_category ?? "unknown"] = (skipped[r.reporting_category ?? "unknown"] ?? 0) + 1;
    }
  }

  for (const [cat, n] of Object.entries(skipped)) {
    log.info({ category: cat, count: n }, "stripe planner: not posted");
  }
  return plans;
}
