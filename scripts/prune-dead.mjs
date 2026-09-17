/**
 * Remove postings that have closed since we surfaced them.
 *
 *   node scripts/prune-dead.mjs [--limit 200]     report
 *   node scripts/prune-dead.mjs --apply           mark them closed
 *
 * Checked against each ATS's own API, never by fetching the public page — see
 * src/liveness.js for why the page fetch cannot tell a closed job from a bot wall.
 * Only "dead" acts; "unknown" is left alone, so a flaky connection never bins a
 * live requisition.
 */
import "dotenv/config";
import { getDb, closeDb } from "../src/db.js";
import { checkLiveByAts, checkLive } from "../src/liveness.js";

const arg = (n, d) => {
  const i = process.argv.indexOf(`--${n}`);
  return i > -1 && process.argv[i + 1] ? Number(process.argv[i + 1]) : d;
};
const apply = process.argv.includes("--apply");
const LIMIT = arg("limit", 300);

const db = await getDb();
const jobs = db.collection("jobs");

const rows = await jobs
  .find(
    { status: "new", decision: { $exists: false }, "llmScore.fit": { $gte: Number(process.env.MIN_FIT || 70) } },
    { projection: { ats: 1, companyToken: 1, sourceJobId: 1, applyUrl: 1, title: 1, "llmScore.fit": 1 } },
  )
  .sort({ "llmScore.fit": -1 })
  .limit(LIMIT)
  .toArray();

console.log(`checking ${rows.length} undecided match(es)\n`);

const ashbyBoardCache = new Map();
const dead = [];
const unknown = [];
let live = 0;

for (const j of rows) {
  let r = await checkLiveByAts(j, { ashbyBoardCache });
  if (!r) r = await checkLive(j.applyUrl); // no API for this ATS
  if (r.state === "dead") {
    dead.push({ ...j, reason: r.reason });
    console.log(`  DEAD  fit ${String(j.llmScore?.fit).padStart(2)}  ${String(j.companyToken).slice(0, 15).padEnd(16)}${String(j.title).slice(0, 38)}   ${r.reason}`);
  } else if (r.state === "unknown") unknown.push({ ...j, reason: r.reason });
  else live++;
}

console.log(`\n  live ${live}   dead ${dead.length}   unknown ${unknown.length}`);
if (unknown.length) {
  const by = {};
  for (const u of unknown) by[u.reason] = (by[u.reason] || 0) + 1;
  console.log(`  unknown breakdown: ${JSON.stringify(by)}  (left alone on purpose)`);
}

if (!apply) {
  console.log("\ndry run — re-run with --apply");
  await closeDb();
  process.exit(0);
}
if (dead.length) {
  const r = await jobs.updateMany(
    { _id: { $in: dead.map((d) => d._id) } },
    { $set: { status: "closed", closedDetectedAt: new Date() } },
  );
  console.log(`\nmarked ${r.modifiedCount} closed`);
}
await closeDb();
