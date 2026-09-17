/**
 * One poll pass over every board that is currently due.
 *   node scripts/poll-once.mjs            # all due
 *   node scripts/poll-once.mjs --limit 50 # cap the batch
 */

import "dotenv/config";
import { pollDue } from "../src/poller.js";
import { closeDb } from "../src/db.js";

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

async function main() {
  const limit = Number(arg("limit", 500));
  const concurrency = Number(
    arg("concurrency", process.env.POLL_CONCURRENCY || 12),
  );

  const t0 = Date.now();
  const { polled, summary, results } = await pollDue({ limit, concurrency });
  const elapsed = Date.now() - t0;

  if (!polled) {
    console.log("nothing due.");
    await closeDb();
    return;
  }

  console.log("──────────── poll ────────────");
  console.log(`  boards polled   ${String(polled).padStart(6)}`);
  console.log(
    `  wall clock      ${String((elapsed / 1000).toFixed(1) + "s").padStart(6)}`,
  );
  console.log(`  ok              ${String(summary.ok || 0).padStart(6)}`);
  console.log(
    `  304 not-mod     ${String(summary.not_modified || 0).padStart(6)}`,
  );
  console.log(`  burst           ${String(summary.burst || 0).padStart(6)}`);
  console.log(
    `  error           ${String((summary.error || 0) + (summary.throw || 0)).padStart(6)}`,
  );
  console.log(`  jobs inserted   ${String(summary.inserted).padStart(6)}`);
  console.log(`  passed screen   ${String(summary.screenedIn).padStart(6)}`);
  console.log(`  reposts flagged ${String(summary.reposts).padStart(6)}`);

  const matches = results.flatMap((r) => r.newJobs || []);
  if (matches.length) {
    console.log(`\n  first ${Math.min(20, matches.length)} matches:`);
    for (const j of matches.slice(0, 20)) {
      const fam = (j.screen.roleFamily || "?").toUpperCase().padEnd(4);
      const loc = (j.locations[0] || "—").slice(0, 24).padEnd(24);
      console.log(
        `    [${fam}] ${j.companyName.slice(0, 20).padEnd(20)} ${loc} ${j.title.slice(0, 58)}`,
      );
    }
  }

  const errs = results.filter(
    (r) => r.outcome === "error" || r.outcome === "throw",
  );
  if (errs.length) {
    console.log(`\n  ${errs.length} errors (first 5):`);
    for (const e of errs.slice(0, 5))
      console.log(`    ${e.company} — ${e.error || "http"}`);
  }

  await closeDb();
}

main().catch(async (err) => {
  console.error("[poll] fatal:", err);
  await closeDb();
  process.exit(1);
});
