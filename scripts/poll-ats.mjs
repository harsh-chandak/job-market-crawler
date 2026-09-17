/** Poll every board for one ATS, ignoring schedule. node scripts/poll-ats.mjs amazon */
import 'dotenv/config';
import { getDb, closeDb } from '../src/db.js';
import { pollCompany } from '../src/poller.js';

const ats = process.argv[2];
if (!ats) { console.error('usage: poll-ats.mjs <ats>'); process.exit(1); }
const db = await getDb();
const list = await db.collection('companies').find({ ats }).toArray();
console.log(`polling ${list.length} ${ats} boards…\n`);

const results = [];
let i = 0;
await Promise.all(Array.from({ length: 4 }, async () => {
  while (i < list.length) {
    const c = list[i++];
    const r = await pollCompany(db, c, { now: new Date() });
    results.push(r);
    console.log(`  ${String(r.outcome).padEnd(13)} ${c.token.padEnd(26)} seen:${String(r.seen).padStart(4)} new:${String(r.inserted).padStart(4)} match:${String(r.screenedIn).padStart(4)}`);
  }
}));

const t = results.reduce((a, r) => ({ seen: a.seen + (r.seen||0), ins: a.ins + (r.inserted||0), m: a.m + (r.screenedIn||0) }), { seen:0, ins:0, m:0 });
console.log(`\n  totals: seen ${t.seen}  inserted ${t.ins}  passed screen ${t.m}  (${t.seen ? ((t.m/t.seen)*100).toFixed(1) : 0}%)`);
await closeDb();
