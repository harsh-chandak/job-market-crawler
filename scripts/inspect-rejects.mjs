import 'dotenv/config';
import { getDb, closeDb } from '../src/db.js';
const db = await getDb();
const jobs = db.collection('jobs');

const agg = await jobs.aggregate([
  { $unwind: '$screen.reasons' },
  { $match: { 'screen.reasons': { $regex: '^work_auth' } } },
  { $group: { _id: '$screen.reasons', n: { $sum: 1 } } },
  { $sort: { n: -1 } }, { $limit: 12 },
]).toArray();
console.log('work_auth knockout breakdown:');
for (const a of agg) console.log(`  ${String(a.n).padStart(5)}  ${a._id}`);

for (const probe of ['work_auth:export control', 'work_auth:security clearance']) {
  console.log(`\nsample: ${probe}`);
  const s = await jobs.find({ 'screen.reasons': probe }, { projection: { title: 1, companyName: 1, description: 1 } }).limit(2).toArray();
  const needle = probe.split(':')[1];
  for (const j of s) {
    const i = j.description.toLowerCase().indexOf(needle);
    console.log(`  ${j.companyName} — ${j.title}`);
    console.log(`    …${j.description.slice(Math.max(0, i - 130), i + 170).replace(/\s+/g, ' ')}…`);
  }
}
await closeDb();
