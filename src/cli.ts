import { Command } from "commander";
import { syncAirwallex } from "./sync/airwallex-sync.js";
import { syncStripe } from "./sync/stripe-sync.js";
import { syncPaypal } from "./sync/paypal-sync.js";
import { planPaypalPostings } from "./sync/paypal-plan.js";
import { listConversionPairs } from "./sync/conversions.js";
import { planPostings } from "./sync/plan.js";
import { planStripePostings } from "./sync/stripe-plan.js";
import { postToXero } from "./sync/post.js";
import { updateExistingPostings } from "./sync/update-existing.js";
import { addMapping, listMappings, removeMapping } from "./sync/mappings.js";
import { printSummary } from "./sync/summary.js";
import { discoverAwxWallets, listBankAccounts } from "./xero/accounts.js";
import { xeroGet } from "./xero/client.js";
import { refreshTracking, listCategories, listOptions, resolveTrackingSpec } from "./xero/tracking.js";
import { associateFile, deleteFile, deleteFolder, ensureFolder, listFiles, listFolders, renameFolder, uploadFile, type ObjectGroup } from "./xero/files.js";
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
  .command("stripe")
  .description("Pull Stripe balance_transactions + payouts into local SQLite (read-only; writes nothing to Xero)")
  .option("--since <date>", "ISO date or YYYY-MM-DD; default = 6 months ago")
  .option("--until <date>", "ISO date or YYYY-MM-DD; default = now")
  .action(async (opts: { since?: string; until?: string }) => {
    const to = opts.until ? new Date(opts.until) : new Date();
    const defaultSince = new Date(to);
    defaultSince.setMonth(defaultSince.getMonth() - 6);
    const from = opts.since ? new Date(opts.since) : defaultSince;
    log.info({ from: from.toISOString(), to: to.toISOString() }, "starting stripe sync");
    await syncStripe({ from, to });
    log.info("done");
  });

program
  .command("paypal")
  .description("Pull PayPal transactions (Transaction Search API) into local SQLite (read-only; writes nothing to Xero)")
  .option("--since <date>", "ISO date or YYYY-MM-DD; default = 3 months ago")
  .option("--until <date>", "ISO date or YYYY-MM-DD; default = now")
  .action(async (opts: { since?: string; until?: string }) => {
    const to = opts.until ? new Date(opts.until) : new Date();
    const defaultSince = new Date(to);
    defaultSince.setMonth(defaultSince.getMonth() - 3);
    const from = opts.since ? new Date(opts.since) : defaultSince;
    await syncPaypal({ from, to });
  });

program
  .command("paypal-plan")
  .description("Dry-run: show planned Xero RECEIVE lines for Patreon payouts in PayPal (no writes)")
  .action(async () => {
    const plans = await planPaypalPostings();
    for (const p of plans) {
      log.info({ date: p.date, usd: p.ccy_amount, aud: p.aud_amount, rate: Number(p.fx_rate.toFixed(5)), ref: p.reference }, "planned");
    }
    log.info({ count: plans.length, aud_total: Number(plans.reduce((s, p) => s + p.aud_amount, 0).toFixed(2)) }, "paypal plan summary (dry-run)");
  });

