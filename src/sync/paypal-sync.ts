import { searchTransactions, type TransactionDetail } from "../paypal/client.js";
import { db } from "../db/db.js";
import { log } from "../log.js";

const upsert = db.prepare(`
  INSERT INTO paypal_transactions
    (id, event_code, status, currency, amount, fee, initiated_at, updated_at,
     payer_email, payer_name, subject, note, ending_balance, raw_json)
  VALUES
    (@id, @event_code, @status, @currency, @amount, @fee, @initiated_at, @updated_at,
     @payer_email, @payer_name, @subject, @note, @ending_balance, @raw_json)
  ON CONFLICT(id) DO UPDATE SET
    status = excluded.status,
    updated_at = excluded.updated_at,
    ending_balance = excluded.ending_balance,
    raw_json = excluded.raw_json,
    fetched_at = datetime('now')
`);
const upsertCursor = db.prepare(`
  INSERT INTO sync_cursors (source, currency, last_synced_at)
  VALUES ('paypal', '*', @last_synced_at)
  ON CONFLICT(source, currency) DO UPDATE SET last_synced_at = excluded.last_synced_at
`);

export async function syncPaypal(opts: { from: Date; to: Date }): Promise<void> {
  log.info({ from: opts.from.toISOString(), to: opts.to.toISOString() }, "fetching paypal transactions");
  const batch: TransactionDetail[] = [];
  for await (const t of searchTransactions(opts.from, opts.to)) batch.push(t);
  db.transaction(() => {
    for (const t of batch) {
      const i = t.transaction_info;
      const p = t.payer_info;
      const name = p?.payer_name?.alternate_full_name ?? [p?.payer_name?.given_name, p?.payer_name?.surname].filter(Boolean).join(" ");
      upsert.run({
        id: i.transaction_id,
        event_code: i.transaction_event_code ?? null,
        status: i.transaction_status ?? null,
        currency: i.transaction_amount.currency_code,
        amount: Number(i.transaction_amount.value),
        fee: i.fee_amount ? Number(i.fee_amount.value) : 0,
        initiated_at: i.transaction_initiation_date,
        updated_at: i.transaction_updated_date ?? null,
        payer_email: p?.email_address ?? null,
        payer_name: name || null,
        subject: i.transaction_subject ?? null,
        note: i.transaction_note ?? null,
        ending_balance: i.ending_balance ? Number(i.ending_balance.value) : null,
        raw_json: JSON.stringify(t),
      });
    }
  })();
  upsertCursor.run({ last_synced_at: opts.to.toISOString() });
  log.info({ total: batch.length }, "paypal sync complete");
}
