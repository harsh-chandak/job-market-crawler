import 'dotenv/config';
import { getDb, closeDb } from '../src/db.js';
import { fetchBoard } from '../src/adapters/index.js';
import { screen } from '../src/filter.js';
const db = await getDb();

const agg = await db.collection('poll_log').aggregate([
  { $group: { _id: '$ats', polls: { $sum: 1 }, seen: { $sum: '$seen' }, screenedIn: { $sum: '$screenedIn' } } },
  { $sort: { seen: -1 } },
]).toArray();
console.log('ats              polls    seen   passed   rate');
for (const a of agg) {
  const rate = a.seen ? ((a.screenedIn / a.seen) * 100).toFixed(2) + '%' : '—';
  console.log(`${String(a._id).padEnd(16)} ${String(a.polls).padStart(5)} ${String(a.seen).padStart(7)} ${String(a.screenedIn).padStart(7)}   ${rate}`);
}

// take a real workday board and screen its jobs by hand
const co = await db.collection('companies').findOne({ ats: 'workday', token: 'boeing' });
const r = await fetchBoard(co);
console.log(`\nboeing: fetched ${r.jobs.length} jobs`);
const reasons = new Map();
let passed = 0;
for (const j of r.jobs) {
  const v = screen({ title: j.title, description: j.description, locations: j.locations });
  if (v.pass) passed++;
  else for (const rr of v.reasons) { const k = rr.split(':')[0]; reasons.set(k, (reasons.get(k) || 0) + 1); }
}
console.log(`  passed: ${passed}`);
console.log('  rejections:', [...reasons].sort((a,b)=>b[1]-a[1]).map(([k,v])=>`${k}:${v}`).join('  '));
console.log('  sample titles:', r.jobs.slice(0, 6).map(j => j.title).join(' | '));
await closeDb();
