/**
 * Pipeline health + the latency SLA.
 *
 * Detection latency is the one number that matters and the only one we control.
 * Applicant rank is unobservable — no ATS exposes it — so we measure
 * `firstSeenAt - postedAtClaimed` and drive that down.
 *
 * Caveat, stated in the output: on the first full sweep every job looks
 * "late" because we're ingesting a backlog that has been open for weeks.
 * Only postings discovered after a board's first successful poll are real
 * latency samples.
 */

import "dotenv/config";
import { getDb, closeDb } from "../src/db.js";

function pct(sorted, p) {
  if (!sorted.length) return null;
  const i = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[i];
}

function human(ms) {
  if (ms == null) return "—";
  const s = ms / 1000;
  if (s < 90) return `${s.toFixed(0)}s`;
  const m = s / 60;
  if (m < 90) return `${m.toFixed(0)}m`;
  const h = m / 60;
  if (h < 48) return `${h.toFixed(1)}h`;
  return `${(h / 24).toFixed(1)}d`;
}

async function main() {
  const db = await getDb();
  const companies = db.collection("companies");
  const jobs = db.collection("jobs");
  const pollLog = db.collection("poll_log");

  /* ---- coverage ---- */
  const total = await companies.countDocuments({});
  const polled = await companies.countDocuments({
    lastPolledAt: { $ne: null },
  });
  const erroring = await companies.countDocuments({
    consecutiveErrors: { $gte: 1 },
  });
  const dead = await companies.countDocuments({
    consecutiveErrors: { $gte: 3 },
  });

  const tiers = await companies
    .aggregate([
      { $group: { _id: "$tier", n: { $sum: 1 } } },
      { $sort: { _id: 1 } },
    ])
    .toArray();
  const byAts = await companies
    .aggregate([
      { $group: { _id: "$ats", n: { $sum: 1 } } },
      { $sort: { n: -1 } },
    ])
    .toArray();

  console.log("════════════ coverage ════════════");
  console.log(`  boards tracked      ${String(total).padStart(6)}`);
  console.log(
    `  polled at least 1x  ${String(polled).padStart(6)}  (${((polled / total) * 100).toFixed(0)}%)`,
  );
  console.log(`  currently erroring  ${String(erroring).padStart(6)}`);
  console.log(`  cold (3+ errors)    ${String(dead).padStart(6)}`);
  console.log(
    `  tiers               ${tiers.map((t) => `${t._id}:${t.n}`).join("  ")}`,
  );
  console.log(
    `  by ats              ${byAts.map((t) => `${t._id}:${t.n}`).join("  ")}`,
  );

  /* ---- inventory ---- */
  const jobsTotal = await jobs.countDocuments({});
  const matches = await jobs.countDocuments({ status: "new" });
  const reposts = await jobs.countDocuments({ isRepost: true });
  const phoenix = await jobs.countDocuments({
    "screen.location.phoenix": true,
  });
  const famAgg = await jobs
    .aggregate([
      { $match: { status: "new" } },
      { $group: { _id: "$screen.roleFamily", n: { $sum: 1 } } },
      { $sort: { n: -1 } },
    ])
    .toArray();
  const authAgg = await jobs
    .aggregate([
      { $match: { status: "new" } },
      { $group: { _id: "$screen.workAuth", n: { $sum: 1 } } },
      { $sort: { n: -1 } },
    ])
    .toArray();

  console.log("\n════════════ inventory ═══════════");
  console.log(
    `  jobs stored         ${String(jobsTotal).padStart(6)}   (only screen-passers are persisted)`,
  );
  console.log(`  matches             ${String(matches).padStart(6)}`);
  console.log(
    `  reposts flagged     ${String(reposts).padStart(6)}   (stale req wearing a fresh date)`,
  );
  console.log(`  phoenix metro       ${String(phoenix).padStart(6)}`);
  console.log(
    `  by role family      ${famAgg.map((f) => `${f._id}:${f.n}`).join("  ")}`,
  );
  console.log(
    `  by work auth        ${authAgg.map((f) => `${f._id}:${f.n}`).join("  ")}`,
  );

  /* ---- latency ---- */
  // Exclude the initial backlog: only count jobs first seen AFTER their board's
  // first successful poll, which is when we could plausibly have caught them fresh.
  const withLag = await jobs
    .find(
      { claimedLagMs: { $ne: null, $gte: 0 } },
      {
        projection: {
          claimedLagMs: 1,
          firstSeenAt: 1,
          companyToken: 1,
          ats: 1,
          title: 1,
          companyName: 1,
        },
      },
    )
    .toArray();
  // A board's own first sweep ingests a backlog that has been open for weeks —
  // those are not latency samples. Real samples are postings that appeared
  // AFTER we had already seen that board at least once.
  const firstIngest = await jobs
    .aggregate([
      {
        $group: {
          _id: { ats: "$ats", token: "$companyToken" },
          firstIngestAt: { $min: "$firstSeenAt" },
        },
      },
    ])
    .toArray();
  const firstIngestBy = new Map(
    firstIngest.map((f) => [
      `${f._id.ats}:${f._id.token}`,
      new Date(f.firstIngestAt).getTime(),
    ]),
  );

  const GRACE_MS = 60_000; // jobs from the same sweep share a timestamp
  const incremental = withLag.filter((j) => {
    const base = firstIngestBy.get(`${j.ats}:${j.companyToken}`);
    return base != null && new Date(j.firstSeenAt).getTime() > base + GRACE_MS;
  });
  const backlog = withLag.length - incremental.length;

  const lags = incremental.map((j) => j.claimedLagMs).sort((a, b) => a - b);

  console.log("\n════════════ latency ═════════════");
  console.log(
    `  samples w/ claimed date  ${String(withLag.length).padStart(6)}`,
  );
  console.log(
    `  ├─ board backlog         ${String(backlog).padStart(6)}   ← that board's first sweep`,
  );
  console.log(`  └─ incremental samples   ${String(lags.length).padStart(6)}`);
  if (lags.length) {
    console.log(`\n  detection lag (firstSeenAt − board's claimed post date):`);
    console.log(`    P50   ${human(pct(lags, 50))}`);
    console.log(`    P90   ${human(pct(lags, 90))}`);
    console.log(`    P99   ${human(pct(lags, 99))}`);
    console.log(`    best  ${human(lags[0])}`);
  } else {
    console.log(
      "\n  no incremental samples yet — run the poller on a loop and",
    );
    console.log("  check back once boards have posted something new.");
  }

  /* ---- poll economics ---- */
  const recent = await pollLog
    .aggregate([
      {
        $match: {
          startedAt: { $gte: new Date(Date.now() - 24 * 60 * 60 * 1000) },
        },
      },
      {
        $group: {
          _id: "$outcome",
          n: { $sum: 1 },
          avgMs: { $avg: "$elapsedMs" },
        },
      },
      { $sort: { n: -1 } },
    ])
    .toArray();
  const totalPolls = recent.reduce((a, r) => a + r.n, 0);
  const notMod = recent.find((r) => r._id === "not_modified")?.n || 0;

  console.log("\n════════════ poll economics (24h) ═");
  console.log(`  polls               ${String(totalPolls).padStart(6)}`);
  for (const r of recent) {
    console.log(
      `    ${String(r._id).padEnd(16)} ${String(r.n).padStart(6)}   avg ${r.avgMs?.toFixed(0)}ms`,
    );
  }
  if (totalPolls) {
    console.log(
      `  304 rate            ${((notMod / totalPolls) * 100).toFixed(0)}%   ← higher is cheaper`,
    );
  }

  await closeDb();
}

main().catch(async (err) => {
  console.error("[stats] fatal:", err);
  await closeDb();
  process.exit(1);
});
