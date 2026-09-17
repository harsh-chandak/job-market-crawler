/**
 * Rank matches into an actionable shortlist.
 *
 *   node scripts/shortlist.mjs [--limit 40] [--family swe|ai|fde] [--phx]
 *
 * Joins each job's company-level sponsorship signal onto the posting and scores
 * them. Deliberately deterministic — no LLM yet. This is the input the scoring
 * and tailoring stages will consume, and it's already useful on its own.
 *
 * Weighting reflects one specific person's constraints: on post-completion OPT,
 * will need H-1B, STEM-extension eligible. So sponsorship evidence outranks
 * almost everything else, and cap-exempt employers rank highest of all because
 * they file year-round with no lottery.
 */

import "dotenv/config";
import { getDb, closeDb } from "../src/db.js";

const WEIGHTS = {
  sponsorship: { cap_exempt: 45, strong: 40, yes: 25, none: 0 },
  eVerifyKnown: 15, // STEM OPT extension requires an E-Verify employer
  workAuth: { positive: 15, unknown: 0, restricted: -20, blocked: -1000 },
  phoenix: 10,
  repost: -25,
  staffing: -60, // body shops sponsor at volume; that is not a signal for us
  freshnessMax: 20, // decays to 0 over 14 days
};

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const next = process.argv[i + 1];
  return next && !next.startsWith("--") ? next : true;
}

function freshnessPoints(firstSeenAt) {
  const ageDays = (Date.now() - new Date(firstSeenAt).getTime()) / 86_400_000;
  if (ageDays <= 0) return WEIGHTS.freshnessMax;
  if (ageDays >= 14) return 0;
  return Math.round(WEIGHTS.freshnessMax * (1 - ageDays / 14));
}

function scoreJob(job, sponsorship) {
  const parts = [];
  let score = 0;

  const sp = sponsorship?.status || "none";
  const spPts = WEIGHTS.sponsorship[sp] ?? 0;
  score += spPts;
  if (spPts) parts.push(`${sp}(+${spPts})`);

  if (sponsorship?.eVerify === true) {
    score += WEIGHTS.eVerifyKnown;
    parts.push(`e-verify(+${WEIGHTS.eVerifyKnown})`);
  }

  const wa = job.screen?.workAuth || "unknown";
  const waPts = WEIGHTS.workAuth[wa] ?? 0;
  score += waPts;
  if (waPts) parts.push(`jd:${wa}(${waPts > 0 ? "+" : ""}${waPts})`);

  if (job.screen?.location?.phoenix) {
    score += WEIGHTS.phoenix;
    parts.push(`phx(+${WEIGHTS.phoenix})`);
  }
  if (job.isRepost) {
    score += WEIGHTS.repost;
    parts.push(`repost(${WEIGHTS.repost})`);
  }

  if (sponsorship?.staffing) {
    score += WEIGHTS.staffing;
    parts.push(`staffing(${WEIGHTS.staffing})`);
  }

  // Tie-break by sponsorship volume, log-scaled and capped so a mega-sponsor
  // can't outrank a genuinely better-fitting role at a smaller company.
  const approvals = sponsorship?.h1bApprovals || 0;
  if (approvals > 0) {
    const bonus = Math.min(8, Math.round(Math.log10(approvals + 1) * 3));
    score += bonus;
    parts.push(`vol(+${bonus})`);
  }

  const fresh = freshnessPoints(job.firstSeenAt);
  score += fresh;
  if (fresh) parts.push(`fresh(+${fresh})`);

  return { score, parts };
}

async function main() {
  const limit = Number(arg("limit", 40));
  const family = arg("family");
  const phxOnly = arg("phx") === true;

  const db = await getDb();

  const companies = await db
    .collection("companies")
    .find(
      { enabled: { $ne: false } },
      { projection: { ats: 1, token: 1, sponsorship: 1, tier: 1 } },
    )
    .toArray();
  const spBy = new Map(
    companies.map((c) => [`${c.ats}:${c.token}`, c.sponsorship]),
  );
  const enabled = new Set(companies.map((c) => `${c.ats}:${c.token}`));

  const q = { status: "new" };
  if (family) q["screen.roleFamily"] = family;
  if (phxOnly) q["screen.location.phoenix"] = true;

  const jobs = await db.collection("jobs").find(q).toArray();

  const ranked = jobs
    .filter((j) => enabled.has(`${j.ats}:${j.companyToken}`))
    .map((j) => {
      const sponsorship = spBy.get(`${j.ats}:${j.companyToken}`);
      const { score, parts } = scoreJob(j, sponsorship);
      return { job: j, sponsorship, score, parts };
    })
    .sort((a, b) => b.score - a.score);

  // Collapse the same role posted across many locations into one row.
  const seenCluster = new Set();
  const deduped = [];
  for (const r of ranked) {
    if (seenCluster.has(r.job.clusterKey)) continue;
    seenCluster.add(r.job.clusterKey);
    deduped.push(r);
  }

  console.log("──────────── shortlist ────────────");
  console.log(`  candidates          ${String(jobs.length).padStart(6)}`);
  console.log(`  after cluster-dedup ${String(deduped.length).padStart(6)}`);
  if (family) console.log(`  family filter       ${family}`);
  if (phxOnly) console.log("  phoenix only");

  const dist = deduped.reduce((a, r) => {
    const s = r.sponsorship?.status || "none";
    a[s] = (a[s] || 0) + 1;
    return a;
  }, {});
  console.log(
    `  sponsorship mix     ${Object.entries(dist)
      .map(([k, v]) => `${k}:${v}`)
      .join("  ")}`,
  );

  console.log(`\n  top ${Math.min(limit, deduped.length)}:\n`);
  for (const r of deduped.slice(0, limit)) {
    const j = r.job;
    const fam = (j.screen.roleFamily || "?").toUpperCase().padEnd(3);
    const loc = (j.locations[0] || "n/a").slice(0, 22).padEnd(22);
    const co = j.companyName.slice(0, 18).padEnd(18);
    console.log(
      `  ${String(r.score).padStart(4)}  [${fam}] ${co} ${loc} ${j.title.slice(0, 46)}`,
    );
    console.log(`        ${r.parts.join(" ")}`);
    console.log(`        ${j.applyUrl}`);
  }

  await closeDb();
}

main().catch(async (err) => {
  console.error("[shortlist] fatal:", err);
  await closeDb();
  process.exit(1);
});
