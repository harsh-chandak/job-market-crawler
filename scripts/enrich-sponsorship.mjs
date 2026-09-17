/**
 * Join USCIS H-1B employer data onto every tracked company.
 *
 *   node scripts/enrich-sponsorship.mjs
 *
 * Downloads (and caches in data/) the H-1B Employer Data Hub CSVs, aggregates
 * per employer, and writes a `sponsorship` block onto each company row.
 *
 * Manual add-ons, dropped into data/ if you have them:
 *   data/lca-*.csv      DOL LCA disclosure export (dol.gov blocks scripted
 *                       download; grab it in a browser). Adds recency + worksite.
 *   data/everify.csv    E-Verify participating employers, single column of names.
 *                       This one matters: the STEM OPT extension REQUIRES an
 *                       E-Verify employer, so a company that sponsors H-1B but
 *                       isn't enrolled quietly costs 24 months of runway.
 */

import "dotenv/config";
import { readFile, writeFile, mkdir, access } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { getDb, closeDb } from "../src/db.js";
import { parseCsvObjects } from "../src/util/csv.js";
import {
  aggregateH1b,
  buildIndex,
  matchCompany,
  classifySponsorship,
  slugKey,
} from "../src/sponsorship.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const DATA = join(HERE, "..", "data");
const YEARS = [2021, 2022, 2023]; // FY2024+ is Tableau-only, no flat CSV
const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/126.0 Safari/537.36";

async function exists(p) {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

async function loadYear(year) {
  const path = join(DATA, `h1b-${year}.csv`);
  if (!(await exists(path))) {
    const url = `https://www.uscis.gov/sites/default/files/document/data/h1b_datahubexport-${year}.csv`;
    process.stdout.write(`  downloading FY${year}… `);
    const res = await fetch(url, { headers: { "user-agent": UA } });
    if (!res.ok) {
      console.log(`failed (${res.status})`);
      return [];
    }
    await mkdir(DATA, { recursive: true });
    await writeFile(path, Buffer.from(await res.arrayBuffer()));
    console.log("ok");
  }
  const rows = parseCsvObjects(await readFile(path, "utf8"));
  console.log(`  FY${year}  ${String(rows.length).padStart(6)} employer-rows`);
  return rows;
}

/** Optional E-Verify list: one company name per line (header optional). */
async function loadEverify() {
  const path = join(DATA, "everify.csv");
  if (!(await exists(path))) return null;
  const text = await readFile(path, "utf8");
  const set = new Set();
  for (const line of text.split("\n")) {
    const name = line.split(",")[0].replace(/^"|"$/g, "").trim();
    if (!name || /^(employer|company|name)$/i.test(name)) continue;
    const k = slugKey(name);
    if (k.length >= 3) set.add(k);
  }
  console.log(`  e-verify  ${String(set.size).padStart(6)} enrolled employers`);
  return set;
}

async function main() {
  console.log("──────────── loading sources ────────────");
  const all = [];
  for (const y of YEARS) all.push(...(await loadYear(y)));
  const everify = await loadEverify();
  if (!everify) {
    console.log(
      "  e-verify       —  not present (see header comment; optional but high-value)",
    );
  }

  console.log(`\n  ${all.length} total rows → aggregating…`);
  const byKey = aggregateH1b(all);
  const index = buildIndex(byKey);
  console.log(`  ${byKey.size} distinct employers`);

  const db = await getDb();
  const companies = db.collection("companies");
  const list = await companies
    .find({}, { projection: { ats: 1, token: 1, name: 1 } })
    .toArray();

  const ops = [];
  const stats = { exact: 0, prefix: 0, none: 0 };
  const statuses = {};
  let everifyHits = 0;

  for (const c of list) {
    const { rec, matchType } = matchCompany(c.token, index);
    const verdict = classifySponsorship(rec);

    if (matchType) stats[matchType]++;
    else stats.none++;
    statuses[verdict.status] = (statuses[verdict.status] || 0) + 1;

    if (everify) {
      const k = slugKey(c.token);
      verdict.eVerify = everify.has(k) ? true : null; // null = unknown, not false
      if (verdict.eVerify) everifyHits++;
    } else {
      verdict.eVerify = null;
    }
    verdict.matchType = matchType;
    verdict.enrichedAt = new Date();

    ops.push({
      updateOne: {
        filter: { _id: c._id },
        update: { $set: { sponsorship: verdict } },
      },
    });
  }

  for (let i = 0; i < ops.length; i += 500) {
    await companies.bulkWrite(ops.slice(i, i + 500), { ordered: false });
  }

  console.log("\n──────────── match rate ────────────");
  console.log(`  companies            ${String(list.length).padStart(6)}`);
  console.log(`  matched exact        ${String(stats.exact).padStart(6)}`);
  console.log(`  matched by prefix    ${String(stats.prefix).padStart(6)}`);
  console.log(`  no record            ${String(stats.none).padStart(6)}`);
  console.log(
    `  → matched            ${(((stats.exact + stats.prefix) / list.length) * 100).toFixed(0)}%`,
  );

  console.log("\n──────────── sponsorship status ────────────");
  for (const [s, n] of Object.entries(statuses).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${s.padEnd(12)} ${String(n).padStart(6)}`);
  }
  if (everify)
    console.log(`\n  e-verify enrolled    ${String(everifyHits).padStart(6)}`);

  const top = await companies
    .find(
      { "sponsorship.h1bApprovals": { $gt: 0 } },
      { projection: { token: 1, ats: 1, sponsorship: 1 } },
    )
    .sort({ "sponsorship.h1bApprovals": -1 })
    .limit(15)
    .toArray();
  console.log("\n  top sponsors among tracked boards:");
  for (const c of top) {
    const s = c.sponsorship;
    const phx = s.phoenix ? " 📍PHX" : "";
    console.log(
      `    ${String(s.h1bApprovals).padStart(6)} approvals  ${c.token.padEnd(24)} ${s.legalNames?.[0] || ""}${phx}`,
    );
  }

  const capx = await companies.countDocuments({
    "sponsorship.capExempt": true,
  });
  console.log(
    `\n  cap-exempt employers ${String(capx).padStart(6)}  (year-round filing, no lottery)`,
  );

  await closeDb();
}

main().catch(async (err) => {
  console.error("[enrich] fatal:", err);
  await closeDb();
  process.exit(1);
});
