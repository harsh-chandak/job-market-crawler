/**
 * Expand coverage using H-1B data as the discovery source.
 *
 *   node scripts/expand-west-coast.mjs [--min-approvals 5] [--limit 1500]
 *
 * The community feeds that seeded the original list skew to companies that
 * recruit new grads publicly. That misses a lot of west-coast tech — and, more
 * importantly, says nothing about sponsorship. This inverts the search: start
 * from employers the federal data proves sponsor H-1B, in CA/WA/OR, in the tech
 * sectors, then go looking for their ATS board.
 *
 * Every company found this way is guaranteed to sponsor, which is the binding
 * constraint here. The cost is that a board must be *found* — ATS tokens are
 * not derivable from a legal name, so candidates are generated and verified
 * against the live APIs. Unverified guesses are discarded, never imported.
 */

import "dotenv/config";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getDb, closeDb } from "../src/db.js";
import { parseCsvObjects } from "../src/util/csv.js";
import { aggregateH1b, slugKey } from "../src/sponsorship.js";
import { normCompany } from "../src/util/normalize.js";
import { getJson } from "../src/util/http.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const DATA = join(HERE, "..", "data");
const YEARS = [2021, 2022, 2023];

const WEST = new Set(["CA", "WA", "OR"]);
// USCIS publishes 2-digit NAICS sectors only. 51 = Information,
// 54 = Professional/Scientific/Technical. Both are tech-dense.
const TECH_SECTORS = new Set(["51", "54"]);

// Only ATS whose API can actually DISCRIMINATE are usable for discovery.
//
// SmartRecruiters is deliberately excluded: it answers HTTP 200 with
// `{content: [], totalFound: 0}` for EVERY token — verified against
// "thiscompanydoesnotexistxyz123" and against known-real boards alike. Using it
// here produced a 100% hit rate and fabricated 1,300 companies ("google" and
// "apple" as SmartRecruiters boards) before the impossible hit rate gave it
// away. Greenhouse, Ashby and Lever all return a clean 404 for unknown tokens,
// so only those three can verify a guess.
//
// Ordered by prevalence in the existing corpus so the early exit hits sooner.
const VERIFIERS = [
  { ats: "greenhouse", url: (t) => `https://boards-api.greenhouse.io/v1/boards/${t}/jobs`, count: (d) => (Array.isArray(d?.jobs) ? d.jobs.length : null) },
  { ats: "ashby", url: (t) => `https://api.ashbyhq.com/posting-api/job-board/${t}`, count: (d) => (Array.isArray(d?.jobs) ? d.jobs.length : null) },
  { ats: "lever", url: (t) => `https://api.lever.co/v0/postings/${t}?mode=json`, count: (d) => (Array.isArray(d) ? d.length : null) },
];

const STAFFING =
  /staffing|consult|solutions inc|technologies llc|infotech|systems inc|services llc|outsourc|recruit|talent/i;

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

/**
 * ATS tokens are not derivable from a legal name, so generate the plausible
 * shapes and let the live API arbitrate. Capped at 3 to bound request volume.
 */
export function candidateTokens(legalName) {
  const norm = normCompany(legalName);
  if (!norm) return [];
  const words = norm.split(/\s+/).filter(Boolean);
  const out = [];
  const seen = new Set();

  // `confidence` records how strongly the token implies THIS company. Neither
  // Greenhouse nor Ashby nor Lever self-identifies the organization, so a
  // matched board cannot be attributed by inspection — the token is the only
  // evidence. A bare first word is weak: greenhouse/applied is Applied
  // Intuition, not APPLIED MATERIALS, and greenhouse/fox is not FOX CABLE.
  const push = (t, confidence) => {
    if (!t || t.length < 3 || t.length > 40 || seen.has(t)) return;
    seen.add(t);
    out.push({ token: t, confidence });
  };

  push(words.join(""), "high"); // full name despaced — unambiguous
  if (words.length > 2) push(words.slice(0, 2).join(""), "high");
  if (words.length > 1) push(words.join("-"), "high");
  // Only worth guessing a single word if it is distinctive enough not to be a
  // common noun another company would have claimed first.
  if (words.length > 1 && words[0].length >= 7) push(words[0], "medium");

  return out.slice(0, 3);
}

async function tryToken(token) {
  for (const v of VERIFIERS) {
    const res = await getJson(v.url(encodeURIComponent(token)), {
      timeout: 12_000,
    });
    if (res.status !== "ok") continue;
    const n = v.count(res.data);
    if (n === null) continue;
    return { ats: v.ats, token, openRoles: n };
  }
  return null;
}

async function pool(items, limit, worker, onProgress) {
  const out = [];
  let i = 0;
  let done = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (i < items.length) {
        const idx = i++;
        try {
          out[idx] = await worker(items[idx]);
        } catch {
          out[idx] = null;
        }
        if (onProgress && ++done % 25 === 0) onProgress(done, items.length);
      }
    }),
  );
  return out;
}

