/**
 * Score screened jobs with the configured LLM provider.
 *   node scripts/score-jobs.mjs [--limit 10] [--all] [--floor 45] [--provider ollama]
 * Results persist on the job doc, keyed by prompt version so a prompt change
 * re-scores and an unchanged prompt costs nothing.
 */
import 'dotenv/config';
import { getDb, closeDb } from '../src/db.js';
import { loadBank } from '../src/tailor.js';
import { scoreBatch, candidateProfile, scoreCacheKey } from '../src/scoring.js';
import { describeProvider } from '../src/llm.js';

const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i > -1 && process.argv[i+1] ? process.argv[i+1] : d; };
const limit = Number(arg('limit', 10));
const provider = arg('provider', null);
const llm = provider ? { provider } : {};

const db = await getDb();
const bank = await loadBank();
const jobs = db.collection('jobs');

// Freshness-first, deliberately.
//
// The goal is to be in the first 50-100 applicants, and 93% of the corpus is
// backlog from the initial sweep — a req that has been open 45 days already has
// hundreds of applications, so scoring it spends tokens on a job that should not
// be applied to. `maxAgeHours` bounds candidates to postings we caught while
// they were still fresh; `--all` opts back into the backlog explicitly.
//
// Body length matters too: body-less sources (Workday, SmartRecruiters) cannot
// be scored meaningfully, so they are excluded rather than scored badly.
const maxAgeHours = Number(arg('max-age-hours', 72));
const scoreAll = process.argv.includes('--all');
// Skip what the free pre-rank already judged a poor match (prerank.score < floor).
const floor = Number(arg('floor', 0));

const freshness = scoreAll ? {} : {
  $or: [
    { claimedLagMs: { $ne: null, $lt: maxAgeHours * 3600 * 1000 } },
    { claimedLagMs: null, firstSeenAt: { $gte: new Date(Date.now() - maxAgeHours * 3600 * 1000) } },
  ],
};

const candidates = await jobs.find({
  status: 'new',
  'screen.roleFamily': { $ne: null },
  $expr: { $gt: [{ $strLenCP: { $ifNull: ['$description', ''] } }, 400] },
  llmScore: { $exists: false },
  ...(floor ? { 'prerank.score': { $gte: floor } } : {}),
  ...freshness,
}).sort({ firstSeenAt: -1 }).limit(limit).toArray();

console.log('provider:', JSON.stringify({ ...describeProvider(), ...(provider ? { provider } : {}) }));
console.log(`scoring ${candidates.length} jobs…\n`);

const profile = candidateProfile(bank);
const t0 = Date.now();
// Persist as we go. A single bulkWrite after the whole batch means an
// interrupted run — a timeout, a Ctrl-C, a laptop lid — loses every scored job
// and re-spends the tokens. Flushing in small chunks makes the run resumable.
let pending = [];
let okCount = 0;
// Writes are chained, and the chain is awaited before the connection closes.
// scoreBatch does not wait on onResult, so the last in-flight flush used to
// land after closeDb() and throw "Cannot use a session that has ended": 10 of
// every 30 scores were lost and re-bought on the next run.
let chain = Promise.resolve();
const flush = () => {
  if (!pending.length) return chain;
  const batch = pending;
  pending = [];
  chain = chain.then(() => jobs.bulkWrite(batch, { ordered: false }));
  return chain;
};

const results = await scoreBatch(candidates, bank, {
  concurrency: Number(arg('concurrency', 2)),
  profile, llm,
  onResult: async (r, i, n) => {
    process.stdout.write(`\r  ${i+1}/${n}`);
    if (r?.error || !r?.score) return;
    okCount++;
    pending.push({ updateOne: { filter: { _id: r.job._id },
      update: { $set: { llmScore: r.score, llmScoreKey: scoreCacheKey(r.job), llmScoredAt: new Date() } } } });
    if (pending.length >= 10) flush();
  },
});
await flush();
await chain;
process.stdout.write('\r');

console.log(`\nscored ${okCount}/${candidates.length} in ${((Date.now()-t0)/1000).toFixed(1)}s\n`);
const ranked = results.filter(r => r.score).sort((a,b) => b.score.fit - a.score.fit);
for (const { job, score } of ranked.slice(0, 12)) {
  const phx = job.screen?.location?.phoenix ? ' PHX' : '';
  console.log(`  ${String(score.fit).padStart(3)}  ${String(score.verdict).padEnd(7)} ${String(score.family).padEnd(4)} ${job.companyName.slice(0,20).padEnd(20)} ${job.title.slice(0,46)}${phx}`);
  if (score.reasons?.[0]) console.log(`       ${score.reasons[0].slice(0, 100)}`);
}
const errs = results.filter(r => r.error);
if (errs.length) console.log(`\n  ${errs.length} errors, first: ${errs[0].error}`);
await closeDb();
