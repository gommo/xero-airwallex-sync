import { db } from "../db/db.js";
import { log } from "../log.js";
import { planPostings, type PlannedPosting } from "./plan.js";
import { planStripePostings } from "./stripe-plan.js";
import { planPaypalPostings } from "./paypal-plan.js";
import { postBankTransaction, postBankTransfer } from "../xero/bank-transactions.js";
import { planHash } from "./hash.js";

const alreadyPosted = db.prepare("SELECT 1 FROM xero_postings WHERE airwallex_id = ?");
const recordPosting = db.prepare(`
  INSERT INTO xero_postings (airwallex_id, source, xero_txn_id, aud_amount, fx_rate, last_pushed_hash)
  VALUES (@airwallex_id, @source, @xero_txn_id, @aud_amount, @fx_rate, @hash)
  ON CONFLICT(airwallex_id) DO NOTHING
`);

export interface PostOptions {
  commit: boolean;
  limit?: number;
  source?: "airwallex" | "stripe" | "paypal";
}

export async function postToXero(opts: PostOptions): Promise<void> {
  const source = opts.source ?? "airwallex";
  const allPlans =
    source === "stripe" ? await planStripePostings() : source === "paypal" ? await planPaypalPostings() : await planPostings();
  log.info({ source, planned: allPlans.length }, "post: planner loaded");
  if (allPlans.length === 0) {
    log.info("nothing to post");
    return;
  }
  const plans = opts.limit !== undefined ? allPlans.slice(0, opts.limit) : allPlans;
  if (opts.limit !== undefined) {
    log.info({ total_planned: allPlans.length, will_post: plans.length, limit: opts.limit }, "applying --limit");
  }

  let posted = 0;
  let skipped = 0;
  let failed = 0;

  for (const plan of plans) {
    if (alreadyPosted.get(plan.source_id)) {
      skipped += 1;
      log.debug({ ref: plan.reference }, "already posted, skipping");
      continue;
    }
    if (!opts.commit) {
      log.info(
        { date: plan.date, kind: plan.kind, aud: plan.aud_amount, ref: plan.reference, desc: plan.description },
        "[dry-run] would post",
      );
      continue;
    }
    try {
      const xeroId = await tryPost(plan);
      recordPosting.run({
        airwallex_id: plan.source_id,
        source: plan.source,
        xero_txn_id: xeroId,
        aud_amount: plan.aud_amount,
        fx_rate: plan.fx_rate,
        hash: planHash(plan),
      });
      // A transfer also settles the other side's source row (the Airwallex deposit),
      // so mark it posted too and no other planner will pick it up.
      for (const linked of plan.linked_source_ids ?? []) {
        recordPosting.run({
          airwallex_id: linked,
          source: "airwallex",
          xero_txn_id: xeroId,
          aud_amount: plan.aud_amount,
          fx_rate: plan.fx_rate,
          hash: planHash(plan),
        });
      }
      posted += 1;
      log.info({ ref: plan.reference, xero_id: xeroId, aud: plan.aud_amount }, "posted");
    } catch (err) {
      failed += 1;
      log.error({ ref: plan.reference, err: (err as Error).message }, "post failed");
    }
  }

  log.info({ total: plans.length, posted, skipped, failed, dry_run: !opts.commit }, "post summary");
}

async function tryPost(plan: PlannedPosting): Promise<string> {
  return plan.kind === "TRANSFER" ? await postBankTransfer(plan) : await postBankTransaction(plan);
}
