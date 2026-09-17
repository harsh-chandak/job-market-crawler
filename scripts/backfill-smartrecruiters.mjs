/**
 * Repair SmartRecruiters rows: fix the apply URL, then fetch the missing body.
 *
 *   node scripts/backfill-smartrecruiters.mjs --dry-run
 *   node scripts/backfill-smartrecruiters.mjs --limit 50
 *   node scripts/backfill-smartrecruiters.mjs --urls-only
 *   node scripts/backfill-smartrecruiters.mjs --include-stale     # see below
 *
 * TWO REPAIRS, DELIBERATELY DIFFERENT IN SCOPE.
 *
 * The apply-URL fix runs over EVERY SmartRecruiters row. All 334 of them stored
 * the API endpoint in `applyUrl` — `ref` is the only URL the list carries and it
 * is not an application form — so any of them that surfaces anywhere, in the
 * review queue or an export or a stale-row audit, sends the reviewer to raw
 * JSON. Recomputing it is pure string work, costs no HTTP, and cannot fail, so
 * there is no reason to restrict it.
 *
 * Hydration runs over a far smaller set, and this is where the coverage audit's
 * arithmetic needs correcting. "334 rows, ~88% recoverable, ~295 jobs unlocked"
 * counts documents, not opportunities. Bucketed by what the pipeline would
 * actually do with them:
 *
 *     status_stale        186   claimed age p50 3,313 days — nine years old
 *     board_disabled       46   staffing firms already switched off
 *     status_duplicate     75   collapsed into another row by clusterKey
 *     status_screened_out   1
 *     ACTIONABLE           26
 *
 * Twenty-six. Hydrating the other 308 would spend three minutes of HTTP and
 * then feed 300 dead rows to a scorer whose budget is the binding constraint,
 * to surface postings from 2016. --include-stale exists to make that choice
 * explicit rather than accidental; it is not the default and should stay that
 * way.
 *
 * So the backlog is small. The fix is still worth making, because the value is
 * forward-looking: 191 enabled SmartRecruiters boards keep polling, and from
 * here every posting they return arrives with a working link and a body the
 * scorer can read. The 26 rows are the down payment, not the return — and they
 * are not junk (Arista, ServiceNow, LinkedIn, Intuitive, AbbVie, LLNL,
 * NBCUniversal).
 *
 * Re-screens and re-ranks each hydrated row, for the reason stageHydrate does:
 * the first screen ran against an empty body, so work-authorisation and
 * years-of-experience could only answer 'unknown' and skill overlap scored zero.
 */

import "dotenv/config";
import { getDb, closeDb } from "../src/db.js";
import {
  hydrateSmartRecruiters,
  publicUrl,
} from "../src/adapters/smartrecruiters.js";
import { screen } from "../src/filter.js";
import { prerank } from "../src/prerank.js";
import { hostOf } from "../src/util/normalize.js";

const arg = (n, d) => {
  const i = process.argv.indexOf(`--${n}`);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : d;
};
const DRY = process.argv.includes("--dry-run");
const URLS_ONLY = process.argv.includes("--urls-only");
const INCLUDE_STALE = process.argv.includes("--include-stale");
const LIMIT = Number(arg("limit", 500));
// Measured at ~520ms/job serial with zero errors over 79 sequential calls, and
// no 429 in any burst test. The delay is politeness, not a measured necessity.
const DELAY_MS = Number(arg("delay", 120));
// The scorer's floor. A body under this is no better than no body at all, so a
// row that hydrates short is marked rather than left to be refetched forever.
const MIN_BODY = 400;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const db = await getDb();
const jobs = db.collection("jobs");
const companies = db.collection("companies");

/* ------------------------------------------------- 1. apply URL repair */

const broken = await jobs
  .find(
    { ats: "smartrecruiters", applyUrl: /api\.smartrecruiters\.com/ },
    { projection: { companyToken: 1, sourceJobId: 1, applyUrl: 1 } },
  )
  .toArray();

