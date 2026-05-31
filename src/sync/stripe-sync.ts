import {
  stripeList,
  type BalanceTransaction,
  type ExpandedSource,
  type Payout,
} from "../stripe/client.js";
import { ProductResolver } from "../stripe/products.js";
import { db } from "../db/db.js";
import { log } from "../log.js";

const upsertBt = db.prepare(`
  INSERT INTO stripe_balance_transactions
    (id, type, reporting_category, currency, amount, fee, net, exchange_rate,
     source_id, source_type, presentment_currency, presentment_amount, description,
     product_id, product_name, created, raw_json)
  VALUES
    (@id, @type, @reporting_category, @currency, @amount, @fee, @net, @exchange_rate,
     @source_id, @source_type, @presentment_currency, @presentment_amount, @description,
     @product_id, @product_name, @created, @raw_json)
  ON CONFLICT(id) DO UPDATE SET
    type = excluded.type,
    reporting_category = excluded.reporting_category,
    exchange_rate = excluded.exchange_rate,
    presentment_currency = excluded.presentment_currency,
    presentment_amount = excluded.presentment_amount,
    description = excluded.description,
    product_id = excluded.product_id,
    product_name = excluded.product_name,
    raw_json = excluded.raw_json,
    fetched_at = datetime('now')
`);

const upsertPayout = db.prepare(`
  INSERT INTO stripe_payouts
    (id, amount, currency, status, method, automatic, arrival_date, created, raw_json)
  VALUES
    (@id, @amount, @currency, @status, @method, @automatic, @arrival_date, @created, @raw_json)
  ON CONFLICT(id) DO UPDATE SET
    status = excluded.status,
    arrival_date = excluded.arrival_date,
    raw_json = excluded.raw_json,
    fetched_at = datetime('now')
`);

const upsertCursor = db.prepare(`
  INSERT INTO sync_cursors (source, currency, last_synced_at)
  VALUES (@source, @currency, @last_synced_at)
  ON CONFLICT(source, currency) DO UPDATE SET last_synced_at = excluded.last_synced_at
`);

function isoFromUnix(seconds: number | undefined | null): string | null {
  return seconds == null ? null : new Date(seconds * 1000).toISOString();
}

/** Pull the expanded source's presentment currency/amount, if present. */
function presentment(source: BalanceTransaction["source"]): {
  sourceId: string | null;
  sourceType: string | null;
  ccy: string | null;
  amount: number | null;
  description: string | null;
} {
  if (!source || typeof source === "string") {
    return { sourceId: typeof source === "string" ? source : null, sourceType: null, ccy: null, amount: null, description: null };
  }
  const s = source as ExpandedSource;
  return {
    sourceId: s.id ?? null,
    sourceType: s.object ?? null,
    ccy: s.currency ?? null,
    amount: s.amount ?? null,
    description: (s.description as string | null) ?? null,
  };
}

export interface StripeSyncOptions {
  from: Date;
  to: Date;
}

export async function syncStripe(opts: StripeSyncOptions): Promise<void> {
  const btTotal = await fetchBalanceTransactions(opts.from, opts.to);
  log.info({ total: btTotal }, "stripe balance_transactions sync complete");

  const poTotal = await fetchPayouts(opts.from, opts.to);
  log.info({ total: poTotal }, "stripe payouts sync complete");

  upsertCursor.run({
    source: "stripe",
    currency: "*",
    last_synced_at: opts.to.toISOString(),
  });
}

async function fetchBalanceTransactions(from: Date, to: Date): Promise<number> {
  log.info({ from: from.toISOString(), to: to.toISOString() }, "fetching stripe balance_transactions");
  let total = 0;
  const items = stripeList<BalanceTransaction>("/balance_transactions", {
    "created[gte]": Math.floor(from.getTime() / 1000),
    "created[lte]": Math.floor(to.getTime() / 1000),
    "expand[]": "data.source",
  });
  const batch: BalanceTransaction[] = [];
  for await (const bt of items) batch.push(bt);

  // Resolve product for charge-type rows (async, so do it before the sync txn).
  const resolver = new ProductResolver();
  await resolver.loadCatalogue();
  const products = new Map<string, { product_id: string; product_name: string } | null>();
  let resolved = 0;
  for (const bt of batch) {
    if (bt.reporting_category !== "charge") continue;
    if (!bt.source || typeof bt.source === "string") continue;
    const ref = await resolver.resolve(bt.source as ExpandedSource & { currency: string; amount: number });
    products.set(bt.id, ref);
    if (ref) resolved += 1;
  }
  log.info({ charges: products.size, resolved }, "stripe product attribution");

  db.transaction(() => {
    for (const bt of batch) {
      const p = presentment(bt.source);
      const prod = products.get(bt.id) ?? null;
      upsertBt.run({
        id: bt.id,
        type: bt.type,
        reporting_category: bt.reporting_category ?? null,
        currency: bt.currency,
        amount: bt.amount,
        fee: bt.fee,
        net: bt.net,
        exchange_rate: bt.exchange_rate ?? null,
        source_id: p.sourceId,
        source_type: p.sourceType,
        presentment_currency: p.ccy,
        presentment_amount: p.amount,
        description: bt.description ?? p.description,
        product_id: prod?.product_id ?? null,
        product_name: prod?.product_name ?? null,
        created: isoFromUnix(bt.created)!,
        raw_json: JSON.stringify(bt),
      });
    }
  })();
  total = batch.length;
  return total;
}

async function fetchPayouts(from: Date, to: Date): Promise<number> {
  let total = 0;
  const items = stripeList<Payout>("/payouts", {
    "created[gte]": Math.floor(from.getTime() / 1000),
    "created[lte]": Math.floor(to.getTime() / 1000),
  });
  const batch: Payout[] = [];
  for await (const po of items) batch.push(po);
  db.transaction(() => {
    for (const po of batch) {
      upsertPayout.run({
        id: po.id,
        amount: po.amount,
        currency: po.currency,
        status: po.status ?? null,
        method: po.method ?? null,
        automatic: po.automatic ? 1 : 0,
        arrival_date: isoFromUnix(po.arrival_date),
        created: isoFromUnix(po.created)!,
        raw_json: JSON.stringify(po),
      });
    }
  })();
  total = batch.length;
  return total;
}
