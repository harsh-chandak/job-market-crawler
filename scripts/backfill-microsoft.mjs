/**
 * Fetch the descriptions the Microsoft search endpoint withholds.
 *
 *   node scripts/backfill-microsoft.mjs --dry-run
 *   node scripts/backfill-microsoft.mjs --limit 50
 *
 * Kept separate from backfill-smartrecruiters.mjs rather than merged into one
 * generic body-backfiller, because the two share only the loop. SmartRecruiters
 * also has an apply-URL to repair, has a conditional-GET path worth storing an
 * ETag for, and has a stale-row problem that dominates its candidate selection.
 * Microsoft has none of those: no ETag (`cache-control: no-store`), a correct
 * apply URL already, and only 35 rows. Folding them together would mean a
 * parameterised script whose branches are longer than either version.
 *
 * The volume here is small and the reason is worth stating: Microsoft is polled
 * as five keyword pseudo-boards capped at five pages of ten, so the corpus is 35
 * rows, not the ~700 the search reports for "software engineer" alone. Raising
 * MICROSOFT_MAX_PAGES would widen it — that is a separate call about poll cost,
 * not about hydration.
 *
 * Re-screens and re-ranks each row for the same reason stageHydrate does: the
 * first screen ran against an empty body, so work authorisation and
 * years-of-experience could only answer 'unknown'.
 */

import "dotenv/config";
import { getDb, closeDb } from "../src/db.js";
import { hydrateMicrosoft } from "../src/adapters/microsoft.js";
import { screen } from "../src/filter.js";
import { prerank } from "../src/prerank.js";

const arg = (n, d) => {
  const i = process.argv.indexOf(`--${n}`);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : d;
};
const DRY = process.argv.includes("--dry-run");
const INCLUDE_STALE = process.argv.includes("--include-stale");
const LIMIT = Number(arg("limit", 500));
const DELAY_MS = Number(arg("delay", 150));
const MIN_BODY = 400;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const db = await getDb();
const jobs = db.collection("jobs");
const companies = db.collection("companies");

const q = {
  ats: "microsoft",
  hydrateFailed: { $ne: true },
  $expr: { $lte: [{ $strLenCP: { $ifNull: ["$description", ""] } }, MIN_BODY] },
};
if (!INCLUDE_STALE) q.status = "new";

const rows = await jobs
  .find(q)
  .sort({ postedAtClaimed: -1 })
  .limit(LIMIT)
  .toArray();

console.log(
  `microsoft hydrate: ${rows.length} rows${INCLUDE_STALE ? " (--include-stale)" : " (status=new)"}`,
);

let ok = 0,
  short = 0,
  gone = 0,
  failed = 0,
  screenedOut = 0;

for (const job of rows) {
  const company = await companies.findOne({
    ats: "microsoft",
    token: job.companyToken,
  });
  const r = await hydrateMicrosoft(job, company, { timeout: 20_000 });

  if (r.status === "gone") {
    gone++;
    console.log(`  404  ${job.sourceJobId} ${job.title}`);
    if (!DRY)
      await jobs.updateOne(
        { _id: job._id },
        { $set: { status: "closed", closedDetectedAt: new Date() } },
      );
    await sleep(DELAY_MS);
    continue;
  }

  if (r.status !== "ok" || r.description.length <= MIN_BODY) {
    if (r.status === "ok") short++;
    else failed++;
    if (!DRY)
      await jobs.updateOne(
        { _id: job._id },
        {
          $set: {
            hydrateFailed: true,
            hydrateError:
              r.status === "ok"
                ? `short_body_${r.description.length}`
                : r.error || r.status,
          },
        },
      );
    await sleep(DELAY_MS);
    continue;
  }

  const withBody = { ...job, description: r.description };
  const sc = screen(withBody);
  if (!sc.pass) screenedOut++;

  if (!DRY)
    await jobs.updateOne(
      { _id: job._id },
      {
        $set: {
          description: r.description,
          hydratedAt: new Date(),
          screen: sc,
          prerank: prerank(withBody, company || {}),
          ...(sc.pass ? {} : { status: "screened_out" }),
        },
      },
    );

  ok++;
  console.log(
    `  ok   ${String(r.description.length).padStart(5)}c  ` +
      `${sc.pass ? "pass" : "SCREENED_OUT"}  ${job.title.slice(0, 58)}`,
  );
  await sleep(DELAY_MS);
}

console.log(
  `\n${DRY ? "[dry-run] " : ""}hydrated ${ok} | short ${short} | 404 ${gone} | failed ${failed}` +
    `\n  of the ${ok} hydrated, ${ok - screenedOut} passed the re-screen and are now scoreable`,
);

await closeDb();
