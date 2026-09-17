#!/usr/bin/env node
/**
 * Re-rank the whole corpus at the current PRERANK_VERSION in one pass.
 *
 * The loop's inline stage does 500 per cycle and only touches status:"new",
 * which converges new arrivals in a few cycles but leaves every scored, queued
 * or applied row frozen at whatever version ranked it. Those rows still sort on
 * the review page, so a stale pre-rank there means the page orders by a rule
 * that no longer exists.
 *
 * Pure computation — regex and arithmetic against text already in the database.
 * No model, no network.
 */
import "dotenv/config";
import { getDb, closeDb } from "../src/db.js";
import { prerank, PRERANK_VERSION } from "../src/prerank.js";

const db = await getDb();
const jobs = db.collection("jobs");
const companies = db.collection("companies");

const cos = new Map(
  (await companies.find({}, { projection: { ats: 1, token: 1, sponsorship: 1, isTarget: 1 } }).toArray())
    .map((c) => [`${c.ats}:${c.token}`, c]),
);
console.log(`  ${cos.size} companies loaded`);

const cursor = jobs.find(
  { "prerank.v": { $ne: PRERANK_VERSION } },
  { projection: { description: 1, title: 1, ats: 1, companyToken: 1, screen: 1, postedAtClaimed: 1, firstSeenAt: 1, locations: 1, isRepost: 1 } },
);

let batch = [], done = 0, penalised = 0;
const flush = async () => {
  if (!batch.length) return;
  await jobs.bulkWrite(batch, { ordered: false });
  done += batch.length;
  batch = [];
  process.stdout.write(`\r  re-ranked ${done}…`);
};

for await (const j of cursor) {
  const pr = prerank(j, cos.get(`${j.ats}:${j.companyToken}`) || {});
  if ((pr.reasons || []).some((r) => /none of his stack|domain outside/.test(r))) penalised++;
  batch.push({ updateOne: { filter: { _id: j._id }, update: { $set: { prerank: pr } } } });
  if (batch.length >= 1000) await flush();
}
await flush();

console.log(`\r  re-ranked ${done} row(s) at v${PRERANK_VERSION} · ${penalised} carry a mismatch penalty`);
await closeDb();
