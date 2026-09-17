/**
 * Resume linter — Harvard Career Services rules, applied mechanically.
 *
 *   node scripts/lint-resume.mjs
 *
 * Checks only what can be checked without judgement. Whether a claim is TRUE is
 * not lintable and is never guessed at here; see the credibility report for
 * claims that need the candidate's own basis.
 *
 * Rules encoded (Harvard "Create a Strong Resume", top-5 mistakes + DON'Ts):
 *   - lead with an action verb, never passive constructions
 *   - no personal pronouns
 *   - no unexplained abbreviations
 *   - demonstrate results, not just responsibilities
 *   - consistent tense; concise enough to skim
 */
import { loadBank, indexBullets } from '../src/tailor.js';

const WEAK_OPENERS = [
  'responsible for', 'helped', 'worked on', 'assisted', 'participated in',
  'involved in', 'tasked with', 'duties included', 'was part of', 'contributed to',
];
const PRONOUNS = /\b(I|we|my|our|me|us)\b/;
// Harvard: "Don't abbreviate". Industry-standard tech tokens are not what that
// means — flag only opaque internal-looking ones.
const KNOWN_TOKENS = new Set(['ATS','GST','SKIP','LOCKED','AWS','ECS','EC2','S3','API','APIs','REST','GraphQL','SQL','NoSQL','LLM','AI','ML','CI','CD','P95','HTML','TLS','ERP','PRs','GenAI','RAG','BM25','MS','GPA','UI','SDK','K']);
const ABBREV = /\b([A-Z]{2,6})\b/g;
const QUANT = /\d/;
const PAST_VERB = /^[A-Z][a-z]+(ed|t|lt|ilt|ught|ade|ew|an|ok|ent)\b/;

const bank = await loadBank();
const idx = indexBullets(bank);

let issues = 0;
const rows = [];

for (const b of idx.values()) {
  const t = b.text;
  const probs = [];

  const lower = t.toLowerCase();
  for (const w of WEAK_OPENERS) if (lower.startsWith(w)) probs.push(`passive opener "${w}"`);
  if (PRONOUNS.test(t)) probs.push('personal pronoun');
  // A bullet needs a RESULT, not necessarily a number.
  //
  // The old check demanded a digit, so it flagged "serves matches with zero LLM
  // calls", "halved model calls per input" and "without taking client systems
  // offline" — all of which state an outcome precisely. Twenty of forty-one
  // bullets were flagged and nearly all were fine, which is how a check earns
  // the right to be ignored.
  //
  // Now: a digit, a spelled-out quantity, or a stated consequence all pass.
  // Nothing at all is the real defect, because that is a bullet describing
  // activity rather than impact.
  const SPELLED = /\b(zero|no |halved|half|double|doubled|triple|one|two|three|four|five|six|seven|eight|nine|ten|dozens?|hundreds?|thousands?)\b/i;
  const CONSEQUENCE =
    /\b(so |so that|without |eliminat\w+|removing|replacing|cutting|reduc\w+|instead of|no longer|could not|surfaces exactly|degrade gracefully|no-redeploy)\b/i;
  // Naming the broken state that was replaced states the change too: "Replaced
  // BackgroundTasks, which could lose work on any deploy". The humanize skill
  // prefers that shape to a tail explaining the payoff.
  const PRIOR_STATE = /\bwhich (could|had|kept)\b|\bhad (been|done)\b|\bby hand\b|\bafter one\b/i;
  if (!QUANT.test(t) && !SPELLED.test(t) && !CONSEQUENCE.test(t) && !PRIOR_STATE.test(t))
    probs.push('states activity but no result — what changed because of it?');

  const abbrevs = [...t.matchAll(ABBREV)].map((m) => m[1]).filter((a) => !KNOWN_TOKENS.has(a));
  if (abbrevs.length) probs.push(`unexplained abbrev: ${[...new Set(abbrevs)].join(',')}`);

  // A story bullet (what broke, what was decided, what changed) earns two
  // lines. check-wrap.mjs is what decides whether a length lays out cleanly;
  // this only catches a bullet running into a third line.
  if (t.length > 180) probs.push(`long (${t.length} chars — risks a third line)`);
  if (t.length < 45) probs.push(`thin (${t.length} chars)`);

  const firstWord = t.split(/\s+/)[0];
  // Hyphenated and irregular past-tense verbs are still action verbs.
  const ACTION_OPENERS = /^(Made|Wrote|Rewrote|Took|Found|Put|Built|Led|Shipped|Scaled|Designed|Drove|Cut|Owned|Ran|Set|Re-architected|Rebuilt|Integrated|Containerized|Engineered|Orchestrated|Developed|Automated|Migrated|Reduced|Delivered)/;
  if (!PAST_VERB.test(firstWord) && !ACTION_OPENERS.test(firstWord)) {
    probs.push(`opener "${firstWord}" may not be an action verb`);
  }

  // Punctuation that reads as machine-written. Em and en dashes are the
  // clearest tell: almost nobody types them by hand, so a resume full of them
  // invites the "did an AI write this?" question at exactly the wrong moment.
  // Hyphens, commas and full stops carry the same meaning and raise nothing.
  if (/[—–]/.test(t)) probs.push('em/en dash — use a comma, hyphen or full stop');

  // Buzzwords and filler. Harvard's guidance is a concrete verb, a concrete
  // object and a measurable result; these words displace one of the three.
  // "scalable" and "robust" are the worst offenders because they assert a
  // property without evidence, which is exactly what a reviewer discounts.
  const BUZZ =
    /\b(leverag\w+|utiliz\w+|spearhead\w+|delv\w+|tapestr\w+|streamlin\w+|empower\w*|foster\w*|showcas\w+|pivotal|meticulous\w*|passionat\w+|testament|elevat\w+|unlock\w*|robust|cutting[- ]edge|state[- ]of[- ]the[- ]art|seamless\w*|world[- ]class|best[- ]in[- ]class|synerg\w+|holistic|innovative|dynamic|scalable|end[- ]to[- ]end|next[- ]generation|mission[- ]critical|various|numerous|helped|assisted|worked on|responsible for|participated in|involved in)\b/gi;
  const buzz = [...new Set((t.match(BUZZ) || []).map((x) => x.toLowerCase()))];
  if (buzz.length) probs.push(`buzzword: ${buzz.join(', ')}`);

  // Internal shorthand. A reviewer outside the team reads "K=4" as noise, and
  // the plain phrasing carries the same fact — so the shorthand costs meaning
  // and buys nothing.
  const JARGON = /\bK=\d|\bRRF\b|\bQPS\b|\bSLO\b|\bWIP\b|\bPOC\b/;
  if (JARGON.test(t)) probs.push('internal shorthand a reviewer will not parse');
  if (/\bnot just\b|\bnot only\b/i.test(t)) probs.push('"not just/only" construction reads as generated');
  // A trailing participle that announces the payoff (", enabling faster X") is
  // the resume form of a narrator stating the theme. See the humanize skill.
  if (/,\s*(enabling|ensuring|resulting in|allowing|empowering|driving)\b/i.test(t))
    probs.push('trailing ", enabling/ensuring/resulting in" clause explains instead of stating');
  if (/~\d/.test(t) && (t.match(/~\d/g) || []).length > 1)
    probs.push('multiple tildes look hedged; state the figure or drop it');

  if (probs.length) { issues++; rows.push({ id: b.id, text: t, probs }); }
}

