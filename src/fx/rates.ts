import { db } from "../db/db.js";

const getCached = db.prepare(
  `SELECT rate FROM fx_rates WHERE date = @date AND from_currency = @from AND to_currency = @to`,
);
const upsert = db.prepare(`
  INSERT INTO fx_rates (date, from_currency, to_currency, rate, source)
  VALUES (@date, @from, @to, @rate, @source)
  ON CONFLICT(date, from_currency, to_currency) DO UPDATE SET
    rate = excluded.rate, fetched_at = datetime('now')
`);

/**
 * Returns "<to> per 1 <from>" on the given UTC date.
 * Cached in fx_rates. Source: frankfurter.app (ECB). Weekends/holidays automatically
 * fall back to the most recent business-day rate the API returns.
 */
export async function getRate(date: string, from: string, to: string): Promise<number> {
  const cached = getCached.get({ date, from, to }) as { rate: number } | undefined;
  if (cached) return cached.rate;

  const url = `https://api.frankfurter.app/${date}?from=${from}&to=${to}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Frankfurter ${res.status}: ${await res.text()}`);
  const body = (await res.json()) as { rates?: Record<string, number> };
  const rate = body.rates?.[to];
  if (rate === undefined) throw new Error(`Frankfurter: no rate for ${from}→${to} on ${date}`);

  upsert.run({ date, from, to, rate, source: "frankfurter.app" });
  return rate;
}
