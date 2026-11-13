import { db } from "../db/db.js";

/**
 * Non-AUD Stripe payouts land in the matching Airwallex currency wallet (USD
 * payout -> USD wallet, no conversion). The same money therefore shows up twice
 * in the local cache: as a Stripe payout and as an Airwallex DEPOSIT. This pairs
 * them so the movement is posted to Xero ONCE, as a bank transfer between the
 * Stripe account and the Airwallex wallet account, and never as income.
 *
 * Match rule: same currency, same amount, deposit description mentions Stripe
 * (Airwallex shows the payout's statement descriptor), and the deposit was
 * created between one day before the payout and ten days after its arrival date.
 * Each deposit is used at most once; the earliest payout takes the earliest deposit.
 */

export interface PayoutMatch {
  payout_id: string; // po_…
  balance_txn_id: string; // txn_… (the payout's Stripe balance transaction)
  currency: string; // upper case
  amount: number; // major units
  deposit_id: string; // Airwallex financial transaction id
  deposit_at: string; // ISO, when the deposit hit the wallet
}

export interface PendingPayout {
  payout_id: string;
  balance_txn_id: string;
  currency: string;
  amount: number;
  created: string;
}

interface PayoutRow {
  id: string;
  amount: number;
  currency: string;
  created: string;
  arrival_date: string | null;
  balance_txn_id: string | null;
}

interface DepositRow {
  id: string;
  currency: string;
  amount: number;
  created_at: string;
  description: string | null;
}

// Stripe amounts are in the currency's minor unit; these currencies have none.
const ZERO_DECIMAL = new Set(["BIF", "CLP", "DJF", "GNF", "JPY", "KMF", "KRW", "MGA", "PYG", "RWF", "UGX", "VND", "VUV", "XAF", "XOF", "XPF"]);

/** Convert a Stripe minor-unit amount to major units for the given currency. */
export function stripeMajor(minor: number, currency: string): number {
  return ZERO_DECIMAL.has(currency.toUpperCase()) ? minor : minor / 100;
}

const DAY_MS = 86_400_000;

/** True when an Airwallex deposit looks like it came from Stripe. */
export function isStripeDeposit(description: string | null | undefined): boolean {
  return !!description && /stripe/i.test(description);
}

export function matchStripePayouts(): { matched: PayoutMatch[]; pending: PendingPayout[] } {
  const payouts = db
    .prepare(
      `SELECT p.id, p.amount, p.currency, p.created, p.arrival_date, b.id AS balance_txn_id
       FROM stripe_payouts p
       LEFT JOIN stripe_balance_transactions b ON b.source_id = p.id AND b.reporting_category = 'payout'
       WHERE LOWER(p.currency) != 'aud' AND COALESCE(p.status, '') NOT IN ('failed', 'canceled')
       ORDER BY p.created`,
    )
    .all() as PayoutRow[];

  const deposits = db
    .prepare(
      `SELECT t.id, t.currency, t.amount, t.created_at,
              COALESCE(t.description, '') || ' ' || COALESCE(MAX(bh.description), '') AS description
       FROM airwallex_transactions t
       LEFT JOIN airwallex_balance_history bh ON bh.financial_txn_id = t.id
       WHERE t.transaction_type = 'DEPOSIT' AND t.status = 'SETTLED' AND t.currency != 'AUD'
       GROUP BY t.id
       ORDER BY t.created_at`,
    )
    .all() as DepositRow[];

  const used = new Set<string>();
  const matched: PayoutMatch[] = [];
  const pending: PendingPayout[] = [];

  for (const p of payouts) {
    if (!p.balance_txn_id) continue; // balance transaction not synced yet; try again next run
    const currency = p.currency.toUpperCase();
    const amount = stripeMajor(p.amount, currency);
    const from = new Date(p.created).getTime() - DAY_MS;
    const to = new Date(p.arrival_date ?? p.created).getTime() + 10 * DAY_MS;

    const hit = deposits.find((d) => {
      if (used.has(d.id) || d.currency !== currency) return false;
      if (Math.abs(d.amount - amount) > 0.005) return false;
      if (!isStripeDeposit(d.description)) return false;
      const at = new Date(d.created_at).getTime();
      return at >= from && at <= to;
    });

    if (hit) {
      used.add(hit.id);
      matched.push({
        payout_id: p.id,
        balance_txn_id: p.balance_txn_id,
        currency,
        amount,
        deposit_id: hit.id,
        deposit_at: hit.created_at,
      });
    } else {
      pending.push({ payout_id: p.id, balance_txn_id: p.balance_txn_id, currency, amount, created: p.created });
    }
  }

  return { matched, pending };
}
