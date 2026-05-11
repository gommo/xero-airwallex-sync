import { db } from "../db/db.js";

interface Row {
  [k: string]: string | number | null;
}

function q<T>(sql: string): T[] {
  return db.prepare(sql).all() as T[];
}
function q1<T>(sql: string): T | undefined {
  return db.prepare(sql).get() as T | undefined;
}

export function printSummary(): void {
  const counts = q<{ currency: string; status: string; n: number }>(
    `SELECT currency, status, COUNT(*) AS n
     FROM airwallex_transactions
     GROUP BY currency, status
     ORDER BY currency, status`,
  );

  const posted = q1<{ n: number }>(`SELECT COUNT(*) AS n FROM xero_postings`)?.n ?? 0;
  const unposted = q1<{ n: number }>(
    `SELECT COUNT(*) AS n FROM airwallex_transactions t
     WHERE t.status='SETTLED' AND t.currency!='AUD'
       AND t.transaction_type NOT LIKE 'CONVERSION_%'
       AND NOT EXISTS (SELECT 1 FROM xero_postings p WHERE p.airwallex_id = t.id)`,
  )?.n ?? 0;

  const conversions = q1<{ n: number }>(
    `SELECT COUNT(*) AS n FROM conversion_pairs WHERE status='SETTLED'`,
  )?.n ?? 0;

  const latest = q1<Row>(
    `SELECT t.id, t.currency, t.amount, t.settled_at, bh.description
     FROM airwallex_transactions t
     LEFT JOIN airwallex_balance_history bh
       ON bh.transaction_type=t.transaction_type AND bh.currency=t.currency
        AND ABS(bh.amount)=ABS(t.amount)
     WHERE t.status='SETTLED' AND t.transaction_type='ISSUING_CAPTURE'
     ORDER BY t.settled_at DESC LIMIT 1`,
  );

  const lines: string[] = [];
  const date = new Date().toISOString().slice(0, 16).replace("T", " ");
  lines.push(`Sync ${date}`);

  for (const c of counts) {
    lines.push(`• ${c.currency} ${c.status}: ${c.n}`);
  }
  lines.push(`• Posted to Xero: ${posted}, awaiting post: ${unposted}`);
  if (conversions > 0) {
    lines.push(`• ${conversions} FX conversion(s) → reconcile as Transfer in Xero AUD`);
  }
  if (latest) {
    const merchant = ((latest.description as string | null) ?? "").split(",")[0]?.trim() || "Airwallex";
    const day = (latest.settled_at as string | null)?.slice(0, 10) ?? "?";
    lines.push(`• Latest: ${merchant} ${latest.currency} ${Math.abs(Number(latest.amount)).toFixed(2)} (${day})`);
  }

  // Plain stdout, no pino, no colors
  process.stdout.write(lines.join("\n") + "\n");
}