program
  .command("stats")
  .description("Show row counts in local db")
  .action(() => {
    const tables = [
      "airwallex_transactions",
      "stripe_balance_transactions",
      "stripe_payouts",
      "paypal_transactions",
      "wallets",
      "sync_cursors",
      "fx_rates",
      "xero_postings",
    ];
    for (const t of tables) {
      const row = db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number };
      log.info({ table: t, rows: row.n });
    }
    const byStatus = db
      .prepare("SELECT currency, status, COUNT(*) AS n FROM airwallex_transactions GROUP BY currency, status ORDER BY currency, status")
      .all() as Array<{ currency: string; status: string; n: number }>;
    for (const r of byStatus) log.info(r, "airwallex breakdown");
    const byCategory = db
      .prepare(
        "SELECT reporting_category, type, COUNT(*) AS n, SUM(net) AS net_minor, currency FROM stripe_balance_transactions GROUP BY reporting_category, type ORDER BY reporting_category",
      )
      .all() as Array<{ reporting_category: string; type: string; n: number; net_minor: number; currency: string }>;
    for (const r of byCategory) log.info(r, "stripe breakdown");
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
  .command("stripe-plan")
  .description("Dry-run: show planned Xero BankTransactions from Stripe balance_transactions (no writes)")
  .option("--foreign", "list every non-AUD line (the ones converted to AUD)")
  .action(async (opts: { foreign?: boolean }) => {
    const plans = await planStripePostings();
    if (plans.length === 0) {
      log.info("nothing to plan - run `sync stripe` first");
      return;
    }
    const byCat: Record<string, { n: number; aud: number }> = {};
    let net = 0;
    for (const p of plans) {
      const cat = (p.notes ?? "").split(" ")[0] || "?";
      (byCat[cat] ??= { n: 0, aud: 0 });
      byCat[cat].n += 1;
      const signed = p.kind === "RECEIVE" ? p.aud_amount : -p.aud_amount;
      byCat[cat].aud += signed;
      net += signed;
      if (opts.foreign && (p.fx_source === "frankfurter.app" || p.kind === "TRANSFER")) {
        log.info({ date: p.date, kind: p.kind, aud: p.aud_amount, ref: p.reference, desc: p.description }, "foreign line");
      }
    }
    for (const [cat, v] of Object.entries(byCat)) {
      log.info({ category: cat, count: v.n, aud: Number(v.aud.toFixed(2)) }, "stripe plan group");
    }
    log.info({ count: plans.length, net_aud_impact: Number(net.toFixed(2)) }, "stripe plan summary (dry-run)");
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
  .option("--source <source>", "which planner to post: airwallex (default), stripe or paypal", "airwallex")
  .action(async (opts: { commit?: boolean; limit?: number; source?: string }) => {
    const source = opts.source === "stripe" ? "stripe" : opts.source === "paypal" ? "paypal" : "airwallex";
    await postToXero({ commit: !!opts.commit, limit: opts.limit, source });
  });

program
  .command("update-xero")
  .description("Push refreshed metadata only for rows whose plan hash changed since last push (e.g. after adding a mapping)")
  .option("--commit", "actually call Xero (without this, dry-run)")
  .option("--limit <n>", "update at most N entries", (v) => parseInt(v, 10))
  .option("--force", "ignore the hash check and push every posted row (clobbers manual Xero edits)")
  .option("--source <source>", "which planner's rows to refresh: airwallex (default) or stripe", "airwallex")
  .action(async (opts: { commit?: boolean; limit?: number; force?: boolean; source?: string }) => {
    const source = opts.source === "stripe" ? "stripe" : "airwallex";
    await updateExistingPostings({ commit: !!opts.commit, limit: opts.limit, force: !!opts.force, source });
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
  .description("Add/update a mapping. Pattern is a case-insensitive substring against the merchant description.")
  .option("--kind <kind>", "EXPENSE or REVENUE", "EXPENSE")
  .option("--track1 <Category:Option>", "tracking, e.g. Project:oldworldrankings.com")
  .option("--track2 <Category:Option>", "second tracking category if you use one")
  .action((pattern: string, code: string, opts: { kind?: string; track1?: string; track2?: string }) => {
    const kind = (opts.kind ?? "EXPENSE").toUpperCase() as "EXPENSE" | "REVENUE";
    const t1 = opts.track1 ? resolveTrackingSpec(opts.track1) : null;
    const t2 = opts.track2 ? resolveTrackingSpec(opts.track2) : null;
    addMapping({
      pattern,
      code,
      kind,
      tracking_1_id: t1?.categoryId ?? null,
      tracking_1_option_id: t1?.optionId ?? null,
      tracking_2_id: t2?.categoryId ?? null,
      tracking_2_option_id: t2?.optionId ?? null,
    });
    log.info(
      {
        pattern: pattern.toUpperCase(),
        code,
        kind,
        track1: t1 ? `${t1.categoryName}:${t1.optionName}` : undefined,
        track2: t2 ? `${t2.categoryName}:${t2.optionName}` : undefined,
      },
      "mapping added",
    );
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
    // Resolve tracking option IDs → names for display.
    const optName = new Map(listOptions().map((o) => [o.id, o.name]));
    for (const m of all) {
      log.info({
        pattern: m.pattern,
        code: m.account_code,
        kind: m.account_kind,
        track1: m.tracking_1_option_id ? optName.get(m.tracking_1_option_id) ?? m.tracking_1_option_id : undefined,
        track2: m.tracking_2_option_id ? optName.get(m.tracking_2_option_id) ?? m.tracking_2_option_id : undefined,
      });
    }
  });

const docsCmd = program.command("docs").description("Xero Documents (Files API): folders, uploads, attach to records. Needs `files` scope.");

docsCmd
  .command("folders")
  .description("List Documents folders")
  .action(async () => {
    for (const f of await listFolders()) console.log(`${f.Id}  ${f.Name}${f.IsInbox ? "  (inbox)" : ""}  files=${f.FileCount ?? "?"}`);
  });

docsCmd
  .command("mkdir <name>")
  .description("Create a Documents folder (no-op if it exists)")
  .action(async (name: string) => {
    const f = await ensureFolder(name);
    console.log(`${f.Id}  ${f.Name}`);
  });

docsCmd
  .command("ls [folder]")
  .description("List files, optionally within a folder name")
  .action(async (folder?: string) => {
    let folderId: string | undefined;
    if (folder) {
      const f = (await listFolders()).find((x) => x.Name.toLowerCase() === folder.toLowerCase());
      if (!f) throw new Error(`folder not found: ${folder}`);
      folderId = f.Id;
    }
    for (const f of await listFiles(folderId)) console.log(`${f.Id}  ${f.Name}  ${f.Size}B  ${f.CreatedDateUtc ?? ""}`);
  });

docsCmd
  .command("upload <file...>")
  .description("Upload one or more local files into a Documents folder")
  .option("-f, --folder <name>", "folder name (created if missing); default Inbox")
  .option("--attach <objectGroup:objectId>", "also associate with a record, e.g. BankTransaction:<id> or Invoice:<id>")
  .action(async (files: string[], opts: { folder?: string; attach?: string }) => {
    const folderId = opts.folder ? (await ensureFolder(opts.folder)).Id : undefined;
    for (const local of files) {
      const f = await uploadFile(local, { folderId });
      console.log(`uploaded ${f.Name} -> ${f.Id}${opts.folder ? ` [${opts.folder}]` : ""}`);
      if (opts.attach) {
        const [group, id] = opts.attach.split(":");
        if (!group || !id) throw new Error("--attach must be objectGroup:objectId");
        await associateFile(f.Id, id, group as ObjectGroup);
        console.log(`  attached to ${group} ${id}`);
      }
    }
  });

docsCmd
  .command("rename <folder> <newName>")
  .description("Rename a Documents folder")
  .action(async (folder: string, newName: string) => {
    const f = (await listFolders()).find((x) => x.Name.toLowerCase() === folder.toLowerCase());
    if (!f) throw new Error(`folder not found: ${folder}`);
    const r = await renameFolder(f.Id, newName);
    console.log(`${r.Id}  ${r.Name}`);
  });

docsCmd
  .command("rmdir <folder>")
  .description("Delete an empty Documents folder")
  .action(async (folder: string) => {
    const f = (await listFolders()).find((x) => x.Name.toLowerCase() === folder.toLowerCase());
    if (!f) throw new Error(`folder not found: ${folder}`);
    if ((f.FileCount ?? 0) > 0) throw new Error(`folder not empty: ${folder} (${f.FileCount} files)`);
    await deleteFolder(f.Id);
    console.log(`deleted ${f.Name}`);
  });

docsCmd
  .command("rm <fileId>")
  .description("Delete a file by id")
  .action(async (fileId: string) => {
    await deleteFile(fileId);
    console.log(`deleted ${fileId}`);
  });

const trackCmd = program.command("tracking").description("Manage cached Xero tracking categories");

trackCmd
  .command("refresh")
  .description("Pull tracking categories + options from Xero into the local cache")
  .action(async () => {
    const r = await refreshTracking();
    log.info(r, "tracking cache refreshed");
  });

trackCmd
  .command("list")
  .description("List cached tracking categories and their options")
  .action(() => {
    const cats = listCategories();
    if (cats.length === 0) {
      log.info("no tracking categories cached — run `pnpm sync tracking refresh`");
      return;
    }
    for (const c of cats) {
      const opts = listOptions(c.id).filter((o) => o.status === "ACTIVE").map((o) => o.name);
      log.info({ category: c.name, status: c.status, options: opts });
    }
  });

program.parseAsync(process.argv).catch((err) => {
  log.error(err);
  process.exit(1);
});
