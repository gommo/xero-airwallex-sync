import { db } from "../db/db.js";
import { log } from "../log.js";
import { planPostings } from "./plan.js";
import { updateBankTransaction } from "../xero/bank-transactions.js";

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
      failed += 1;
      log.error({ ref: plan.reference, err: (err as Error).message }, "update failed");
    }
  }
  log.info({ total: slice.length, updated, failed, dry_run: !opts.commit }, "update summary");
}
