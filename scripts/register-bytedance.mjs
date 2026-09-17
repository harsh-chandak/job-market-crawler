/**
 * Register the TikTok and ByteDance boards as company rows.
 *
 *   node scripts/register-bytedance.mjs            # register, DISABLED
 *   node scripts/register-bytedance.mjs --enable   # register and switch on
 *   node scripts/register-bytedance.mjs --disable  # switch off again
 *
 * REGISTERED DISABLED BY DEFAULT, WHICH IS NOT THE CONVENTION HERE.
 *
 * register-proprietary.mjs sets `enabled: true` and that is right for Amazon and
 * Microsoft, whose search endpoints return a few dozen rows per query. This
 * source is a different size and a different shape. The first successful poll
 * ingests the entire standing backlog at once — 1,052 postings, 236 of which
 * clear the deterministic screen — and because there is no posting date anywhere
 * in the payload (see the adapter header), every one of them lands with
 * `postedAtClaimed: null` and a `firstSeenAt` of now. To the scorer they are 236
 * jobs posted today.
 *
 * The loop in run.mjs is already running. Flipping these on writes a scoring bill
 * the moment the poller next comes round, against an LLM budget that is the
 * pipeline's binding constraint — SCORE_PRERANK_FLOOR exists precisely because
 * scoring everything is not affordable. That is a decision to take deliberately,
 * with the numbers in view, not a side effect of registering a board. Hence the
 * flag.
 *
 * Tier C, also deliberate. Tier S means a three-minute poll, which only pays off
 * when a board's own timestamps let you be early to a specific posting. With no
 * dates, "early" is unmeasurable here and all a fast cadence buys is the same
 * fingerprint recomputed twenty times an hour. Let retier.mjs raise it from
 * observed data if the board actually churns.
 */

import "dotenv/config";
import { getDb, closeDb } from "../src/db.js";
import { BYTEDANCE_BOARDS } from "../src/adapters/bytedance.js";
import { normCompany } from "../src/util/normalize.js";

const ENABLE = process.argv.includes("--enable");
const DISABLE = process.argv.includes("--disable");

const db = await getDb();
const companies = db.collection("companies");
const now = new Date();

const ops = BYTEDANCE_BOARDS.map((b) => ({
  updateOne: {
    filter: { ats: "bytedance", token: b.token },
    update: {
      $set: {
        ats: "bytedance",
        token: b.token,
        name: b.name,
        nameNorm: normCompany(b.name),
        // Mirrors Workday's wdHost/wdSite: the adapter is shared, the board row
        // says which host and which website-path header to use.
        btHost: b.btHost,
        btWebsitePath: b.btWebsitePath,
        boardUrl: `https://${b.btHost}/api/v1/public/supplier/search/job/posts`,
        enabled: ENABLE ? true : DISABLE ? false : false,
        updatedAt: now,
      },
      $setOnInsert: {
        tier: "C",
        nextPollAt: now,
        consecutiveErrors: 0,
        // No ETag on this endpoint — the adapter returns a count+id fingerprint
        // in `etag` and the poller stores it with no special-casing.
        etag: null,
        lastModified: null,
        openRoles: null,
        createdAt: now,
      },
    },
    upsert: true,
  },
}));

const res = await companies.bulkWrite(ops, { ordered: false });
const rows = await companies
  .find(
    { ats: "bytedance" },
    { projection: { token: 1, enabled: 1, tier: 1, btHost: 1 } },
  )
  .toArray();

console.log(
  `bytedance boards: ${res.upsertedCount} new, ${res.modifiedCount} updated`,
);
for (const r of rows) {
  console.log(
    `  ${r.token.padEnd(10)} enabled=${String(r.enabled).padEnd(5)} tier=${r.tier}  ${r.btHost}`,
  );
}
if (!ENABLE && !DISABLE) {
  console.log(
    `\nRegistered but NOT enabled. The next poll would ingest ~1,052 postings\n` +
      `(236 clear the screen) with no posting dates, and the running loop would\n` +
      `start scoring them. Turn on deliberately:\n` +
      `  node scripts/register-bytedance.mjs --enable`,
  );
}
await closeDb();
