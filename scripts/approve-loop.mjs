/**
 * Handle Apply/Skip presses from the Telegram cards.
 *
 *   node scripts/approve-loop.mjs [--minutes 0]   # 0 = run forever
 *
 * Long-polls getUpdates and records the decision. Approving does NOT submit —
 * it marks the job queued for the submit worker, which is a separate step with
 * its own gate. Applying is outward-facing and irreversible, so the decision and
 * the action stay decoupled.
 */
import 'dotenv/config';
import { ObjectId } from 'mongodb';
import { getDb, closeDb } from '../src/db.js';
import { getUpdates, answerCallback, editCard, esc, whoAmI } from '../src/telegram.js';

const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i > -1 && process.argv[i+1] ? process.argv[i+1] : d; };
const stopAfterMs = Number(arg('minutes', 0)) * 60_000;
const startedAt = Date.now();

const db = await getDb();
const jobs = db.collection('jobs');

const me = await whoAmI();
console.log(`[approve] listening as @${me?.username}${stopAfterMs ? ` for ${stopAfterMs/60000}m` : ' (ctrl-c to stop)'}`);

let stopping = false;
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { stopping = true; console.log('\n[approve] stopping…'); });

// Start from the newest update so a restart doesn't replay old presses.
let offset = 0;
const seed = await getUpdates(0, 0);
if (seed.length) offset = seed[seed.length - 1].update_id + 1;

const counts = { approved: 0, skipped: 0, stale: 0 };

while (!stopping) {
  let updates = [];
  try {
    updates = await getUpdates(offset, 25);
  } catch (e) {
    console.log(`  poll error: ${String(e.message).slice(0, 100)}`);
    await new Promise(r => setTimeout(r, 3000));
    continue;
  }

  for (const u of updates) {
    offset = u.update_id + 1;
    const cq = u.callback_query;
    if (!cq?.data) continue;

    const [action, id] = String(cq.data).split(':');
    if (!id || !['a', 's'].includes(action)) continue;

    let job = null;
    try { job = await jobs.findOne({ _id: new ObjectId(id) }); } catch {}
    if (!job) {
      counts.stale++;
      await answerCallback(cq.id, 'job no longer in the queue');
      continue;
    }

    const decision = action === 'a' ? 'approved' : 'skipped';
    await jobs.updateOne(
      { _id: job._id },
      { $set: { decision, decidedAt: new Date(), submitStatus: decision === 'approved' ? 'queued' : null } },
    );
    counts[decision]++;

    await answerCallback(cq.id, decision === 'approved' ? 'queued to apply' : 'skipped');
    const mark = decision === 'approved' ? '✅ QUEUED' : '⏭ SKIPPED';
    try {
      await editCard(
        cq.message.message_id,
        `${mark} · *${esc(String(job.llmScore?.fit ?? ''))}*\n${esc(job.title)}\n${esc(job.companyName || '')}`,
      );
    } catch {}
    console.log(`  ${mark.padEnd(10)} ${String(job.companyName || '').slice(0,20).padEnd(20)} ${job.title.slice(0,44)}`);
  }

  if (stopAfterMs && Date.now() - startedAt >= stopAfterMs) break;
}

console.log(`\n[approve] approved ${counts.approved}  skipped ${counts.skipped}  stale ${counts.stale}`);
await closeDb();
process.exit(0);
