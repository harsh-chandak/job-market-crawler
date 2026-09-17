/**
 * Guard against ingest/rescreen drift.
 *
 * The poller and the rescreen script both call screen(), and they once passed
 * DIFFERENT inputs — the poller dropped `locations`, so 869 non-US postings
 * passed the live path while the rescreen path correctly rejected them. Nothing
 * caught it because each path was internally consistent.
 *
 * This re-runs screen() over stored jobs and asserts the stored verdict matches.
 */
import 'dotenv/config';
import { getDb, closeDb } from '../src/db.js';
import { screen } from '../src/filter.js';

const db = await getDb();
const jobs = db.collection('jobs');
const sample = await jobs.find({}).toArray();

let mismatched = 0;
const examples = [];
for (const j of sample) {
  const fresh = screen({ title: j.title, description: j.description, locations: j.locations });
  const storedPass = j.screen?.pass === true;
  if (fresh.pass !== storedPass) {
    mismatched++;
    if (examples.length < 5) {
      examples.push(`${j.companyName} — ${j.title} | stored=${storedPass} fresh=${fresh.pass} (${fresh.reasons.join(',')})`);
    }
  }
}

console.log(`checked ${sample.length} stored jobs`);
console.log(`mismatched verdicts: ${mismatched}`);
if (mismatched) {
  console.log('\nexamples:');
  examples.forEach((e) => console.log(`  ✗ ${e}`));
  console.log('\n→ ingest and filter have drifted. Run scripts/rescreen.mjs.');
} else {
  console.log('→ ingest path and filter agree.');
}

// Second guard: nothing stored should have an empty location verdict while
// actually carrying locations — that was the exact fingerprint of the bug.
const ghost = sample.filter(
  (j) => (j.locations?.length ?? 0) > 0 && j.screen?.location?.reason === 'no_location',
);
console.log(`\njobs with locations but 'no_location' verdict: ${ghost.length}`);
if (ghost.length) console.log('→ the poller is dropping locations before screen() again.');

await closeDb();
process.exit(mismatched || ghost.length ? 1 : 0);