console.log(`apply-URL repair: ${broken.length} rows point at the API`);

let urlFixed = 0;
const urlOps = [];
for (const j of broken) {
  const url = publicUrl(j.companyToken, j.sourceJobId);
  if (!url) continue;
  urlOps.push({
    updateOne: {
      filter: { _id: j._id },
      update: { $set: { applyUrl: url, applyHost: hostOf(url) } },
    },
  });
  urlFixed++;
}
if (urlOps.length && !DRY) await jobs.bulkWrite(urlOps, { ordered: false });
console.log(
  `  ${DRY ? "would fix" : "fixed"} ${urlFixed} -> https://jobs.smartrecruiters.com/{company}/{id}`,
);
if (broken[0]) {
  console.log(`  e.g. ${broken[0].applyUrl}`);
  console.log(
    `    -> ${publicUrl(broken[0].companyToken, broken[0].sourceJobId)}`,
  );
}

if (URLS_ONLY) {
  await closeDb();
  process.exit(0);
}

/* ---------------------------------------------------- 2. hydrate bodies */

// Boards that were switched off (staffing firms, body shops) are excluded here
// rather than by re-running disable-staffing.mjs, which owns that decision and
// mutates 191 company rows as a side effect. This script only reads that state.
const liveTokens = new Set(
  (
    await companies
      .find(
        { ats: "smartrecruiters", enabled: { $ne: false } },
        { projection: { token: 1 } },
      )
      .toArray()
  ).map((c) => c.token),
);

const q = {
  ats: "smartrecruiters",
  hydrateFailed: { $ne: true },
  $expr: { $lte: [{ $strLenCP: { $ifNull: ["$description", ""] } }, MIN_BODY] },
};
if (!INCLUDE_STALE) q.status = "new";

const candidates = (await jobs.find(q).sort({ firstSeenAt: -1 }).toArray())
  .filter((j) => liveTokens.has(j.companyToken))
  .slice(0, LIMIT);

console.log(
  `\nhydrate: ${candidates.length} candidate rows` +
    `${INCLUDE_STALE ? " (--include-stale)" : " (status=new, enabled boards)"}`,
);

let ok = 0,
  short = 0,
  gone = 0,
  failed = 0,
  screenedOut = 0;

for (const job of candidates) {
  const company = await companies.findOne({
    ats: "smartrecruiters",
    token: job.companyToken,
  });
  const r = await hydrateSmartRecruiters(job, company, { timeout: 20_000 });

  if (r.status === "gone") {
    gone++;
    console.log(`  404  ${job.companyToken}/${job.sourceJobId} ${job.title}`);
    // A filled or pulled req is a closed posting, not a hydration fault. Retire
    // it so it leaves the queue instead of being retried every cycle.
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

  const set = {
    description: r.description,
    hydratedAt: new Date(),
    detailEtag: r.etag || null,
    screen: sc,
    prerank: prerank(withBody, company || {}),
    ...(sc.pass ? {} : { status: "screened_out" }),
  };
  // The detail payload carries the canonical slugged URL. Prefer it over the
  // constructed one now that we have paid for the call anyway.
  if (r.applyUrl) {
    set.applyUrl = r.applyUrl;
    set.applyHost = hostOf(r.applyUrl);
  }
  if (!DRY) await jobs.updateOne({ _id: job._id }, { $set: set });

  ok++;
  console.log(
    `  ok   ${String(r.description.length).padStart(5)}c  ` +
      `${sc.pass ? "pass" : "SCREENED_OUT"}  ${job.companyToken}/${job.title.slice(0, 46)}`,
  );
  await sleep(DELAY_MS);
}

console.log(
  `\n${DRY ? "[dry-run] " : ""}hydrated ${ok} | short ${short} | 404 ${gone} | failed ${failed}` +
    `\n  of the ${ok} hydrated, ${ok - screenedOut} passed the re-screen and are now scoreable`,
);

await closeDb();
