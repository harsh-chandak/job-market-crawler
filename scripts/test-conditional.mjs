/**
 * Verify conditional GET end-to-end: re-poll the SAME boards and count 304s.
 * This is the economic assumption behind 3-minute tier-S polling.
 */
import 'dotenv/config';
import { getDb, closeDb } from '../src/db.js';
import { pollCompany } from '../src/poller.js';

const db = await getDb();
const companies = db.collection('companies');

const targets = await companies
  .find({ lastPolledAt: { $ne: null }, etag: { $ne: null } })
  .limit(30)
  .toArray();

if (!targets.length) {
  console.log('no polled boards with an etag yet — run `npm run poll` first');
  await closeDb();
  process.exit(0);
}

console.log(`re-polling ${targets.length} boards that already have an ETag…\n`);

const t0 = Date.now();
const results = [];
let i = 0;
await Promise.all(
  Array.from({ length: 8 }, async () => {
    while (i < targets.length) {
      const c = targets[i++];
      results.push(await pollCompany(db, c, { now: new Date() }));
    }
  }),
);
const elapsed = Date.now() - t0;

const counts = results.reduce((a, r) => ((a[r.outcome] = (a[r.outcome] || 0) + 1), a), {});
const notMod = counts.not_modified || 0;
const inserted = results.reduce((a, r) => a + (r.inserted || 0), 0);

console.log(`  boards          ${String(targets.length).padStart(5)}`);
console.log(`  wall clock      ${String((elapsed / 1000).toFixed(1) + 's').padStart(5)}`);
console.log(`  304 not-mod     ${String(notMod).padStart(5)}`);
console.log(`  200 ok          ${String(counts.ok || 0).padStart(5)}`);
console.log(`  burst           ${String(counts.burst || 0).padStart(5)}`);
console.log(`  error           ${String(counts.error || 0).padStart(5)}`);
console.log(`  jobs inserted   ${String(inserted).padStart(5)}   (should be ~0 on an immediate re-poll)`);
console.log(`\n  → ${((notMod / targets.length) * 100).toFixed(0)}% of polls returned no body`);

const byAts = {};
for (const r of results) {
  const ats = r.company.split(':')[0];
  byAts[ats] ??= { total: 0, notMod: 0 };
  byAts[ats].total++;
  if (r.outcome === 'not_modified') byAts[ats].notMod++;
}
console.log('\n  by ATS:');
for (const [ats, v] of Object.entries(byAts)) {
  console.log(`    ${ats.padEnd(16)} ${v.notMod}/${v.total} returned 304`);
}

await closeDb();
