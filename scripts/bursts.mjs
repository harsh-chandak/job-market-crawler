#!/usr/bin/env node
/**
 * Which boards are dropping roles right now. node scripts/bursts.mjs
 *
 * The loop logs "⚡ 2 board(s) burst-posting" as each one flips to the faster
 * cadence, which is a fact you cannot act on — it names no board, and a board
 * that flipped an hour ago never appears again even though it is still on 3m.
 * burstUntil lives on the company record; this reads it.
 *
 * No model, no network — one database query.
 */
import "dotenv/config";
import { getDb, closeDb } from "../src/db.js";

const db = await getDb();
const now = new Date();
const co = await db.collection("companies")
  .find({ burstUntil: { $gt: now } },
        { projection: { token: 1, ats: 1, tier: 1, burstUntil: 1, isTarget: 1 } })
  .toArray();

if (!co.length) {
  console.log("\n  No board is burst-posting right now.\n");
  await closeDb();
  process.exit(0);
}

// What each one actually dropped, so the list is evidence rather than a claim.
const since = new Date(Date.now() - 24 * 3600 * 1000);
const counts = new Map(
  (await db.collection("jobs").aggregate([
    { $match: { companyToken: { $in: co.map((c) => c.token) }, firstSeenAt: { $gte: since } } },
    { $group: { _id: "$companyToken", n: { $sum: 1 }, best: { $max: "$llmScore.fit" } } },
  ]).toArray()).map((r) => [r._id, r]),
);

co.sort((a, b) => (counts.get(b.token)?.n || 0) - (counts.get(a.token)?.n || 0));
console.log(`\n  ${co.length} board(s) on 3-minute cadence\n`);
console.log(`  ${"board".padEnd(26)}${"ats".padEnd(16)}tier  new/24h  best fit  burst ends`);
for (const c of co) {
  const k = counts.get(c.token);
  const mins = Math.round((new Date(c.burstUntil) - now) / 60000);
  const ends = mins > 90 ? `${Math.round(mins / 60)}h` : `${mins}m`;
  console.log(
    `  ${String(c.token).slice(0, 25).padEnd(26)}${String(c.ats).padEnd(16)}` +
    `${String(c.tier || "?").padEnd(6)}${String(k?.n ?? 0).padStart(6)}   ` +
    `${String(k?.best ?? "—").padStart(7)}   ${ends.padStart(8)}${c.isTarget ? "   ★ pinned" : ""}`,
  );
}
const total = [...counts.values()].reduce((a, r) => a + r.n, 0);
console.log(`\n  ${total} job(s) from these boards in the last 24h\n`);
await closeDb();
