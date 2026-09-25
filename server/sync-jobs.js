/**
 * Pull real job postings from the configured feeds.
 *   npm run sync:jobs
 *
 * Safe to run on a schedule (a cron job, a GitHub Action): it upserts on
 * (source, source_ref), so re-running refreshes rows rather than duplicating.
 */
import { syncJobs } from "./jobfeeds.js";
import { close, describe } from "./db.js";

const result = await syncJobs();

if (!result.ran) {
  console.log(result.reason);
} else {
  console.log(`Synced ${describe()}`);
  console.log(`  feeds:    ${result.feeds.join(", ")}`);
  console.log(`  area:     ${result.where} within ${result.radiusMiles} miles`);
  console.log(`  imported: ${result.imported}   updated: ${result.updated}   removed: ${result.removed}`);
  for (const e of result.errors) console.log(`  ! ${e}`);
}

await close();
