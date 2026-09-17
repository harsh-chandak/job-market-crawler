/**
 * Curated tier-S target list.
 *
 *   node scripts/set-targets.mjs
 *
 * Rationale: the big mass-hiring employers post only a handful of new-grad reqs
 * per cycle, and those close fast. That is precisely the case where detection
 * latency decides the outcome, so this list gets the 3-minute cadence
 * regardless of what retier.mjs infers from historical match counts — a company
 * that posted nothing last month can still be the one that matters tomorrow.
 *
 * Everything here was verified against the live board API. Two entries in the
 * database were wrong before this list existed and are corrected by it:
 *   uber  -> greenhouse:uberfreight  (Uber Freight, a different company)
 *   block -> greenhouse:blockchain   (a different company again)
 * Both came from prefix-guessing during the H-1B expansion, which is exactly
 * the failure mode the confidence tagging was added to contain.
 */

import "dotenv/config";
import { getDb, closeDb } from "../src/db.js";
import { getJson } from "../src/util/http.js";

// Verified live at build time. `null` ats means no reachable board API — those
// are covered by their own adapter, the alert-email channel, or not at all.
export const TARGETS = [
  // --- have a dedicated adapter ---
  { name: "Amazon", ats: "amazon", token: "amazon-sde" },
  { name: "Amazon", ats: "amazon", token: "amazon-swe" },
  { name: "Amazon", ats: "amazon", token: "amazon-frontend" },
  { name: "Amazon", ats: "amazon", token: "amazon-ml" },
  { name: "Amazon", ats: "amazon", token: "amazon-applied-scientist" },
  { name: "Microsoft", ats: "microsoft", token: "microsoft-swe" },
  { name: "Microsoft", ats: "microsoft", token: "microsoft-ml" },
  { name: "Microsoft", ats: "microsoft", token: "microsoft-data" },

  // --- verified greenhouse/ashby/lever boards ---
  { name: "Anthropic", ats: "greenhouse", token: "anthropic" },
  { name: "OpenAI", ats: "ashby", token: "openai" },
  { name: "Stripe", ats: "greenhouse", token: "stripe" },
  { name: "Airbnb", ats: "greenhouse", token: "airbnb" },
  { name: "Coinbase", ats: "greenhouse", token: "coinbase" },
  { name: "Block", ats: "greenhouse", token: "block" },
  { name: "Instacart", ats: "greenhouse", token: "instacart" },
  { name: "Samsara", ats: "greenhouse", token: "samsara" },
  { name: "DoorDash", ats: "greenhouse", token: "doordashusa" },
  { name: "Databricks", ats: "greenhouse", token: "databricks" },
  { name: "Snowflake", ats: "ashby", token: "snowflake" },
  { name: "Robinhood", ats: "greenhouse", token: "robinhood" },
  { name: "Lyft", ats: "greenhouse", token: "lyft" },
  { name: "Pinterest", ats: "greenhouse", token: "pinterest" },
  { name: "Roblox", ats: "greenhouse", token: "roblox" },
  { name: "Palantir", ats: "lever", token: "palantir" },
  { name: "Scale AI", ats: "greenhouse", token: "scaleai" },
  { name: "Figma", ats: "greenhouse", token: "figma" },
  { name: "Notion", ats: "ashby", token: "notion" },
  { name: "Ramp", ats: "ashby", token: "ramp" },
  { name: "Plaid", ats: "ashby", token: "plaid" },
  { name: "Reddit", ats: "greenhouse", token: "reddit" },
  { name: "Discord", ats: "greenhouse", token: "discord" },
  { name: "Twitch", ats: "greenhouse", token: "twitch" },
  { name: "Dropbox", ats: "greenhouse", token: "dropbox" },
  { name: "Okta", ats: "greenhouse", token: "okta" },
  { name: "Asana", ats: "greenhouse", token: "asana" },
  { name: "Affirm", ats: "greenhouse", token: "affirm" },
  { name: "Waymo", ats: "greenhouse", token: "waymo" },
  { name: "Anduril", ats: "greenhouse", token: "andurilindustries" },
  { name: "SpaceX", ats: "greenhouse", token: "spacex" },
  { name: "Zoox", ats: "lever", token: "zoox" },
  { name: "Nvidia", ats: "workday", token: "nvidia" },
  { name: "Adobe", ats: "workday", token: "adobe" },
  { name: "Salesforce", ats: "workday", token: "salesforce" },
];

