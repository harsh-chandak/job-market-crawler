/**
 * Re-run the deterministic screen over every stored job.
 * Use after changing filter rules — no refetch, no network.
 *   node scripts/rescreen.mjs
 */

import "dotenv/config";
import { getDb, closeDb } from "../src/db.js";
import { screen } from "../src/filter.js";

async function main() {
  const db = await getDb();
  const jobs = db.collection("jobs");
  const total = await jobs.countDocuments({});
  console.log(`rescreening ${total} jobs…`);

  const cursor = jobs.find(
    {},
    { projection: { title: 1, description: 1, locations: 1 } },
  );
  let ops = [];
  let done = 0;
  let passed = 0;
  const reasonCounts = new Map();
  const familyCounts = new Map();

  async function flush() {
    if (!ops.length) return;
    await jobs.bulkWrite(ops, { ordered: false });
    ops = [];
  }

  for await (const j of cursor) {
    const v = screen({
      title: j.title,
      description: j.description,
      locations: j.locations,
    });
    if (v.pass) {
      passed++;
      familyCounts.set(v.roleFamily, (familyCounts.get(v.roleFamily) || 0) + 1);
    } else {
      for (const r of v.reasons) {
        const key = r.split(":")[0];
        reasonCounts.set(key, (reasonCounts.get(key) || 0) + 1);
      }
    }
    ops.push({
      updateOne: {
        filter: { _id: j._id },
        update: {
          $set: { screen: v, status: v.pass ? "new" : "screened_out" },
        },
      },
    });
    if (ops.length >= 500) await flush();
    if (++done % 5000 === 0) process.stdout.write(`\r  ${done}/${total}`);
  }
  await flush();
  process.stdout.write("\r");

  console.log("\n──────────── rescreen ────────────");
  console.log(`  total jobs        ${String(total).padStart(6)}`);
  console.log(
    `  passed screen     ${String(passed).padStart(6)}  (${((passed / total) * 100).toFixed(1)}%)`,
  );
  console.log("\n  rejection reasons:");
  for (const [r, n] of [...reasonCounts].sort((a, b) => b[1] - a[1])) {
    console.log(`    ${r.padEnd(20)} ${String(n).padStart(6)}`);
  }
  console.log("\n  passing by role family:");
  for (const [f, n] of [...familyCounts].sort((a, b) => b[1] - a[1])) {
    console.log(`    ${String(f).padEnd(20)} ${String(n).padStart(6)}`);
  }

  await closeDb();
}

main().catch(async (err) => {
  console.error("[rescreen] fatal:", err);
  await closeDb();
  process.exit(1);
});
