import { db } from "../db/db.js";
import { log } from "../log.js";
import { getRate } from "../fx/rates.js";
import { listConversionPairs } from "./conversions.js";
import { resolveMapping } from "./mappings.js";
import { config } from "../config.js";

export interface PlannedPosting {
  kind: "SPEND" | "RECEIVE";
  source: "airwallex" | "stripe";
  /** The external transaction id from the source (Airwallex financial txn id, or
   *  Stripe balance-transaction id). Dedupe key, paired with `source`. */
  source_id: string;
  currency: string;
  ccy_amount: number;
  aud_amount: number;
  fx_rate: number;
  fx_source: "airwallex_client_rate" | "frankfurter.app" | "stripe";
  fx_date: string;
  date: string;
  xero_account_id: string;
  xero_account_code: string;
  tracking: Array<{ categoryId: string; optionId: string }>;
  contact_name: string;
  description: string;
  reference: string;
  notes?: string;
  /** Xero TaxType for the line. Defaults to EXEMPTEXPENSES (Airwallex spend) when unset. */
  tax_type?: string;
}

function merchantFromDescription(desc: string | null): string | null {
  if (!desc) return null;
  // Airwallex format is "MERCHANT, LOCATION, COUNTRY"; the first comma-segment is the merchant.
  const first = desc.split(",")[0]?.trim();
  return first || null;
}

interface AwxRow {
  id: string;
  currency: string;
  status: string;
  transaction_type: string;
  amount: number;
  fee: number;
  net: number;
  settled_at: string | null;
  created_at: string;
  description: string | null;
  source_id: string | null;
  merchant_description: string | null;
}

interface WalletRow {
  currency: string;
  xero_account_id: string | null;
}

function aetDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-CA", { timeZone: "Australia/Sydney" });
}

function dateOf(row: AwxRow): string {
  return aetDate(row.settled_at ?? row.created_at);
}

function loadWallets(): Map<string, string> {
  const rows = db.prepare("SELECT currency, xero_account_id FROM wallets").all() as WalletRow[];
  return new Map(rows.filter((r) => r.xero_account_id).map((r) => [r.currency, r.xero_account_id!]));
}

export async function planPostings(): Promise<PlannedPosting[]> {
  const wallets = loadWallets();
  const conversionLegIds = new Set(
    (
      db.prepare(`SELECT id FROM airwallex_transactions WHERE transaction_type LIKE 'CONVERSION_%'`).all() as Array<{ id: string }>
    ).map((r) => r.id),
  );

  const plans: PlannedPosting[] = [];

  // 1) Non-conversion, non-AUD settled txns: ISSUING_CAPTURE, DEPOSIT.
  //    LEFT JOIN balance_history to enrich with merchant description (the
  //    financial_transactions endpoint omits it).
  const txns = db
    .prepare(
      `SELECT t.*, MAX(bh.description) AS merchant_description
       FROM airwallex_transactions t
       LEFT JOIN airwallex_balance_history bh ON bh.financial_txn_id = t.id
       WHERE t.status = 'SETTLED' AND t.currency != 'AUD'
       GROUP BY t.id
       ORDER BY t.created_at`,
    )
    .all() as AwxRow[];

  for (const t of txns) {
    if (conversionLegIds.has(t.id)) continue; // handled separately
    const accountId = wallets.get(t.currency);
    if (!accountId) {
      log.warn({ currency: t.currency, id: t.id }, "no Xero wallet account for currency, skipping");
      continue;
    }
    const fxDate = dateOf(t);
    const ccyPerAud = await getRate(fxDate, "AUD", t.currency);
    const audAmount = t.amount / ccyPerAud;

    const fullDesc = t.merchant_description ?? t.description;
    const merchant = merchantFromDescription(fullDesc);
    const audRounded = Number(audAmount.toFixed(2));
    const reference = `${t.currency} ${Math.abs(t.amount).toFixed(2)} → AUD ${Math.abs(audRounded).toFixed(2)} @ ${ccyPerAud.toFixed(5)}`;
    const kind = t.amount < 0 ? "SPEND" : "RECEIVE";
    const mapping = resolveMapping(fullDesc) ?? resolveMapping(merchant);
    const defaultCode = kind === "SPEND" ? config.XERO_EXPENSE_CODE : config.XERO_REVENUE_CODE;
    const accountCode = mapping?.account_code ?? defaultCode ?? "";
    const tracking: Array<{ categoryId: string; optionId: string }> = [];
    if (mapping?.tracking_1_id && mapping.tracking_1_option_id) {
      tracking.push({ categoryId: mapping.tracking_1_id, optionId: mapping.tracking_1_option_id });
    }
    if (mapping?.tracking_2_id && mapping.tracking_2_option_id) {
      tracking.push({ categoryId: mapping.tracking_2_id, optionId: mapping.tracking_2_option_id });
    }
    plans.push({
      kind,
      source: "airwallex",
      source_id: t.id,
      currency: t.currency,
      ccy_amount: t.amount,
      aud_amount: audRounded,
      fx_rate: ccyPerAud,
      fx_source: "frankfurter.app",
      fx_date: fxDate,
      date: dateOf(t),
      xero_account_id: accountId,
      xero_account_code: accountCode,
      tracking,
      contact_name: merchant ?? "Airwallex",
      description: fullDesc ?? `Airwallex ${t.currency} card purchase`,
      reference,
      notes: mapping ? `${t.transaction_type} (mapped: ${mapping.pattern}→${mapping.account_code})` : t.transaction_type,
    });
  }

  // 2) Conversion pairs are intentionally NOT posted. The existing AUD feed
  //    already creates the AUD-side debit line; reconcile each one in Xero as
  //    a Transfer to the destination wallet account, and Xero will auto-create
  //    the matching credit on the non-AUD side.
  const pairs = listConversionPairs({ status: "SETTLED" });
  for (const p of pairs) {
    log.info(
      {
        when: p.created_at,
        pair: p.currency_pair,
        rate: p.client_rate,
        aud_leg: `${p.sell_amount} ${p.sell_currency}`,
        ccy_leg: `${p.buy_amount} ${p.buy_currency}`,
      },
      "[manual] FX conversion — reconcile as Transfer in Xero on the AUD account",
    );
  }

  return plans.sort((a, b) => a.date.localeCompare(b.date));
}
