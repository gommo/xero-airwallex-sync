import { Command } from "commander";
import { syncAirwallex } from "./sync/airwallex-sync.js";
import { listConversionPairs } from "./sync/conversions.js";
import { planPostings } from "./sync/plan.js";
import { postToXero } from "./sync/post.js";
import { updateExistingPostings } from "./sync/update-existing.js";
import { addMapping, listMappings, removeMapping } from "./sync/mappings.js";
import { printSummary } from "./sync/summary.js";
import { discoverAwxWallets, listBankAccounts } from "./xero/accounts.js";
import { xeroGet } from "./xero/client.js";
import { db } from "./db/db.js";
import { log } from "./log.js";

const program = new Command();
program.name("sync").description("Airwallex → Xero sync");

program
  .command("airwallex")
  .description("Pull Airwallex financial_transactions into local SQLite")
  .option("-c, --currency <ccy...>", "currency codes to fetch separately, e.g. USD EUR; omit for all")
  .option("--since <date>", "ISO date or YYYY-MM-DD; default = 6 months ago")
  .option("--until <date>", "ISO date or YYYY-MM-DD; default = now")
  .action(async (opts: { currency?: string[]; since?: string; until?: string }) => {
    const to = opts.until ? new Date(opts.until) : new Date();
    const defaultSince = new Date(to);
    defaultSince.setMonth(defaultSince.getMonth() - 6);
    const from = opts.since ? new Date(opts.since) : defaultSince;
    const currencies = opts.currency?.map((c) => c.toUpperCase());
    log.info({ currencies: currencies ?? "all", from: from.toISOString(), to: to.toISOString() }, "starting airwallex sync");
    await syncAirwallex({ currencies, from, to });
    log.info("done");
  });

program
  .command("stats")
  .description("Show row counts in local db")
  .action(() => {
    const tables = ["airwallex_transactions", "wallets", "sync_cursors", "fx_rates", "xero_postings"];
    for (const t of tables) {
      const row = db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number };
      log.info({ table: t, rows: row.n });
    }
    const byStatus = db
      .prepare("SELECT currency, status, COUNT(*) AS n FROM airwallex_transactions GROUP BY currency, status ORDER BY currency, status")
      .all() as Array<{ currency: string; status: string; n: number }>;
    for (const r of byStatus) log.info(r, "airwallex breakdown");
  });

program
  .command("conversions")
  .description("List paired Airwallex FX conversions from local db")
  .option("--status <status>", "filter by status (PENDING / SETTLED)")
  .option("--currency <ccy>", "include only pairs involving this currency")
  .action((opts: { status?: string; currency?: string }) => {
    const pairs = listConversionPairs({ status: opts.status, currency: opts.currency?.toUpperCase() });
    if (pairs.length === 0) {
      log.info("no conversion pairs");
      return;
    }
    for (const p of pairs) {
      log.info(
        {
          when: p.created_at,
          pair: p.currency_pair,
          rate: p.client_rate,
          status: p.status,
          sell: `${p.sell_amount} ${p.sell_currency}`,
          buy: `${p.buy_amount} ${p.buy_currency}`,
        },
        "conversion",
      );
    }
  });

program
  .command("xero-accounts")
  .description("List Xero bank accounts and discover AWX_*_Cash_<CCY> wallets")
  .option("--all", "show every bank account, not just AWX ones")
  .action(async (opts: { all?: boolean }) => {
    if (opts.all) {
      const all = await listBankAccounts();
      for (const a of all) log.info({ name: a.Name, code: a.Code, id: a.AccountID, currency: a.CurrencyCode }, "bank");
      return;
    }
    const wallets = await discoverAwxWallets();
    if (wallets.length === 0) {
      log.warn("no AWX_*_Cash_<CCY> bank accounts found");
      return;
    }
    for (const w of wallets) {
      log.info({ currency: w.currency, name: w.account.Name, id: w.account.AccountID, code: w.account.Code }, "wallet linked");
    }
  });

