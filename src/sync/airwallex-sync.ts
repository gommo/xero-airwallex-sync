import {
  airwallexGet,
  type FinancialTransaction,
  type FinancialTransactionsResponse,
} from "../airwallex/client.js";
import { db } from "../db/db.js";
import { log } from "../log.js";

const PAGE_SIZE = 200;

interface BalanceHistoryItem {
  id: string;
  source?: string;
  posted_at?: string;
  currency: string;
  amount?: number;
  balance?: number;
  description?: string | null;
  source_type?: string;
  transaction_type?: string;
  account_type?: string;
}

interface BalanceHistoryResponse {
  has_more?: boolean;
  items?: BalanceHistoryItem[];
}

const upsertBh = db.prepare(`
  INSERT INTO airwallex_balance_history
    (id, financial_txn_id, posted_at, currency, amount, balance, description,
     source_type, transaction_type, account_type, raw_json)
  VALUES
    (@id, @financial_txn_id, @posted_at, @currency, @amount, @balance, @description,
     @source_type, @transaction_type, @account_type, @raw_json)
  ON CONFLICT(id) DO UPDATE SET
    description = excluded.description,
    raw_json = excluded.raw_json,
    fetched_at = datetime('now')
`);


const upsertTxn = db.prepare(`
  INSERT INTO airwallex_transactions
    (id, currency, status, source_type, transaction_type, amount, fee, net,
     created_at, settled_at, estimated_settled_at, description,
     source_id, funding_source_id, batch_id, currency_pair, client_rate, raw_json)
  VALUES
    (@id, @currency, @status, @source_type, @transaction_type, @amount, @fee, @net,
     @created_at, @settled_at, @estimated_settled_at, @description,
     @source_id, @funding_source_id, @batch_id, @currency_pair, @client_rate, @raw_json)
  ON CONFLICT(id) DO UPDATE SET
    status = excluded.status,
    settled_at = excluded.settled_at,
    estimated_settled_at = excluded.estimated_settled_at,
    raw_json = excluded.raw_json,
    fetched_at = datetime('now')
`);

const upsertCursor = db.prepare(`
  INSERT INTO sync_cursors (source, currency, last_synced_at)
  VALUES (@source, @currency, @last_synced_at)
  ON CONFLICT(source, currency) DO UPDATE SET last_synced_at = excluded.last_synced_at
`);

function persist(item: FinancialTransaction) {
  upsertTxn.run({
    id: item.id,
    currency: item.currency,
    status: item.status,
    source_type: item.source_type ?? null,
    transaction_type: item.transaction_type ?? null,
    amount: item.amount,
    fee: item.fee,
    net: item.net,
    created_at: item.created_at,
    settled_at: item.settled_at,
    estimated_settled_at: item.estimated_settled_at,
    description: item.description,
    source_id: item.source_id,
    funding_source_id: item.funding_source_id,
    batch_id: item.batch_id,
    currency_pair: item.currency_pair,
    client_rate: item.client_rate,
    raw_json: JSON.stringify(item),
  });
}

export interface SyncOptions {
  currencies?: string[];
  from: Date;
  to: Date;
}

export async function syncAirwallex(opts: SyncOptions) {
  const currencies = opts.currencies && opts.currencies.length > 0 ? opts.currencies : [undefined];
  for (const currency of currencies) {
    const total = await fetchAll(currency, opts.from, opts.to);
    upsertCursor.run({
      source: "airwallex",
      currency: currency ?? "*",
      last_synced_at: opts.to.toISOString(),
    });
    log.info({ currency: currency ?? "(all)", total }, "currency sync complete");
  }
  const bhTotal = await fetchBalanceHistory();
  log.info({ total: bhTotal }, "balance history sync complete");
  const enriched = enrichDescriptionsFromBalanceHistory();
  if (enriched > 0) log.info({ enriched }, "merchant descriptions backfilled from balance_history");
}

function enrichDescriptionsFromBalanceHistory(): number {
  // balance_history retains merchant descriptions; match by (currency, |amount|, ±1h).
  // financial_txn_id in balance_history points at the release-leg, so we can't use it directly.
  // SQLite's strftime doesn't parse Airwallex's "+0800" (no colon) form, so we do this in JS.
  const candidates = db
    .prepare(
      `SELECT id, transaction_type, currency, amount, COALESCE(settled_at, created_at) AS ts
       FROM airwallex_transactions
       WHERE description IS NULL OR description = ''`,
    )
    .all() as Array<{ id: string; transaction_type: string; currency: string; amount: number; ts: string }>;

  if (candidates.length === 0) return 0;

  const bh = db
    .prepare(
      `SELECT transaction_type, currency, amount, posted_at, description
       FROM airwallex_balance_history
       WHERE description IS NOT NULL AND description != ''`,
    )
    .all() as Array<{ transaction_type: string; currency: string; amount: number; posted_at: string; description: string }>;

  const update = db.prepare(`UPDATE airwallex_transactions SET description = @desc WHERE id = @id`);
  let changes = 0;
  const TOL_MS = 60 * 60 * 1000;
  db.transaction(() => {
    for (const c of candidates) {
      const cTs = Date.parse(c.ts);
      if (Number.isNaN(cTs)) continue;
      const match = bh.find(
        (b) =>
          b.transaction_type === c.transaction_type &&
          b.currency === c.currency &&
          Math.abs(b.amount) === Math.abs(c.amount) &&
          Math.abs(Date.parse(b.posted_at) - cTs) < TOL_MS,
      );
      if (match) {
        update.run({ desc: match.description, id: c.id });
        changes += 1;
      }
    }
  })();
  return changes;
}

async function fetchBalanceHistory(): Promise<number> {
  let pageNum = 0;
  let total = 0;
  while (true) {
    const page = await airwallexGet<BalanceHistoryResponse>("/api/v1/balances/history", {
      page_num: pageNum,
      page_size: PAGE_SIZE,
    });
    const items = page.items ?? [];
    db.transaction(() => {
      for (const item of items) {
        upsertBh.run({
          id: item.id,
          financial_txn_id: item.source ?? null,
          posted_at: item.posted_at ?? null,
          currency: item.currency,
          amount: item.amount ?? null,
          balance: item.balance ?? null,
          description: item.description ?? null,
          source_type: item.source_type ?? null,
          transaction_type: item.transaction_type ?? null,
          account_type: item.account_type ?? null,
          raw_json: JSON.stringify(item),
        });
      }
    })();
    total += items.length;
    if (!page.has_more || items.length === 0) break;
    pageNum += 1;
  }
  return total;
}

async function fetchAll(currency: string | undefined, from: Date, to: Date): Promise<number> {
  log.info({ currency: currency ?? "(all)", from: from.toISOString(), to: to.toISOString() }, "fetching");
  let pageNum = 0;
  let total = 0;
  while (true) {
    const page = await airwallexGet<FinancialTransactionsResponse>("/api/v1/financial_transactions", {
      currency,
      from_created_at: from.toISOString(),
      to_created_at: to.toISOString(),
      page_num: pageNum,
      page_size: PAGE_SIZE,
    });
    const items = page.items ?? [];
    db.transaction(() => {
      for (const item of items) persist(item);
    })();
    total += items.length;
    if (!page.has_more || items.length === 0) break;
    pageNum += 1;
  }
  return total;
}
