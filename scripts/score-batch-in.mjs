/**
 * Ingest manually-produced scores from scores.json and write them to Mongo.
 *
 *   node scripts/score-batch-in.mjs
 *
 * Expects [{id, fit, family, verdict, reasons[], matched[], gaps[]}]. Validated
 * against the same shape the LLM scorer emits, and tagged `scoredBy` so a
 * hand-scored row is never mistaken for a model-scored one later.
 */
import "dotenv/config";
import { readFileSync } from "node:fs";
import { ObjectId } from "mongodb";
import { getDb, closeDb } from "../src/db.js";

const rows = JSON.parse(readFileSync("scores.json", "utf8"));
const db = await getDb();
const jobs = db.collection("jobs");

const bad = [];
const ops = [];
for (const r of rows) {
  if (!r.id || typeof r.fit !== "number" || r.fit < 0 || r.fit > 100) { bad.push(r.id || "?"); continue; }
  if (!["strong", "good", "stretch", "poor"].includes(r.verdict)) { bad.push(r.id); continue; }
  ops.push({ updateOne: { filter: { _id: new ObjectId(r.id) }, update: { $set: {
    llmScore: { fit: r.fit, family: r.family, verdict: r.verdict,
      reasons: r.reasons || [], matched: r.matched || [], gaps: r.gaps || [] },
    llmScoredAt: new Date(), scoredBy: "claude-code-session",
  } } } });
}
if (ops.length) await jobs.bulkWrite(ops, { ordered: false });
console.log(`wrote ${ops.length} scores${bad.length ? ` · ${bad.length} rejected` : ""}`);
const left = await jobs.countDocuments({ status: "new", llmScore: { $exists: false }, "screen.roleFamily": { $ne: null },
  $expr: { $gt: [{ $strLenCP: { $ifNull: ["$description", ""] } }, 400] } });
console.log(`remaining unscored: ${left}`);
await closeDb();