program
  .command("plan")
  .description("Dry-run: show planned Xero BankTransactions for SETTLED non-AUD txns")
  .action(async () => {
    const plans = await planPostings();
    if (plans.length === 0) {
      log.info("nothing to post");
      return;
    }
    let totalAud = 0;
    for (const p of plans) {
      totalAud += p.aud_amount;
      log.info(
        {
          date: p.date,
          kind: p.kind,
          ccy: `${p.ccy_amount} ${p.currency}`,
          aud: p.aud_amount,
          rate: p.fx_rate,
          src: p.fx_source,
          ref: p.reference,
          desc: p.description,
        },
        p.notes ?? "",
      );
    }
    log.info({ count: plans.length, net_aud_impact: Number(totalAud.toFixed(2)) }, "plan summary");
  });

program
  .command("xero-chart")
  .description("List Xero non-bank accounts so you can pick XERO_EXPENSE_CODE / XERO_REVENUE_CODE")
  .option("--type <type>", "filter by type (EXPENSE, REVENUE, CURRENT, etc.)")
  .action(async (opts: { type?: string }) => {
    interface ChartAccount {
      AccountID: string;
      Code?: string;
      Name: string;
      Type: string;
      Class?: string;
      Status: string;
    }
    const where = opts.type ? `Type=="${opts.type.toUpperCase()}"` : `Class=="EXPENSE"||Class=="REVENUE"`;
    const res = await xeroGet<{ Accounts: ChartAccount[] }>("/Accounts", { where });
    const accounts = res.Accounts ?? [];
    for (const a of accounts) {
      log.info({ code: a.Code, name: a.Name, type: a.Type, status: a.Status });
    }
    log.info({ count: accounts.length }, "chart");
  });

program
  .command("post")
  .description("Post planned Xero BankTransactions. Default is dry-run; pass --commit to actually write.")
  .option("--commit", "actually call Xero (without this flag, runs as dry-run)")
  .option("--limit <n>", "post at most N entries (useful for first-run sanity)", (v) => parseInt(v, 10))
  .action(async (opts: { commit?: boolean; limit?: number }) => {
    await postToXero({ commit: !!opts.commit, limit: opts.limit });
  });

program
  .command("update-xero")
  .description("Push refreshed Contact/Description to already-posted Xero BankTransactions")
  .option("--commit", "actually call Xero (without this, dry-run)")
  .option("--limit <n>", "update at most N entries", (v) => parseInt(v, 10))
  .action(async (opts: { commit?: boolean; limit?: number }) => {
    await updateExistingPostings({ commit: !!opts.commit, limit: opts.limit });
  });

program
  .command("summary")
  .description("Plain-text digest of current sync state (used by Pushover notification)")
  .action(() => {
    printSummary();
  });

const mapCmd = program.command("map").description("Manage merchant → Xero account-code mappings");

mapCmd
  .command("add <pattern> <code>")
  .description("Add or update a mapping. Pattern is case-insensitive substring against the merchant description.")
  .option("--kind <kind>", "EXPENSE or REVENUE", "EXPENSE")
  .action((pattern: string, code: string, opts: { kind?: string }) => {
    const kind = (opts.kind ?? "EXPENSE").toUpperCase() as "EXPENSE" | "REVENUE";
    addMapping(pattern, code, kind);
    log.info({ pattern: pattern.toUpperCase(), code, kind }, "mapping added");
  });

mapCmd
  .command("remove <pattern>")
  .description("Remove a mapping")
  .action((pattern: string) => {
    const n = removeMapping(pattern);
    log.info({ pattern: pattern.toUpperCase(), removed: n });
  });

mapCmd
  .command("list")
  .description("List all merchant mappings")
  .action(() => {
    const all = listMappings();
    if (all.length === 0) {
      log.info("no mappings");
      return;
    }
    for (const m of all) log.info({ pattern: m.pattern, code: m.account_code, kind: m.account_kind });
  });

program.parseAsync(process.argv).catch((err) => {
  log.error(err);
  process.exit(1);
});
