/**
 * One screen: what is worth doing right now.
 *
 *   node scripts/today.mjs
 *
 * The funnel says the constraint is no longer finding jobs — 357 clear the bar and
 * 233 of them are unreviewed. It is knowing which of the seven launchers to open,
 * and that answer changes hourly. Everything here is a count already in the
 * database; nothing calls a model.
 */
import "dotenv/config";
import { existsSync, readFileSync } from "node:fs";
import { loopStatus } from "../src/lockfile.js";
import { getDb, closeDb } from "../src/db.js";

const db = await getDb();
const j = db.collection("jobs");
const co = db.collection("companies");
const n = (q) => j.countDocuments(q);
const MIN_FIT = Number(process.env.MIN_FIT || 70);
const h = (x) => new Date(Date.now() - x * 3600_000);

const undecided = { status: "new", decision: { $exists: false }, "llmScore.fit": { $gte: MIN_FIT } };

/**
 * "New today" is measured on OUR clock.
 *
 * This counted postedAtClaimed within 24h. That is the board's own date, and
 * src/poller.js:5-7 calls firstSeenAt "OUR clock and the only freshness ground
 * truth" for a reason — measured median claimed lag is 138 days on Ashby, 377 on
 * Lever, 2,493 on SmartRecruiters. A posting ingested ten minutes ago whose board
 * dates it three weeks back did not count as new, so the brief could report
 * nothing arrived on a day the poller found plenty and route the user away from
 * the review page. Both numbers are now computed; the honest one drives the
 * recommendation and the board's is shown only when the two disagree.
 */
const [
  pending, freshSeen, freshClaimed, queued, manual, needAccount,
  unscored, stubs, submittedToday, submittedAll, scored24, matched24,
] = await Promise.all([
  n(undecided),
  n({ ...undecided, firstSeenAt: { $gte: h(24) } }),
  n({ ...undecided, postedAtClaimed: { $gte: h(24) } }),
  n({ decision: "approved", submitStatus: "queued" }),
  n({ decision: "approved", submitStatus: { $in: ["failed_no_form", "failed_error", "needs_manual_captcha", "error_giving_up"] } }),
  n({ decision: "approved", submitStatus: "needs_manual_account" }),
  n({ status: "new", llmScore: { $exists: false }, "prerank.score": { $gte: 55 }, $expr: { $gt: [{ $strLenCP: { $ifNull: ["$description", ""] } }, 400] } }),
  n({ status: "new", llmScore: { $exists: false }, $expr: { $lte: [{ $strLenCP: { $ifNull: ["$description", ""] } }, 400] } }),
  n({ submitStatus: "submitted", submitAttemptAt: { $gte: h(24) } }),
  n({ submitStatus: "submitted" }),
    n({ llmScoredAt: { $gte: h(24) } }),
    n({ llmScoredAt: { $gte: h(24) }, "llmScore.fit": { $gte: MIN_FIT } }),
]);

/**
 * The visa split of the review queue.
 *
 * This is the one property that decides whether a row deserves any attention at
 * all — the candidate needs H-1B sponsorship, so an employer with no federal
 * record is a different proposition from one with 25 approvals — and the brief
 * said nothing about it. classifySponsorship emits 'strong', 'yes', 'cap_exempt'
 * and 'none'; anything else means the company was never enriched.
 */
const undecidedKeys = await j
  .find(undecided, { projection: { ats: 1, companyToken: 1 } })
  .toArray();
const keySet = [...new Set(undecidedKeys.map((r) => `${r.ats}:${r.companyToken}`))];
const cos = keySet.length
  ? await co
      .find(
        { $or: keySet.map((k) => ({ ats: k.split(":")[0], token: k.split(":").slice(1).join(":") })) },
        { projection: { ats: 1, token: 1, sponsorship: 1 } },
      )
      .toArray()
  : [];
const spBy = new Map(cos.map((c) => [`${c.ats}:${c.token}`, c.sponsorship?.status ?? null]));
const visaSplit = { sponsors: 0, sponsoredOnce: 0, noRecord: 0, unchecked: 0 };
for (const r of undecidedKeys) {
  const s = spBy.get(`${r.ats}:${r.companyToken}`);
  if (s === "strong" || s === "cap_exempt") visaSplit.sponsors++;
  else if (s === "yes") visaSplit.sponsoredOnce++;
  else if (s === "none") visaSplit.noRecord++;
  else visaSplit.unchecked++;
}
// The STEM OPT extension requires an E-Verify employer. enrich-sponsorship only
// fills this when data/everify.csv is present, and it never has been, so the gate
// has never once been evaluated — a fact worth stating rather than leaving as an
// absence nobody notices.
const eVerifyKnown = await co.countDocuments({ "sponsorship.eVerify": { $ne: null } });

/**
 * Is the loop actually running?
 *
 * Testing that the lockfile EXISTS is not the same question. run.mjs writes its
 * pid there and removes it on a clean exit, but a terminal closed mid-run leaves
 * the file behind — so this reported "polling loop running" while pgrep found no
 * process at all, which is the precise shape of false green this brief exists to
 * hunt. Read the pid and signal it.
 */
const loop = loopStatus();
const loopUp = loop.running;

const line = (s = "") => console.log(`  ${s}`);
console.log();
console.log("  ┌──────────────────────────────────────────────┐");
console.log("  │  TODAY                                       │");
console.log("  └──────────────────────────────────────────────┘");
console.log();

