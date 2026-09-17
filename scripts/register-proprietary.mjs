/**
 * Register proprietary career portals as company rows.
 *
 * These have no "board token" to harvest — they're search endpoints. Each query
 * becomes its own row so it gets its own ETag, tier and cadence, with no
 * special-casing in the poller.
 */
import 'dotenv/config';
import { getDb, closeDb } from '../src/db.js';
import { AMAZON_QUERIES } from '../src/adapters/amazon.js';
import { MICROSOFT_QUERIES } from '../src/adapters/microsoft.js';
import { normCompany } from '../src/util/normalize.js';

const db = await getDb();
const companies = db.collection('companies');
const now = new Date();

const rows = [
  ...AMAZON_QUERIES.map((q) => ({ ats: 'amazon', token: `amazon-${q.slug}`, name: 'Amazon', query: q.query })),
  ...MICROSOFT_QUERIES.map((q) => ({ ats: 'microsoft', token: `microsoft-${q.slug}`, name: 'Microsoft', query: q.query })),
  // BofA has no keyword mode — one row pages the newest slice and the screen filters.
  { ats: 'bofa', token: 'bofa-all', name: 'Bank of America', query: null },
];

const ops = rows.map((r) => ({
  updateOne: {
    filter: { ats: r.ats, token: r.token },
    update: {
      $set: {
        ...r,
        nameNorm: normCompany(r.name),
        boardUrl: { amazon: 'https://www.amazon.jobs', microsoft: 'https://jobs.careers.microsoft.com', bofa: 'https://careers.bankofamerica.com' }[r.ats],
        enabled: true,
        updatedAt: now,
      },
      $setOnInsert: {
        // Amazon is a primary target — start warm, retier will confirm from data.
        tier: 'A',
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

const res = await companies.bulkWrite(ops, { ordered: false });
console.log(`amazon queries registered: ${res.upsertedCount} new, ${res.modifiedCount} updated`);
console.log(`companies in db: ${await companies.countDocuments({})}`);
await closeDb();
