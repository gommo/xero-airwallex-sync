import { db } from "../db/db.js";
import { log } from "../log.js";
import { planPostings, type PlannedPosting } from "./plan.js";
import { postBankTransaction, updateBankTransaction } from "../xero/bank-transactions.js";

const clearPosting = db.prepare("DELETE FROM xero_postings WHERE airwallex_id = ?");
const recordPosting = db.prepare(`
  INSERT INTO xero_postings (airwallex_id, xero_txn_id, aud_amount, fx_rate)
  VALUES (@airwallex_id, @xero_txn_id, @aud_amount, @fx_rate)
  ON CONFLICT(airwallex_id) DO UPDATE SET
    xero_txn_id = excluded.xero_txn_id,
    aud_amount = excluded.aud_amount,
    fx_rate = excluded.fx_rate,
    posted_at = datetime('now')
`);

function isDeletedInXero(err: Error): boolean {
  return err.message.includes("not of valid status for modification");
}

export interface UpdateOptions {
  commit: boolean;
  limit?: number;
}

export async function updateExistingPostings(opts: UpdateOptions): Promise<void> {
  const plans = await planPostings();
  const posted = db
    .prepare("SELECT airwallex_id, xero_txn_id FROM xero_postings")
    .all() as Array<{ airwallex_id: string; xero_txn_id: string }>;
  const postedMap = new Map(posted.map((p) => [p.airwallex_id, p.xero_txn_id]));

  const work = plans.filter((p) => postedMap.has(p.airwallex_id));
  const slice = opts.limit !== undefined ? work.slice(0, opts.limit) : work;

  if (slice.length === 0) {
    log.info("no posted rows to update");
    return;
  }
  log.info({ total_posted: posted.length, will_update: slice.length, limit: opts.limit }, "update plan");

  let updated = 0;
  let reposted = 0;
  let failed = 0;
  for (const plan of slice) {
    const xeroId = postedMap.get(plan.airwallex_id)!;
    if (!opts.commit) {
      log.info(
        { ref: plan.reference, contact: plan.contact_name, desc: plan.description },
        "[dry-run] would update",
      );
      continue;
    }
    try {
      await updateBankTransaction(xeroId, plan);
      updated += 1;
      log.info({ ref: plan.reference, contact: plan.contact_name }, "updated");
    } catch (err) {
      const e = err as Error;
      if (isDeletedInXero(e)) {
        // The Xero row was deleted/voided by the user. Treat as gone and re-post fresh.
        try {
          const newId = await postBankTransaction(plan);
          recordPosting.run({
            airwallex_id: plan.airwallex_id,
            xero_txn_id: newId,
            aud_amount: plan.aud_amount,
            fx_rate: plan.fx_rate,
          });
          reposted += 1;
          log.info({ ref: plan.reference, new_xero_id: newId }, "re-posted (was deleted in Xero)");
        } catch (postErr) {
          failed += 1;
          clearPosting.run(plan.airwallex_id);
          log.error(
            { ref: plan.reference, err: (postErr as Error).message },
            "re-post failed; cleared from xero_postings",
          );
        }
      } else {
        failed += 1;
        log.error({ ref: plan.reference, err: e.message }, "update failed");
      }
    }
  }
  log.info({ total: slice.length, updated, reposted, failed, dry_run: !opts.commit }, "update summary");
  if (failed > 0) process.exitCode = 1;
}
