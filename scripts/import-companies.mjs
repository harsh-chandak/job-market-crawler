/**
 * Load seed/out/companies.json into Mongo.
 *
 * Everything starts at tier C with nextPollAt=now, so the first run does one
 * full sweep of every board. Tiers are then assigned from observed data by
 * scripts/retier.mjs — a board earns tier S by actually posting roles that
 * pass the screen, not because I guessed it was important.
 */

import "dotenv/config";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getDb, closeDb } from "../src/db.js";
import { supportedAts } from "../src/adapters/index.js";
import { normCompany } from "../src/util/normalize.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const SEED = join(HERE, "..", "seed", "out", "companies.json");

// Staffing firms, outsourcers and non-tech bulk posters. They dominate raw
// board size and would otherwise trip the burst detector constantly.
const DENY_TOKENS = new Set([
  "tsmg",
  "capco",
  "accenturefederalservices",
  "plscareers",
  "centriaautism",
  "aloyoga",
  "agency",
  "wppmedia",
  "insightglobal",
  "roberthalf",
  "teksystems",
  "aerotek",
  "randstad",
  "adecco",
  "kforce",
  "motionrecruitment",
  "apexsystems",
  "collabera",
  "infosys",
  "wipro",
  "cognizant",
  "hcl",
  "ltimindtree",
  "mphasis",
  "diversifiedtechnologies",
  "crossover",
  "turing",
  "andela",
]);

const DENY_NAME_PATTERNS = [
  /staffing/i,
  /recruit/i,
  /talent\s*solutions/i,
  /consulting\s*group/i,
  /\bstaff(ing)?\b/i,
  /outsourc/i,
];

function shouldSkip(c) {
  if (DENY_TOKENS.has(String(c.token || "").toLowerCase())) return "denylist";
  for (const re of DENY_NAME_PATTERNS)
    if (re.test(c.token || "")) return "denylist_pattern";
  return null;
}

async function main() {
  const raw = JSON.parse(await readFile(SEED, "utf8"));
  const supported = new Set(supportedAts());
  const db = await getDb();
  const companies = db.collection("companies");
  const now = new Date();

  let inserted = 0;
  let updated = 0;
  let skippedAts = 0;
  let skippedDead = 0;
  let skippedDeny = 0;

  const ops = [];

  for (const c of raw.companies) {
    if (c.status !== "live") {
      skippedDead++;
      continue;
    }
    if (!supported.has(c.ats)) {
      skippedAts++;
      continue;
    }
    if (shouldSkip(c)) {
      skippedDeny++;
      continue;
    }

    ops.push({
      updateOne: {
        filter: { ats: c.ats, token: c.token },
        update: {
          $set: {
            ats: c.ats,
            token: c.token,
            name: c.token,
            nameNorm: normCompany(c.token),
            boardUrl: c.boardUrl || null,
            sources: c.sources || [],
            seedOpenRoles: c.openRoles ?? null,
            enabled: true,
            updatedAt: now,
          },
          $setOnInsert: {
            tier: "C",
            nextPollAt: now, // first sweep: everything is due immediately
            consecutiveErrors: 0,
            etag: null,
            lastModified: null,
            openRoles: null,
            createdAt: now,
          },
        },
        upsert: true,
      },
    });
  }

  if (ops.length) {
    // Chunked so a single oversized bulkWrite doesn't blow the 16MB command cap.
    for (let i = 0; i < ops.length; i += 500) {
      const res = await companies.bulkWrite(ops.slice(i, i + 500), {
        ordered: false,
      });
      inserted += res.upsertedCount || 0;
      updated += res.modifiedCount || 0;
    }
  }

  const total = await companies.countDocuments({});
  console.log("──────────── import ────────────");
  console.log(`  inserted            ${String(inserted).padStart(5)}`);
  console.log(`  updated             ${String(updated).padStart(5)}`);
  console.log(`  skipped: not live   ${String(skippedDead).padStart(5)}`);
  console.log(
    `  skipped: no adapter ${String(skippedAts).padStart(5)}  (workday/workable/recruitee — tier-B adapters pending)`,
  );
  console.log(`  skipped: denylist   ${String(skippedDeny).padStart(5)}`);
  console.log(`  companies in db     ${String(total).padStart(5)}`);

  await closeDb();
}

main().catch(async (err) => {
  console.error("[import] fatal:", err);
  await closeDb();
  process.exit(1);
});