// Summaries are rendered prose too and get the same punctuation rules.
for (const [fam, raw] of Object.entries(bank.summaries || {})) {
  const t = String(raw).replace(/\s+/g, ' ').trim();
  const probs = [];
  if (/[—–]/.test(t)) probs.push('em/en dash');
  if (PRONOUNS.test(t)) probs.push('personal pronoun');
  if (!/\d/.test(t)) probs.push('no concrete figure — summaries that lead with a category label get skimmed past');
  if (t.length > 280) probs.push(`long (${t.length} chars)`);
  if (probs.length) { issues++; rows.push({ id: `summary:${fam}`, text: t, probs }); }
}

console.log(`bullets: ${idx.size}   flagged: ${issues}\n`);
for (const r of rows) {
  console.log(`✗ ${r.id}`);
  console.log(`  ${r.text.slice(0, 120)}${r.text.length > 120 ? '…' : ''}`);
  for (const p of r.probs) console.log(`    → ${p}`);
}

const lens = [...idx.values()].map((b) => b.text.length).sort((a, b) => a - b);
console.log(`\nlength: min ${lens[0]}  median ${lens[Math.floor(lens.length/2)]}  max ${lens.at(-1)}`);
// Report both, because they mean different things and the digit count alone was
// misleading: "serves matches with zero LLM calls" has no digit and is not
// unquantified.
const noDigit = [...idx.values()].filter((b) => !/\d/.test(b.text)).length;
const RESULT =
  /\d|\b(zero|no |halved|half|so |so that|without |eliminat\w+|removing|replacing|cutting|reduc\w+|no longer|could not|surfaces exactly|degrade gracefully|no-redeploy)\b/i;
const PRIOR = /\bwhich (could|had|kept)\b|\bhad (been|done)\b|\bby hand\b|\bafter one\b/i;
const noResult = [...idx.values()].filter((b) => !RESULT.test(b.text) && !PRIOR.test(b.text)).length;
console.log(`no digit: ${noDigit}/${idx.size}  ·  NO STATED RESULT: ${noResult}/${idx.size}`);

// Shape, across the whole bank. Not failures: a human writes some of each. The
// signal is sameness, every line carrying the same tail or the same three-item
// rhythm. The humanize skill aims for spread, not zero.
const all = [...idx.values()].map((b) => b.text);
const TAIL = /\bso (that )?\w|,\s*(enabling|ensuring|resulting in|allowing)\b|\binstead of\b/i;
const TRIAD = /[\w/.+-]+(?: [\w/.+-]+){0,3}, [\w/.+-]+(?: [\w/.+-]+){0,3},? and [\w/.+-]+/;
const pct = (n) => `${n}/${all.length} (${Math.round((100 * n) / all.length)}%)`;
console.log(`\nshape (humanize skill: aim for spread, not zero)`);
console.log(`  ends by explaining why it mattered: ${pct(all.filter((t) => TAIL.test(t)).length)}`);
console.log(`  three-item list:                    ${pct(all.filter((t) => TRIAD.test(t)).length)}`);
console.log(`  carries a digit:                    ${pct(all.filter((t) => /\d/.test(t)).length)}`);
const sd = Math.round(Math.sqrt(all.reduce((a, t) => a + (t.length - lens.reduce((x, y) => x + y, 0) / lens.length) ** 2, 0) / all.length));
console.log(`  length spread (sd):                 ${sd} chars`);
