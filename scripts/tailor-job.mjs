/**
 * Tailor a resume for one job.
 *   node scripts/tailor-job.mjs [--job <id>] [--provider ollama]
 * Prints the rendered resume and the fabrication-check result.
 */
import 'dotenv/config';
import { getDb, closeDb } from '../src/db.js';
import { loadBank, tailorForJob } from '../src/tailor.js';

const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i > -1 && process.argv[i+1] ? process.argv[i+1] : d; };
const provider = arg('provider', null);

const db = await getDb();
const bank = await loadBank();
const jobs = db.collection('jobs');

const job = arg('job', null)
  ? await jobs.findOne({ _id: (await import('mongodb')).ObjectId.createFromHexString(arg('job')) })
  : await jobs.find({ llmScore: { $exists: true } }).sort({ 'llmScore.fit': -1 }).limit(1).next();

if (!job) { console.log('no scored job found — run score-jobs.mjs first'); await closeDb(); process.exit(0); }

console.log(`tailoring for: ${job.companyName} — ${job.title}`);
console.log(`fit ${job.llmScore?.fit} (${job.llmScore?.verdict}), screen family ${job.screen?.roleFamily}\n`);

const t0 = Date.now();
const { selection, rendered, check } = await tailorForJob(job, bank, provider ? { llm: { provider } } : {});
console.log(`selected in ${((Date.now()-t0)/1000).toFixed(1)}s — variant: ${selection.family.toUpperCase()}`);
console.log(`bullets kept: ${selection.bulletIds.length}   hallucinated ids dropped: ${selection.dropped.length}`);
if (selection.dropped.length) console.log(`  dropped: ${selection.dropped.join(', ')}`);
console.log(`fabrication check: ${check.ok ? 'PASS — every line traced to the bank' : 'FAIL'}\n`);

console.log('─'.repeat(78));
console.log(rendered.profile.name);
console.log(`${rendered.profile.location} | ${rendered.profile.email} | ${rendered.profile.website}`);
console.log('\nSUMMARY');
if (rendered.summary) console.log(`  ${rendered.summary}`);
console.log('\nSKILLS');
for (const [k, v] of Object.entries(rendered.skills)) console.log(`  ${k}: ${v}`);
console.log('\nEXPERIENCE');
for (const e of rendered.experience) {
  console.log(`  ${e.company} — ${e.role}  (${e.dates})`);
  for (const b of e.bullets) console.log(`    • ${b}`);
}
if (rendered.projects.length) {
  console.log('\nPROJECTS');
  for (const p of rendered.projects) {
    console.log(`  ${p.name} — ${p.stack}`);
    for (const b of p.bullets) console.log(`    • ${b}`);
  }
}
console.log('─'.repeat(78));
await closeDb();