// Ordered by what actually moves an application forward, not by pipeline order.
const actions = [];
if (queued) actions.push([`${queued} application${queued > 1 ? "s" : ""} ready to send`, "open  3 — Apply With Me"]);
if (manual + needAccount)
  actions.push([`${manual + needAccount} need${manual + needAccount > 1 ? "" : "s"} applying by hand`, "open  7 — Apply By Hand"]);
if (freshSeen) actions.push([`${freshSeen} new match${freshSeen > 1 ? "es" : ""} found in the last 24h`, "open  5 — Review & Approve"]);
else if (pending) actions.push([`${pending} match${pending > 1 ? "es" : ""} waiting for a decision`, "open  5 — Review & Approve"]);
if (!loopUp) {
  // Name the reason. "not running" plus a stale lockfile is how a loop that died
  // hours ago goes unnoticed; "died N hours ago, lock left behind" does not.
  const ago = (ms) =>
    ms == null
      ? ""
      : ms < 3600_000
        ? `${Math.round(ms / 60000)}m ago`
        : ms < 86_400_000
          ? `${Math.round(ms / 3600_000)}h ago`
          : `${Math.round(ms / 86_400_000)}d ago`;
  const why =
    loop.reason === "dead"
      ? `stopped — it died around ${ago(loop.ageMs)}, leaving pid ${loop.pid}'s lock behind`
      : loop.reason === "pid_reused"
        ? `stopped — lock pid ${loop.pid} now belongs to another process`
        : loop.reason === "no_lock"
          ? "not running"
          : `not running (${loop.reason})`;
  actions.push([`the polling loop is ${why}`, "open  1 — Start Job Hunt"]);
}

if (!actions.length) line("Nothing waiting. The loop is running and the queue is clear.");
else
  actions.forEach(([what, how], i) => {
    line(`${i + 1}. ${what}`);
    line(`   ${how}`);
    line();
  });

console.log("  ──────────────────────────────────────────────");
line(`applications sent      ${submittedAll}${submittedToday ? `   (${submittedToday} in the last 24h)` : ""}`);
line(`matches undecided      ${pending}${freshSeen ? `   (${freshSeen} found today)` : ""}`);
if (freshClaimed !== freshSeen)
  line(`                       (boards claim ${freshClaimed} posted today — their dates run months behind, ours is the ${freshSeen})`);
line(`waiting to be scored   ${unscored}`);
  // Scored recently, so a productive loop is visibly different from a running one
  // that is achieving nothing. The field is llmScoredAt — I looked for lastScoredAt
  // while diagnosing this and got a confident zero from a name that does not exist,
  // which is the same trap as reading "loop running" off a stale lockfile.
  line(
    `scored in the last 24h ${String(scored24).padStart(3)}` +
      (scored24 ? `   (${matched24} reached fit ${MIN_FIT}+)` : "   ← loop is up but producing nothing"),
  );
if (stubs) line(`awaiting a description ${stubs}`);
line(
  `polling loop           ${loopUp ? `running (pid ${loop.pid})` : `STOPPED — ${loop.reason}`}`,
);
console.log();

// The visa gate, stated before anything else about the queue. A row from an
// employer with no H-1B record is not the same kind of row as one from an
// employer with a recent record at volume, and sorting the evening's work by that
// is the cheapest way to spend it well.
if (pending) {
  line("Of those undecided, by H-1B history:");
  line(`  ${String(visaSplit.sponsors).padStart(3)}  sponsor at volume or are cap-exempt   ← start here`);
  line(`  ${String(visaSplit.sponsoredOnce).padStart(3)}  sponsored at least once before`);
  line(`  ${String(visaSplit.noRecord).padStart(3)}  no USCIS record through FY2023`);
  if (visaSplit.unchecked) line(`  ${String(visaSplit.unchecked).padStart(3)}  employer never enriched`);
  console.log();
}

if (!eVerifyKnown) {
  line("! E-Verify is unknown for every employer. The STEM OPT extension requires");
  line("  an E-Verify employer, so this gate is currently unchecked — data/everify.csv");
  line("  is missing. Put the participating-employer list there and run");
  line("  scripts/enrich-sponsorship.mjs to close it.");
  console.log();
}

if (pending > 150) {
  line("The review queue is deep. Open the fast lane rather than the card page:");
  line("  http://localhost:7777/triage   j/k move · a apply · s skip · w why · r resume");
  line("It shows the best 3 per employer, so working through it does not mean");
  line("seeing 41 OpenAI roles in a row, and the bar at the bottom counts the");
  line("whole queue rather than the page.");
  console.log();
}

// The five worth looking at first, so the brief is actionable on its own. Ordered
// by when WE found them, for the same reason the counts above are.
const top = await j
  .find(undecided, { projection: { companyName: 1, companyToken: 1, title: 1, "llmScore.fit": 1, firstSeenAt: 1 } })
  .sort({ firstSeenAt: -1, "llmScore.fit": -1 })
  .limit(5)
  .toArray();
if (top.length) {
  line("Most recently found:");
  for (const t of top) {
    const age = t.firstSeenAt ? Math.round((Date.now() - new Date(t.firstSeenAt)) / 3600_000) : null;
    line(
      `  ${String(t.llmScore?.fit ?? "?").padStart(2)}  ${String(t.companyName || t.companyToken).slice(0, 16).padEnd(17)}${String(t.title).slice(0, 38)}${age !== null ? `  ${age}h` : ""}`,
    );
  }
  console.log();
}
await closeDb();
