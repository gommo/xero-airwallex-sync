import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { config } from "../config.js";

const dbPath = resolve(config.DB_PATH);
mkdirSync(dirname(dbPath), { recursive: true });

export const db = new Database(dbPath);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

const migrations = [
  `CREATE TABLE IF NOT EXISTS wallets (
    currency TEXT PRIMARY KEY,
    xero_account_code TEXT,
    xero_account_id TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  `CREATE TABLE IF NOT EXISTS sync_cursors (
    source TEXT NOT NULL,
    currency TEXT NOT NULL,
    last_synced_at TEXT,
    PRIMARY KEY (source, currency)
  )`,
  `CREATE TABLE IF NOT EXISTS airwallex_transactions (
    id TEXT PRIMARY KEY,
    currency TEXT NOT NULL,
    status TEXT NOT NULL,
    source_type TEXT,
    transaction_type TEXT,
    amount REAL,
    fee REAL,
    net REAL,
    created_at TEXT NOT NULL,
    settled_at TEXT,
    estimated_settled_at TEXT,
    description TEXT,
    source_id TEXT,
    funding_source_id TEXT,
    batch_id TEXT,
    currency_pair TEXT,
    client_rate REAL,
    raw_json TEXT NOT NULL,
    fetched_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  `CREATE INDEX IF NOT EXISTS idx_awx_txn_currency_created ON airwallex_transactions(currency, created_at)`,
  `CREATE INDEX IF NOT EXISTS idx_awx_txn_status ON airwallex_transactions(status)`,
  `CREATE TABLE IF NOT EXISTS airwallex_balance_history (
    id TEXT PRIMARY KEY,
    financial_txn_id TEXT,
    posted_at TEXT,
    currency TEXT NOT NULL,
    amount REAL,
    balance REAL,
    description TEXT,
    source_type TEXT,
    transaction_type TEXT,
    account_type TEXT,
    raw_json TEXT NOT NULL,
    fetched_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  `CREATE INDEX IF NOT EXISTS idx_awx_bh_ftx ON airwallex_balance_history(financial_txn_id)`,
  `CREATE TABLE IF NOT EXISTS merchant_mappings (
    pattern TEXT PRIMARY KEY,
    account_code TEXT NOT NULL,
    account_kind TEXT NOT NULL DEFAULT 'EXPENSE',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  `CREATE TABLE IF NOT EXISTS xero_tracking_categories (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    status TEXT,
    fetched_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  `CREATE TABLE IF NOT EXISTS xero_tracking_options (
    id TEXT PRIMARY KEY,
    category_id TEXT NOT NULL,
    name TEXT NOT NULL,
    status TEXT,
    fetched_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  `CREATE TABLE IF NOT EXISTS fx_rates (
    date TEXT NOT NULL,
    from_currency TEXT NOT NULL,
    to_currency TEXT NOT NULL,
    rate REAL NOT NULL,
    source TEXT NOT NULL,
    fetched_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (date, from_currency, to_currency)
  )`,
  `CREATE TABLE IF NOT EXISTS xero_postings (
    airwallex_id TEXT PRIMARY KEY,
    xero_txn_id TEXT NOT NULL,
    aud_amount REAL NOT NULL,
    fx_rate REAL NOT NULL,
    posted_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (airwallex_id) REFERENCES airwallex_transactions(id)
  )`,
  `CREATE VIEW IF NOT EXISTS conversion_pairs AS
    SELECT
      source_id,
      currency_pair,
      MAX(client_rate) AS client_rate,
      MAX(status) AS status,
      MIN(created_at) AS created_at,
      MAX(CASE WHEN transaction_type = 'CONVERSION_BUY' THEN id END) AS buy_id,
      MAX(CASE WHEN transaction_type = 'CONVERSION_BUY' THEN currency END) AS buy_currency,
      MAX(CASE WHEN transaction_type = 'CONVERSION_BUY' THEN amount END) AS buy_amount,
      MAX(CASE WHEN transaction_type = 'CONVERSION_SELL' THEN id END) AS sell_id,
      MAX(CASE WHEN transaction_type = 'CONVERSION_SELL' THEN currency END) AS sell_currency,
      MAX(CASE WHEN transaction_type = 'CONVERSION_SELL' THEN amount END) AS sell_amount
    FROM airwallex_transactions
    WHERE transaction_type IN ('CONVERSION_BUY', 'CONVERSION_SELL')
    GROUP BY source_id`,
];

db.transaction(() => {
  for (const stmt of migrations) db.exec(stmt);
})();

// Best-effort column additions; ignore "duplicate column" errors.
function tryAddColumn(table: string, column: string, decl: string) {
  try {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${decl}`);
  } catch (e) {
    if (!/duplicate column/i.test((e as Error).message)) throw e;
  }
}
tryAddColumn("xero_postings", "last_pushed_hash", "TEXT");
tryAddColumn("merchant_mappings", "tracking_1_id", "TEXT");
tryAddColumn("merchant_mappings", "tracking_1_option_id", "TEXT");
tryAddColumn("merchant_mappings", "tracking_2_id", "TEXT");
tryAddColumn("merchant_mappings", "tracking_2_option_id", "TEXT");
