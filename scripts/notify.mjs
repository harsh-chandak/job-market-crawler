/**
 * Push the top-ranked undecided jobs to Telegram as decision cards.
 *
 *   node scripts/notify.mjs [--limit 10] [--min-fit 70]
 *
 * Ranking is fit-first, then freshness. Deliberately capped per run: the user
 * targets 20-40 applications a day, and a queue of 300 cards gets ignored
 * wholesale, which is worse than a queue of 10 that gets cleared.
 */
import 'dotenv/config';
import { getDb, closeDb } from '../src/db.js';
import { send, renderCard, decisionKeyboard } from '../src/telegram.js';

const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i > -1 && process.argv[i+1] ? process.argv[i+1] : d; };
const limit = Number(arg('limit', 10));
const minFit = Number(arg('min-fit', 70));

const db = await getDb();
const jobs = db.collection('jobs');
const companies = db.collection('companies');

const candidates = await jobs.find({
  llmScore: { $ne: null },
  'llmScore.fit': { $gte: minFit },
  decision: { $exists: false },
  notifiedAt: { $exists: false },
}).sort({ 'llmScore.fit': -1, firstSeenAt: -1 }).limit(limit).toArray();

if (!candidates.length) {
  console.log(`nothing to send (no unnotified jobs with fit >= ${minFit})`);
  await closeDb();
  process.exit(0);
}

// Attach sponsorship so the card can show it without a second lookup.
const keys = [...new Set(candidates.map(c => `${c.ats}:${c.companyToken}`))];
const cos = await companies.find(
  { $or: keys.map(k => ({ ats: k.split(':')[0], token: k.split(':').slice(1).join(':') })) },
  { projection: { ats: 1, token: 1, sponsorship: 1 } },
).toArray();
const spBy = new Map(cos.map(c => [`${c.ats}:${c.token}`, c.sponsorship]));

console.log(`sending ${candidates.length} cards…`);
let sent = 0;
for (const job of candidates) {
  job.sponsorship = spBy.get(`${job.ats}:${job.companyToken}`) || {};
  try {
    const msg = await send(renderCard(job), { keyboard: decisionKeyboard(job._id.toString()) });
    await jobs.updateOne({ _id: job._id }, { $set: { notifiedAt: new Date(), tgMessageId: msg.message_id } });
    sent++;
    console.log(`  ${String(job.llmScore.fit).padStart(3)}  ${job.companyName.slice(0,20).padEnd(20)} ${job.title.slice(0,44)}`);
    await new Promise(r => setTimeout(r, 400)); // Telegram rate limit
  } catch (e) {
    console.log(`  FAILED ${job.title.slice(0,40)}: ${String(e.message).slice(0,120)}`);
  }
}
console.log(`\nsent ${sent}/${candidates.length}`);
await closeDb();