// Verified as NOT reachable on greenhouse/ashby/lever. Recorded so nobody
// re-probes them every cycle. Covered by the alert-email channel instead.
export const NO_PUBLIC_BOARD = [
  "Meta",
  "Apple",
  "Google",
  "Netflix",
  "Tesla",
  "Uber",
  "Rippling",
  "Cruise",
];

// Wrong rows created by prefix-guessing; deleted rather than left to mislead.
const BAD_ROWS = [
  { ats: "greenhouse", token: "uberfreight" },
  { ats: "greenhouse", token: "blockchain" },
];

const VERIFY = {
  greenhouse: (t) => [
    `https://boards-api.greenhouse.io/v1/boards/${t}/jobs`,
    (d) => (Array.isArray(d?.jobs) ? d.jobs.length : null),
  ],
  ashby: (t) => [
    `https://api.ashbyhq.com/posting-api/job-board/${t}`,
    (d) => (Array.isArray(d?.jobs) ? d.jobs.length : null),
  ],
  lever: (t) => [
    `https://api.lever.co/v0/postings/${t}?mode=json`,
    (d) => (Array.isArray(d) ? d.length : null),
  ],
};

const db = await getDb();
const companies = db.collection("companies");
const now = new Date();

// 1. remove the mis-attributed rows
for (const b of BAD_ROWS) {
  const r = await companies.deleteOne(b);
  if (r.deletedCount) console.log(`removed mis-attributed ${b.ats}:${b.token}`);
}

// 2. upsert + promote the curated list
let added = 0;
let promoted = 0;
let dead = 0;

for (const t of TARGETS) {
  // Re-verify anything with a checkable board so a dead token cannot sit at
  // tier S burning a poll every 3 minutes.
  if (VERIFY[t.ats]) {
    const [url, count] = VERIFY[t.ats](t.token);
    const res = await getJson(url, { timeout: 12_000 });
    const n = res.status === "ok" ? count(res.data) : null;
    if (n === null) {
      console.log(
        `  ✗ ${t.name.padEnd(12)} ${t.ats}:${t.token} — board not responding, skipped`,
      );
      dead++;
      continue;
    }
  }

  const existing = await companies.findOne({ ats: t.ats, token: t.token });
  await companies.updateOne(
    { ats: t.ats, token: t.token },
    {
      $set: {
        ats: t.ats,
        token: t.token,
        name: t.name,
        tier: "S",
        isTarget: true, // pinned: retier.mjs must not demote these
        enabled: true,
        updatedAt: now,
      },
      $setOnInsert: {
        nextPollAt: now,
        consecutiveErrors: 0,
        etag: null,
        lastModified: null,
        openRoles: null,
        createdAt: now,
      },
    },
    { upsert: true },
  );
  if (!existing) added++;
  else if (existing.tier !== "S") promoted++;
}

const tierS = await companies.countDocuments({ tier: "S" });
const targets = await companies.countDocuments({ isTarget: true });

console.log(`\n  targets pinned      ${String(targets).padStart(4)}`);
console.log(`  newly added         ${String(added).padStart(4)}`);
console.log(`  promoted to tier S  ${String(promoted).padStart(4)}`);
console.log(`  unreachable         ${String(dead).padStart(4)}`);
console.log(`  tier S total        ${String(tierS).padStart(4)}`);
console.log(
  `\n  no public board (email channel only): ${NO_PUBLIC_BOARD.join(", ")}`,
);

await closeDb();
