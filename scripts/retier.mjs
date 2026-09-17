/**
 * Assign polling tiers from observed data.
 *
 * A board earns tier S by actually posting roles that clear the screen — not
 * because someone guessed it was important. Run after a full sweep, then
 * periodically (weekly) as the evidence changes.
 *
 *   S  every 3m   boards that repeatedly post roles we'd apply to
 *   A  every 15m  boards that have posted at least one
 *   B  every 1h   live boards with roles, none matching yet
 *   C  every 6h   everything else / chronically erroring
 */

import "dotenv/config";
import { getDb, closeDb } from "../src/db.js";

const MAX_TIER_S = Number(process.env.MAX_TIER_S || 150);
const MAX_TIER_A = Number(process.env.MAX_TIER_A || 400);

async function main() {
  const db = await getDb();
  const companies = db.collection("companies");
  const jobs = db.collection("jobs");

  // How many screen-passing roles has each board produced?
  const hits = await jobs
    .aggregate([
      { $match: { status: "new" } },
      {
        $group: {
          _id: { ats: "$ats", token: "$companyToken" },
          matches: { $sum: 1 },
          phoenix: { $sum: { $cond: ["$screen.location.phoenix", 1, 0] } },
          lastMatchAt: { $max: "$firstSeenAt" },
        },
      },
      { $sort: { matches: -1 } },
    ])
    .toArray();

  const scored = hits.map((h) => ({
    ats: h._id.ats,
    token: h._id.token,
    // A local match is worth more: Phoenix roles are rarer and higher-signal.
    score: h.matches + h.phoenix * 5,
    matches: h.matches,
    phoenix: h.phoenix,
    lastMatchAt: h.lastMatchAt,
  }));
  scored.sort((a, b) => b.score - a.score);

  const tierOf = new Map();
  scored.forEach((s, i) => {
    if (i < MAX_TIER_S && s.matches >= 2)
      tierOf.set(`${s.ats}:${s.token}`, "S");
    else if (i < MAX_TIER_A || s.matches >= 1)
      tierOf.set(`${s.ats}:${s.token}`, "A");
    else tierOf.set(`${s.ats}:${s.token}`, "B");
  });

  const all = await companies
    .find(
      {},
      {
        projection: {
          ats: 1,
          token: 1,
          openRoles: 1,
          consecutiveErrors: 1,
          tier: 1,
          isTarget: 1,
        },
      },
    )
    .toArray();

  const ops = [];
  const counts = { S: 0, A: 0, B: 0, C: 0 };
  for (const c of all) {
    const key = `${c.ats}:${c.token}`;
    let tier = tierOf.get(key) || "C";
    // Pinned targets keep tier S regardless of observed match history. A big
    // employer that posted nothing last month can still be the one posting the
    // two new-grad reqs that matter tomorrow — demoting it on past volume is
    // exactly backwards for a freshness-driven pipeline.
    if (c.isTarget) tier = "S";
    // Chronically broken boards go cold regardless of history — but a pinned
    // target that is erroring is a bug to fix, not a board to forget.
    if (!c.isTarget && (c.consecutiveErrors || 0) >= 3) tier = "C";
    // A board with zero open roles isn't worth 3-minute attention — unless it is
    // a pinned target, where an empty board is the state immediately BEFORE the
    // posting we are waiting for. Demoting on emptiness guarantees we are slow
    // on exactly the reqs this list exists to catch.
    if (!c.isTarget && tier === "S" && (c.openRoles ?? 0) === 0) tier = "A";

    counts[tier]++;
    if (tier !== c.tier) {
      const RANK = { S: 0, A: 1, B: 2, C: 3 };
      const update = { tier };
      // A promotion has to take effect now. Without this the board keeps the
      // timer from its old, slower tier — a board promoted to S would sit idle
      // for up to 6 hours before its first 3-minute poll.
      if (RANK[tier] < RANK[c.tier ?? "C"]) update.nextPollAt = new Date();
      ops.push({ updateOne: { filter: { _id: c._id }, update: { $set: update } } });
    }
  }

  for (let i = 0; i < ops.length; i += 500) {
    await companies.bulkWrite(ops.slice(i, i + 500), { ordered: false });
  }

  console.log("──────────── retier ────────────");
  console.log(`  boards changed tier ${String(ops.length).padStart(5)}`);
  for (const t of ["S", "A", "B", "C"]) {
    console.log(`  tier ${t}              ${String(counts[t]).padStart(5)}`);
  }

  // Sanity-check the resulting request rate.
  const perMin =
    counts.S / Number(process.env.TIER_S_MINUTES || 3) +
    counts.A / Number(process.env.TIER_A_MINUTES || 15) +
    counts.B / Number(process.env.TIER_B_MINUTES || 60) +
    counts.C / Number(process.env.TIER_C_MINUTES || 360);
  console.log(
    `\n  steady-state load   ${perMin.toFixed(1)} polls/min (${(perMin / 60).toFixed(2)}/sec)`,
  );
  console.log("  most return 304 with no body.");

  console.log("\n  top 15 boards by match score:");
  for (const s of scored.slice(0, 15)) {
    const phx = s.phoenix ? ` +${s.phoenix} PHX` : "";
    console.log(
      `    ${String(s.matches).padStart(4)} matches${phx.padEnd(9)} ${s.ats.padEnd(16)} ${s.token}`,
    );
  }

  await closeDb();
}

main().catch(async (err) => {
  console.error("[retier] fatal:", err);
  await closeDb();
  process.exit(1);
});
