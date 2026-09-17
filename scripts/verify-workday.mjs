/**
 * Verify Workday tenants and import the live ones.
 *
 *   node scripts/verify-workday.mjs [--limit N] [--concurrency N]
 *
 * The seed harvest captured 1,714 (tenant, wdHost, wdSite) triples out of job
 * URLs, but the site slug is the least reliable part — a URL like
 * /en-US/External/job/... can yield a site of "External", "job", or a locale
 * fragment depending on how the link was written. So every triple gets probed
 * against its cxs endpoint and only the ones that answer with a job count are
 * imported.
 */

import "dotenv/config";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getDb, closeDb } from "../src/db.js";
import { boardUrl } from "../src/adapters/workday.js";
import { postJson } from "../src/util/http.js";
import { normCompany } from "../src/util/normalize.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const SEED = join(HERE, "..", "seed", "out", "companies.json");

// Site slugs that are URL scaffolding, not board names.
const BOGUS_SITES = new Set([
  "job",
  "jobs",
  "en",
  "en-us",
  "details",
  "search",
  "apply",
  "login",
  "wday",
  "cxs",
  "task",
  "home",
  "index",
]);

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

async function probe(c) {
  const res = await postJson(
    boardUrl(c),
    { appliedFacets: {}, limit: 1, offset: 0, searchText: "" },
    { timeout: 20_000 },
  );
  if (res.status !== "ok")
    return { ...c, live: false, reason: res.error || `http_${res.httpStatus}` };
  const total = Number(res.data?.total ?? NaN);
  if (!Number.isFinite(total))
    return { ...c, live: false, reason: "no_total_field" };
  return { ...c, live: true, openRoles: total };
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
        } catch (err) {
          out[idx] = {
            ...items[idx],
            live: false,
            reason: String(err?.message || err),
          };
        }
        if (onProgress && ++done % 50 === 0) onProgress(done, items.length);
      }
    }),
  );
  return out;
}

async function main() {
  const limit = Number(arg("limit", 5000));
  const concurrency = Number(arg("concurrency", 10));

  const raw = JSON.parse(await readFile(SEED, "utf8"));
  const seen = new Set();
  const candidates = raw.companies
    .filter((c) => c.ats === "workday" && c.wdHost && c.wdSite)
    .filter((c) => !BOGUS_SITES.has(String(c.wdSite).toLowerCase()))
    .filter((c) => {
      const k = `${c.token}|${c.wdHost}|${c.wdSite}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    })
    .slice(0, limit);

  console.log(
    `probing ${candidates.length} workday tenants (concurrency ${concurrency})…`,
  );
  const results = await pool(candidates, concurrency, probe, (d, t) =>
    process.stdout.write(`\r  ${d}/${t}`),
  );
  process.stdout.write("\r");

  const live = results.filter((r) => r.live);
  const dead = results.filter((r) => !r.live);

  const reasons = dead.reduce(
    (a, d) => ((a[d.reason] = (a[d.reason] || 0) + 1), a),
    {},
  );

  console.log("\n──────────── workday verification ────────────");
  console.log(`  probed              ${String(results.length).padStart(6)}`);
  console.log(`  live                ${String(live.length).padStart(6)}`);
  console.log(`  dead                ${String(dead.length).padStart(6)}`);
  console.log(
    `  open roles on live  ${String(live.reduce((s, c) => s + (c.openRoles || 0), 0)).padStart(6)}`,
  );
  console.log("\n  failure reasons:");
  for (const [r, n] of Object.entries(reasons)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)) {
    console.log(`    ${r.padEnd(22)} ${String(n).padStart(5)}`);
  }

  // Import the live ones.
  const db = await getDb();
  const companies = db.collection("companies");
  const now = new Date();
  const ops = live.map((c) => ({
    updateOne: {
      filter: { ats: "workday", token: c.token },
      update: {
        $set: {
          ats: "workday",
          token: c.token,
          name: c.token,
          nameNorm: normCompany(c.token),
          wdHost: c.wdHost,
          wdSite: c.wdSite,
          boardUrl: boardUrl(c),
          sources: c.sources || [],
          seedOpenRoles: c.openRoles ?? null,
          enabled: true,
          updatedAt: now,
        },
        $setOnInsert: {
          tier: "C",
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

  let upserted = 0;
  for (let i = 0; i < ops.length; i += 500) {
    const res = await companies.bulkWrite(ops.slice(i, i + 500), {
      ordered: false,
    });
    upserted += res.upsertedCount || 0;
  }

  const total = await companies.countDocuments({});
  console.log(`\n  imported new        ${String(upserted).padStart(6)}`);
  console.log(`  companies in db     ${String(total).padStart(6)}`);

  console.log("\n  largest workday boards:");
  for (const c of live
    .sort((a, b) => (b.openRoles || 0) - (a.openRoles || 0))
    .slice(0, 12)) {
    console.log(
      `    ${String(c.openRoles).padStart(6)}  ${c.token.padEnd(28)} ${c.wdHost}/${c.wdSite}`,
    );
  }

  await closeDb();
}

main().catch(async (err) => {
  console.error("[verify-workday] fatal:", err);
  await closeDb();
  process.exit(1);
});
