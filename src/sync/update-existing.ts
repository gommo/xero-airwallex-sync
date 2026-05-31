import { db } from "../db/db.js";
import { log } from "../log.js";
import { planPostings, type PlannedPosting } from "./plan.js";
import { postBankTransaction, updateBankTransaction } from "../xero/bank-transactions.js";
import { planHash } from "./hash.js";

const clearPosting = db.prepare("DELETE FROM xero_postings WHERE airwallex_id = ?");
const recordPosting = db.prepare(`
  INSERT INTO xero_postings (airwallex_id, source, xero_txn_id, aud_amount, fx_rate, last_pushed_hash)
  VALUES (@airwallex_id, @source, @xero_txn_id, @aud_amount, @fx_rate, @hash)
  ON CONFLICT(airwallex_id) DO UPDATE SET
    xero_txn_id = excluded.xero_txn_id,
    aud_amount = excluded.aud_amount,
    fx_rate = excluded.fx_rate,
    last_pushed_hash = excluded.last_pushed_hash,
    posted_at = datetime('now')
`);
const updateHash = db.prepare(`UPDATE xero_postings SET last_pushed_hash = ? WHERE airwallex_id = ?`);

function isDeletedInXero(err: Error): boolean {
  return err.message.includes("not of valid status for modification");
}

function isReconciledInXero(err: Error): boolean {
  return err.message.includes("has been reconciled with a Bank Statement");
}

export interface UpdateOptions {
  commit: boolean;
  limit?: number;
  /** Push even if the plan hash matches the last-pushed hash. */
  force?: boolean;
}

export async function updateExistingPostings(opts: UpdateOptions): Promise<void> {
  const plans = await planPostings();
  const posted = db
    .prepare("SELECT airwallex_id, xero_txn_id, last_pushed_hash FROM xero_postings")
    .all() as Array<{ airwallex_id: string; xero_txn_id: string; last_pushed_hash: string | null }>;
  const postedMap = new Map(posted.map((p) => [p.airwallex_id, p]));

  // One-time backfill: rows without a hash get their *current* plan hash stored,
  // treating them as "already in sync" so we never blindly re-push existing data.
  let backfilled = 0;
  for (const plan of plans) {
    const row = postedMap.get(plan.source_id);
    if (row && !row.last_pushed_hash) {
      const h = planHash(plan);
      updateHash.run(h, plan.source_id);
      row.last_pushed_hash = h;
      backfilled += 1;
    }
  }
  if (backfilled > 0) {
    log.info({ backfilled }, "backfilled last_pushed_hash for pre-hash rows (no Xero writes)");
  }

  const work = plans.filter((p) => postedMap.has(p.source_id));
  const slice = opts.limit !== undefined ? work.slice(0, opts.limit) : work;

  if (slice.length === 0) {
    log.info("no posted rows to consider");
    return;
  }

  let updated = 0;
  let reposted = 0;
  let skipped = 0;
  let locked = 0;
  let failed = 0;
  for (const plan of slice) {
    const row = postedMap.get(plan.source_id)!;
    const currentHash = planHash(plan);
    if (!opts.force && currentHash === row.last_pushed_hash) {
      skipped += 1;
      continue;
    }
    if (!opts.commit) {
      log.info(
        { ref: plan.reference, contact: plan.contact_name, code: plan.xero_account_code },
        "[dry-run] would update (hash changed)",
      );
      continue;
    }
    try {
      await updateBankTransaction(row.xero_txn_id, plan);
      updateHash.run(currentHash, plan.source_id);
      updated += 1;
      log.info({ ref: plan.reference, contact: plan.contact_name }, "updated");
    } catch (err) {
      const e = err as Error;
      if (isReconciledInXero(e)) {
        // Row is reconciled against a bank statement in Xero → locked from edits.
        // Mark our hash as current so we stop retrying (and stop alerting).
        updateHash.run(currentHash, plan.source_id);
        locked += 1;
        log.info({ ref: plan.reference }, "skipped (reconciled/locked in Xero)");
      } else if (isDeletedInXero(e)) {
        try {
          const newId = await postBankTransaction(plan);
          recordPosting.run({
            airwallex_id: plan.source_id,
            source: plan.source,
            xero_txn_id: newId,
            aud_amount: plan.aud_amount,
            fx_rate: plan.fx_rate,
            hash: currentHash,
          });
          reposted += 1;
          log.info({ ref: plan.reference, new_xero_id: newId }, "re-posted (was deleted in Xero)");
        } catch (postErr) {
          failed += 1;
          clearPosting.run(plan.source_id);
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
  log.info(
    { total: slice.length, updated, reposted, skipped, locked, failed, dry_run: !opts.commit, force: !!opts.force },
    "update summary",
  );
  if (failed > 0) process.exitCode = 1;
}