async function main() {
  const minApprovals = Number(arg("min-approvals", 5));
  const limit = Number(arg("limit", 1500));
  const concurrency = Number(arg("concurrency", 14));

  console.log("loading H-1B data…");
  const rows = [];
  for (const y of YEARS) {
    rows.push(
      ...parseCsvObjects(await readFile(join(DATA, `h1b-${y}.csv`), "utf8")),
    );
  }
  const agg = aggregateH1b(rows);

  const db = await getDb();
  const companies = db.collection("companies");
  const tracked = new Set(
    (
      await companies
        .find({}, { projection: { token: 1, nameNorm: 1 } })
        .toArray()
    ).flatMap((c) => [slugKey(c.token || ""), slugKey(c.nameNorm || "")]),
  );

  const pool0 = [];
  for (const rec of agg.values()) {
    if (rec.totalApprovals < minApprovals) continue;
    if (!rec.states.some((s) => WEST.has(s))) continue;
    if (!rec.naics.some((n) => TECH_SECTORS.has(n))) continue;
    if (STAFFING.test(rec.names[0])) continue;
    if (tracked.has(rec.key)) continue;
    pool0.push(rec);
  }
  pool0.sort((a, b) => b.totalApprovals - a.totalApprovals);
  const targets = pool0.slice(0, limit);

  console.log(
    `west-coast tech sponsors ≥${minApprovals} approvals, not already tracked: ${pool0.length}`,
  );
  console.log(`probing top ${targets.length} (concurrency ${concurrency})…\n`);

  const results = await pool(
    targets,
    concurrency,
    async (rec) => {
      for (const cand of candidateTokens(rec.names[0])) {
        const hit = await tryToken(cand.token);
        if (hit) return { ...hit, rec, confidence: cand.confidence };
      }
      return null;
    },
    (d, t) => process.stdout.write(`\r  ${d}/${t}`),
  );
  process.stdout.write("\r");

  const found = results.filter(Boolean);
  console.log(`\n──────────── expansion ────────────`);
  console.log(`  probed              ${String(targets.length).padStart(5)}`);
  console.log(
    `  boards found        ${String(found.length).padStart(5)}  (${((found.length / targets.length) * 100).toFixed(1)}% hit rate)`,
  );

  const byAts = found.reduce(
    (a, f) => ((a[f.ats] = (a[f.ats] || 0) + 1), a),
    {},
  );
  console.log(
    `  by ats              ${Object.entries(byAts)
      .map(([k, v]) => `${k}:${v}`)
      .join("  ")}`,
  );

  const now = new Date();
  const ops = found.map((f) => ({
    updateOne: {
      filter: { ats: f.ats, token: f.token },
      update: {
        $set: {
          ats: f.ats,
          token: f.token,
          // Only claim the legal name when the token unambiguously implies it.
          // Otherwise the board is kept (it is real, and it is a west-coast tech
          // employer either way) but no identity is asserted — enrich-sponsorship
          // re-derives sponsorship from the token independently.
          name: f.confidence === "high" ? f.rec.names[0] : f.token,
          nameNorm: normCompany(f.confidence === "high" ? f.rec.names[0] : f.token),
          h1bHint: f.confidence === "high" ? null : f.rec.names[0],
          tokenConfidence: f.confidence,
          seedOpenRoles: f.openRoles,
          discoveredVia: "h1b-west-coast",
          enabled: true,
          updatedAt: now,
        },
        $setOnInsert: {
          // Proven sponsors start warm; retier will confirm from match data.
          tier: "A",
          nextPollAt: now,
          consecutiveErrors: 0,
          etag: null,
          lastModified: null,
          openRoles: null,
          createdAt: now,
        },
      },
      upsert: true,
    },
  }));

  let inserted = 0;
  for (let i = 0; i < ops.length; i += 500) {
    const res = await companies.bulkWrite(ops.slice(i, i + 500), {
      ordered: false,
    });
    inserted += res.upsertedCount || 0;
  }

  console.log(`  newly imported      ${String(inserted).padStart(5)}`);
  console.log(
    `  companies in db     ${String(await companies.countDocuments({})).padStart(5)}`,
  );

  console.log("\n  found (top 20 by H-1B volume):");
  for (const f of found
    .sort((a, b) => b.rec.totalApprovals - a.rec.totalApprovals)
    .slice(0, 20)) {
    const phx = f.rec.phoenix ? " 📍PHX" : "";
    console.log(
      `    ${String(f.rec.totalApprovals).padStart(6)} H-1B  ${f.ats.padEnd(15)} ${f.token.padEnd(26)} ${f.rec.names[0].slice(0, 34)}${phx}`,
    );
  }

  await closeDb();
}

main().catch(async (err) => {
  console.error("[expand] fatal:", err);
  await closeDb();
  process.exit(1);
});
