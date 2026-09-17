/**
 * Dump the next unscored batch, highest pre-rank first, for manual scoring.
 *
 *   node scripts/score-batch-out.mjs [--n 25] [--chars 900]
 *
 * Pairs with score-batch-in.mjs. Exists because the hosted free tier caps at
 * ~50 scores/day against a multi-thousand-job backlog; this lets a scoring pass
 * run out-of-band without touching the live loop's quota.
 */
import "dotenv/config";
import { writeFileSync } from "node:fs";
import { getDb, closeDb } from "../src/db.js";

const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i > -1 && process.argv[i+1] ? process.argv[i+1] : d; };
const N = Number(arg("n", 25));
const CHARS = Number(arg("chars", 900));

const db = await getDb();
const batch = await db.collection("jobs").find({
  status: "new",
  llmScore: { $exists: false },
  "screen.roleFamily": { $ne: null },
  $expr: { $gt: [{ $strLenCP: { $ifNull: ["$description", ""] } }, 400] },
}, { projection: { title: 1, companyName: 1, companyToken: 1, locations: 1, description: 1, prerank: 1 } })
  .sort({ "prerank.score": -1, firstSeenAt: -1 })
  .limit(N)
  .toArray();

const out = batch.map((j) => ({
  id: j._id.toString(),
  title: j.title,
  company: j.companyName || j.companyToken,
  loc: (j.locations || []).slice(0, 2).join(" / "),
  pre: j.prerank?.score,
  jd: String(j.description || "").replace(/\s+/g, " ").slice(0, CHARS),
}));

writeFileSync("batch.json", JSON.stringify(out, null, 1));
console.log(`wrote batch.json — ${out.length} jobs, prerank ${out.at(-1)?.pre}..${out[0]?.pre}`);
await closeDb();
