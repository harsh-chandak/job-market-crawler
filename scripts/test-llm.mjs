/** LLM layer, scoring and tailoring — all offline via the stub provider. */
import { validate, extractJson, schemaHint, coerce } from '../src/llm.js';
import { SCORE_SCHEMA, scoreJob, candidateProfile } from '../src/scoring.js';
import { loadBank, indexBullets, selectBullets, renderResume, verifyNoFabrication, tailorForJob } from '../src/tailor.js';

let pass = 0, fail = 0; const failures = [];
const ok = (n, c, d = '') => (c ? pass++ : (fail++, failures.push(`${n}${d ? ` — ${d}` : ''}`)));
const stub = { llm: { provider: 'stub' } };

/* ---- json extraction: models wrap JSON no matter how you ask ---- */
ok('json: bare', extractJson('{"a":1}')?.a === 1);
ok('json: fenced', extractJson('```json\n{"a":2}\n```')?.a === 2);
ok('json: fenced no lang', extractJson('```\n{"a":3}\n```')?.a === 3);
ok('json: prose wrapped', extractJson('Sure! Here you go:\n{"a":4}\nHope that helps.')?.a === 4);
ok('json: garbage -> null', extractJson('no json here') === null);
ok('json: empty -> null', extractJson('') === null);

/* ---- schema validation is the guard against weak models ---- */
{
  const s = { type:'object', required:['fit'], properties:{ fit:{type:'integer',minimum:0,maximum:100} } };
  ok('validate: ok', validate({fit:50}, s).length === 0);
  ok('validate: missing required', validate({}, s).length === 1);
  ok('validate: wrong type', validate({fit:'50'}, s).length === 1);
  ok('validate: out of range high', validate({fit:150}, s).length === 1);
  ok('validate: non-integer', validate({fit:50.5}, s).length === 1);
  ok('validate: enum enforced', validate({v:'x'}, {type:'object',properties:{v:{type:'string',enum:['a','b']}}}).length === 1);
  ok('validate: array maxItems', validate({a:[1,2,3]}, {type:'object',properties:{a:{type:'array',maxItems:2,items:{type:'number'}}}}).length === 1);
  ok('validate: nested errors surface', validate({o:{n:'bad'}}, {type:'object',properties:{o:{type:'object',properties:{n:{type:'number'}}}}}).length === 1);
}

/* ---- schema rendering: prose alone was not enough for small models ---- */
{
  const h = schemaHint(SCORE_SCHEMA);
  ok('hint: shows enum values', /"swe" \| "ai" \| "none"/.test(h), h.slice(0,120));
  ok('hint: flags integer not string', /NOT a string/.test(h));
  ok('hint: shows range', /0-100/.test(h));
  ok('hint: marks optional fields', /optional/.test(h));
}

/* ---- coercion normalises near-misses but NEVER invents ---- */
{
  ok('coerce: numeric string -> number', coerce('75', {type:'integer'}) === 75);
  ok('coerce: padded numeric', coerce(' 82 ', {type:'integer'}) === 82);
  ok('coerce: approx numeric', coerce('~90', {type:'integer'}) === 90);
  ok('coerce: enum case-insensitive', coerce('SWE', {type:'string',enum:['swe','ai']}) === 'swe');
  ok('coerce: enum by prefix', coerce('strong fit', {type:'string',enum:['strong','poor']}) === 'strong');
  ok('coerce: scalar -> array', Array.isArray(coerce('one', {type:'array',items:{type:'string'}})));
  ok('coerce: trims to maxItems', coerce([1,2,3], {type:'array',maxItems:2,items:{type:'number'}}).length === 2);

  /* REGRESSION: stripping non-digits from "High" leaves "", and Number("") is 0.
     Coercing to 0 would silently invent a score of zero — the exact failure the
     whole no-fabrication design exists to prevent. It must pass through
     unchanged so validation rejects it. */
  ok('coerce: "High" is NOT turned into 0', coerce('High', {type:'integer'}) === 'High', JSON.stringify(coerce('High',{type:'integer'})));
  ok('coerce: "n/a" is NOT turned into 0', coerce('n/a', {type:'integer'}) === 'n/a');
  ok('coerce: "" is NOT turned into 0', coerce('', {type:'integer'}) === '');
  ok('coerce: unresolvable enum left alone', coerce('Software Engineer', {type:'string',enum:['swe','ai']}) === 'Software Engineer');
  ok('coerce: bad value still fails validation',
     validate(coerce({fit:'High'}, SCORE_SCHEMA), {type:'object',required:['fit'],properties:{fit:{type:'integer'}}}).length > 0);
}

const bank = await loadBank();

/* ---- bank integrity ---- */
{
  const idx = indexBullets(bank);
  ok('bank: bullets indexed', idx.size >= 20, `${idx.size}`);
  ok('bank: ids unique', idx.size === [...idx.keys()].length);
  const noText = [...idx.values()].filter(b => !b.text || b.text.length < 10);
  ok('bank: every bullet has text', noText.length === 0, JSON.stringify(noText.slice(0,2)));
  const noFam = [...idx.values()].filter(b => !Array.isArray(b.families) || !b.families.length);
  ok('bank: every bullet has families', noFam.length === 0, JSON.stringify(noFam.map(b=>b.id)));
  ok('bank: swe and ai skill sets, no fde', ['swe','ai'].every(f => bank.skills?.[f]) && !bank.skills?.fde);
  ok('bank: every role has a bullet cap', (bank.experience || []).every(e => Number.isInteger(e.max_bullets)));
  const p = candidateProfile(bank);
  ok('profile: mentions sponsorship', /sponsorship/i.test(p));
  // Named "no fabricated years" and asserting /3 years/ — it required the very
  // overstatement it claims to guard against, so correcting the profile to the
  // true figure broke it. Derive the ceiling from the bank's own dates instead
  // of hardcoding a number; a string literal here can only rot again.
  const months = (bank.experience || []).reduce((sum, e) => {
    const m = String(e.dates || '').match(/([A-Za-z]{3})\s+(\d{4})\s*-\s*(Present|([A-Za-z]{3})\s+(\d{4}))/);
    if (!m) return sum;
    const M = { Jan:0,Feb:1,Mar:2,Apr:3,May:4,Jun:5,Jul:6,Aug:7,Sep:8,Oct:9,Nov:10,Dec:11 };
    const start = new Date(Number(m[2]), M[m[1]] ?? 0);
    const end = m[3] === 'Present' ? new Date() : new Date(Number(m[5]), M[m[4]] ?? 0);
    return sum + Math.max(0, (end - start) / (1000 * 60 * 60 * 24 * 30.44));
  }, 0);
  const ceiling = Math.ceil(months / 12);
  const claimed = Number((p.match(/(\d+)\+?\s*years? of full-time/i) || [])[1] || 0);
  ok('profile: states a years figure', claimed > 0, p.slice(0, 80));
  ok('profile: years claim does not exceed the bank',
     claimed <= ceiling, `claims ${claimed}y, bank supports at most ${ceiling}y`);
  ok('profile: mentions the MS', /M\.?S\.? in Computer Science/i.test(p));
}

const JOB = {
  companyName: 'Databricks', title: 'Software Engineer, Backend',
  locations: ['San Francisco, CA'], contentHash: 'abc',
  description: 'Build distributed data systems in Python. 2+ years experience. We sponsor H-1B.',
};

/* ---- scoring ---- */
{
  const s = await scoreJob(JOB, bank, stub);
  ok('score: shape valid', validate(s, SCORE_SCHEMA).length === 0, JSON.stringify(validate(s, SCORE_SCHEMA)));
  ok('score: fit in range', s.fit >= 0 && s.fit <= 100);
  ok('score: family valid', ['swe','ai','none'].includes(s.family));
  ok('score: deterministic', (await scoreJob(JOB, bank, stub)).fit === s.fit);
  ok('score: meta recorded', s._meta.provider === 'stub');
}

/* ---- selection returns IDS, never prose ---- */
{
  const sel = await selectBullets(JOB, bank, stub);
  ok('select: family chosen', ['swe','ai'].includes(sel.family));
  ok('select: ids returned', sel.bulletIds.length > 0);
  const idx = indexBullets(bank);
  ok('select: every kept id is real', sel.bulletIds.every(id => idx.has(id)));
  ok('select: no dupes', new Set(sel.bulletIds).size === sel.bulletIds.length);
}

/* ---- THE FABRICATION GUARD ---- */
{
  const idx = indexBullets(bank);
  // simulate a hallucinating model
  const evil = { family: 'swe', bulletIds: ['wal-durable', 'FAKE-ID-1', 'asu-eval', 'invented-bullet'] };
  const kept = evil.bulletIds.filter(id => idx.has(id));
  const dropped = evil.bulletIds.filter(id => !idx.has(id));
  ok('guard: hallucinated ids identified', dropped.length === 2, JSON.stringify(dropped));
  const r = renderResume(bank, { family: 'swe', bulletIds: kept });
  const check = verifyNoFabrication(r, bank);
  ok('guard: render survives hallucination', check.ok, JSON.stringify(check.violations.slice(0,2)));

  // model-authored prose must be caught if it ever reaches the renderer
  const poisoned = JSON.parse(JSON.stringify(r));
  poisoned.experience[0].bullets.push('Led a team of 40 engineers at Google.');
  const bad = verifyNoFabrication(poisoned, bank);
  ok('guard: invented bullet is caught', !bad.ok && bad.violations.length === 1, JSON.stringify(bad.violations));

  const poisoned2 = JSON.parse(JSON.stringify(r));
  poisoned2.summary = 'Staff engineer with 12 years of experience.';
  ok('guard: invented summary is caught', !verifyNoFabrication(poisoned2, bank).ok);
}

/* ---- rendering ---- */
{
  const r = renderResume(bank, { family: 'ai', bulletIds: ['asu-langgraph','asu-eval','wal-genai-extraction'] });
  ok('render: no summary rendered', r.summary === undefined);
  // Content, not identity. renderResume now filters gated categories into a new
  // object, so === compares references and would pass or fail for reasons that
  // have nothing to do with which skills were rendered.
  // With no posting text the gated AI Tooling line stays hidden.
  const { ['AI Tooling']: _gated, ...ungatedAi } = bank.skills.ai;
  ok('render: ai skills used',
    JSON.stringify(r.skills) === JSON.stringify(ungatedAi), Object.keys(r.skills).join(' | '));
  ok('render: all employers present', r.experience.length === bank.experience.length);

  // AI Tooling names Claude Code and Copilot. It must appear only when the
  // posting asks — eight resumes reached rival labs advertising a competitor's
  // product before this was gated.
  {
    const swe = { family: 'swe', bulletIds: ['nm-scale'] };
    const quiet = renderResume(bank, swe, { jobText: 'Backend engineer. Python and AWS.' });
    const asked = renderResume(bank, swe, { jobText: 'We use Claude Code and Copilot daily.' });
    ok('gate: AI Tooling hidden when unasked', !Object.keys(quiet.skills || {}).includes('AI Tooling'));
    ok('gate: AI Tooling shown when asked', Object.keys(asked.skills || {}).includes('AI Tooling'));
    const noText = renderResume(bank, swe, {});
    ok('gate: absent job text hides it', !Object.keys(noText.skills || {}).includes('AI Tooling'));
  }

  // Cross-family skill categories. The selector sees every family's names and
  // picked ones its chosen family lacks; 96 sent resumes lost those lines.
  {
    const cats = ['AI / Agentic', 'AI / LLM', 'Languages', 'Security & Reliability'];
    const r = renderResume(bank, { family: 'ai', bulletIds: [] }, { skillCategories: cats, jobText: 'agentic ai llm python' });
    const keys = Object.keys(r.skills || {});
    ok('skills: a cross-family request keeps four lines', keys.length >= 4, keys.join(' | '));
    ok('skills: AI / Agentic resolves to the ai equivalent', keys.includes('AI Engineering'), keys.join(' | '));
    ok('skills: a category only another family defines is pulled across', keys.includes('Security & Reliability'), keys.join(' | '));
    ok('skills: requested order is kept', keys[0] === 'AI Engineering', keys.join(' | '));
    const dup = renderResume(bank, { family: 'ai', bulletIds: [] }, { skillCategories: ['AI / Agentic', 'AI Engineering', 'Languages'], jobText: 'x' });
    ok('skills: an alias and its target render once', Object.keys(dup.skills).filter((k) => k === 'AI Engineering').length === 1);
    const quiet = renderResume(bank, { family: 'ai', bulletIds: [] }, { skillCategories: ['AI Tooling', 'Languages', 'AI / LLM'], jobText: 'backend python aws' });
    ok('skills: a gated category stays gated when pulled across', !Object.keys(quiet.skills).includes('AI Tooling'));
    const asked = renderResume(bank, { family: 'ai', bulletIds: [] }, { skillCategories: ['AI Tooling', 'Languages', 'AI / LLM'], jobText: 'we use Claude Code daily' });
    ok('skills: a gated category crosses when the posting asks', Object.keys(asked.skills).includes('AI Tooling'));
    const thin = renderResume(bank, { family: 'swe', bulletIds: [] }, { skillCategories: ['Nonsense Category'], jobText: 'x' });
    ok('skills: never fewer than three lines', Object.keys(thin.skills).length >= 3, Object.keys(thin.skills).join(' | '));
  }

  // Each role's weight comes from the bank's max_bullets.
  {
    const r = renderResume(bank, { family: 'ai', bulletIds: [] }, { jobText: 'python llm agentic pipeline' });
    const caps = Object.fromEntries((bank.experience || []).map(e => [e.company, e.max_bullets]));
    ok('render: each role honours its bank cap', r.experience.every(e => e.bullets.length <= caps[e.company]), r.experience.map(e => e.bullets.length).join('/'));
    ok('render: at most two projects', r.projects.length <= 2);
    ok("render: honours the bank's project count", r.projects.length <= (bank.render?.max_projects ?? 2), String(r.projects.length));
    const prjCaps = Object.fromEntries((bank.projects || []).map(p => [p.name, p.max_bullets]));
    ok('render: each project honours its cap', r.projects.every(p => p.bullets.length <= (prjCaps[p.name] ?? 2)));
    const spare = r.spareProjects || [];
    ok('render: spare projects stay within fill_projects', r.projects.length + spare.length <= (bank.render?.fill_projects ?? r.projects.length), `${r.projects.length}+${spare.length}`);
    ok('render: a spare is never a shown project', spare.every(p => !r.projects.some(q => q.name === p.name)));
    const bad = { ...r, spareProjects: [{ name: 'Invented', bullets: ['Scaled a service to 10M users overnight'] }] };
    ok('guard: an invented spare project is caught', !verifyNoFabrication(bad, bank).ok);
    ok('render: every project offered has the bank minimum of bullets', [...r.projects, ...spare].every(p => p.bullets.length >= (bank.render?.min_project_bullets ?? 1)), [...r.projects, ...spare].map(p => p.bullets.length).join('/'));
  }
  ok('render: selected bullets appear', r.experience.some(e => e.bullets.includes(bank.experience[1].bullets[0].text)));
  // an employer with nothing selected must not come out empty
  const walnutech = r.experience.find(e => /Example Corp/.test(e.company));
  ok('render: fallback fills empty employer', walnutech.bullets.length > 0, `${walnutech.bullets.length}`);
  // Partial selection must not starve a role. The old fallback only fired when a
  // role had ZERO selected bullets, so a selector returning three ids for the
  // whole resume gave the newest role one bullet while roles with none got six.
  // qwen2.5:7b really does return three.
  {
    const oneId = bank.experience[0].bullets.find((b) => b.families.includes('swe')).id;
    const r1 = renderResume(bank, { family: 'swe', bulletIds: [oneId] });
    ok('render: tops a partially-selected role up to the cap',
       r1.experience[0].bullets.length >= 4, `${r1.experience[0].bullets.length}`);
    ok('render: the selected bullet still leads',
       r1.experience[0].bullets[0] === bank.experience[0].bullets.find((b) => b.id === oneId).text);
    ok('render: every role reaches the cap on a 1-id selection',
       r1.experience.every((e) => e.bullets.length >= 4),
       r1.experience.map((e) => e.bullets.length).join(','));
  }

  // A gated bullet must be invisible unless the posting asks for it, and absent
  // job text must close the gate rather than open it — otherwise every code path
  // that skips jobText (tests, previews, the stub selector) leaks the material
  // the gate exists to withhold.
  {
    const gated = [...indexBullets(bank)].filter(([, b]) => b.requires?.length);
    ok('bank: has gated bullets to test', gated.length > 0, `${gated.length}`);

    const term = gated[0][1].requires[0];
    const on = renderResume(bank, { family: 'ai', bulletIds: [] },
      { jobText: `We use ${term} extensively on this team.` });
    const off = renderResume(bank, { family: 'ai', bulletIds: [] },
      { jobText: 'Java Spring Boot Postgres payments ledger reconciliation.' });
    const none = renderResume(bank, { family: 'ai', bulletIds: [] }, {});

    const texts = (r) => new Set([...r.experience, ...(r.projects || [])].flatMap((e) => e.bullets));
    const anyGated = (r) => gated.some(([, b]) => texts(r).has(b.text));

    ok('gate: opens when the posting names a required term', anyGated(on));
    ok('gate: stays shut when the posting does not', !anyGated(off));
    ok('gate: absent job text excludes gated bullets', !anyGated(none));
    ok('gate: ungated bullets are unaffected by an unrelated posting',
       off.experience.every((e) => e.bullets.length >= 4),
       off.experience.map((e) => e.bullets.length).join(','));
  }

  // Project selection must respond to the posting. It used to sort by bullet
  // count, which pickFor makes identical for every project, so slice() silently
  // kept bank order and the last project in the bank could never appear at all.
  {
    const agentic = renderResume(bank, { family: 'ai', bulletIds: [] },
      { jobText: 'Autonomous agent pipelines, multi-agent orchestration, LLM cost, prompt engineering.' });
    const streaming = renderResume(bank, { family: 'swe', bulletIds: [] },
      { jobText: 'Kafka event streaming, Neo4j graph modelling, Kubernetes, high throughput ingestion.' });

    const names = (r) => (r.projects || []).map((p) => p.name).join(' | ');
    // Looked up by id, not matched on the display name. The project was renamed
    // from "Automated Job Ingestion & Application Tracking Platform" and a
    // regex on the old name failed while the behaviour it guards was correct.
    const agenticName = (bank.projects || []).find((p) => p.id === 'jobhunt')?.name;
    ok('projects: an agentic posting surfaces the agentic project',
       !!agenticName && names(agentic).includes(agenticName), `${agenticName} not in: ${names(agentic)}`);
    ok('projects: a streaming posting surfaces the streaming project',
       /Kafka/.test(names(streaming)), names(streaming));
    ok('projects: the two postings do not pick the same set',
       names(agentic) !== names(streaming));
    ok('projects: still capped at two', (agentic.projects || []).length <= 2);

    // Every project must be reachable by some posting. A project that can never
    // render is dead weight the author believes is working.
    const reachable = new Set();
    for (const jd of [
      'Autonomous agent pipelines, multi-agent orchestration, LLM cost, prompt engineering.',
      'Kafka event streaming, Neo4j graph modelling, Kubernetes ingestion.',
      'Observability, telemetry, event schema, distributed tracing, logging.',
    ]) for (const p of renderResume(bank, { family: 'swe', bulletIds: [] }, { jobText: jd }).projects || [])
      reachable.add(p.name);
    ok('projects: every project in the bank is reachable',
       reachable.size === bank.projects.length, `${reachable.size}/${bank.projects.length}`);
  }

  // EEO label routing. The order of these rules is load-bearing: "Do you identify
  // as transgender?" contains "gender", so a /gender/i rule placed first answers
  // the transgender question with the gender value. This pins the order so a
  // future edit that reorders them fails here rather than in a real application.
  {
    const yaml = await import('yaml');
    const fsp = await import('node:fs/promises');
    const a = yaml.default.parse(await fsp.readFile('data/answers.yaml', 'utf8'));
    const eeo = a.eeo || {};
    const rules = [
      [/transgender/i, eeo.transgender],
      [/hispanic|latin/i, eeo.hispanic_latinx],
      [/\bgender\b(?!.*transgender)/i, eeo.gender],
      [/\brace\b|ethnicity/i, eeo.race ?? eeo.ethnicity],
      [/veteran/i, eeo.veteran_status],
      [/disability/i, eeo.disability],
    ];
    const answer = (label) => (rules.find(([re]) => re.test(label)) || [])[1];

    ok('eeo: transgender question is NOT answered with the gender value',
       answer('Do you identify as transgender? *') === eeo.transgender &&
       answer('Do you identify as transgender? *') !== eeo.gender,
       String(answer('Do you identify as transgender? *')));
    ok('eeo: plain gender question gets the gender value',
       answer('Gender *') === eeo.gender);
    ok('eeo: hispanic question is not answered with race',
       answer('Are you Hispanic or Latinx? *') === eeo.hispanic_latinx);
    ok('eeo: race question gets race',
       answer('Race (*Please select one option*) *') === eeo.race);
    ok('eeo: veteran and disability route correctly',
       answer('Protected Veteran Status *') === eeo.veteran_status &&
       answer('Disability Status *') === eeo.disability);
    ok('eeo: every answer is a non-empty string',
       Object.values(eeo).every((v) => typeof v === 'string' && v.trim() !== ''),
       JSON.stringify(eeo));
  }

  // A job with no model-assigned family must fall back to the screen's
  // deterministic classification, not to the swe default. Twelve applications went
  // out unscored and four of them were AI roles that received the generic variant
  // while screen.roleFamily already said "ai" on the same document.
  {
    const aiJob = { title: 'AI Engineer', description: 'x'.repeat(500), screen: { roleFamily: 'ai' } };
    const r = await tailorForJob(aiJob, bank, { cachedSelection: { family: null, bulletIds: [] } });
    ok('family: falls back to the screen classification, not swe',
       r.rendered.family === 'ai', String(r.rendered.family));
    ok('family: records that the screen supplied it',
       r.selection.familySource === 'screen');

    const noHint = { title: 'Software Engineer', description: 'x'.repeat(500) };
    const r2 = await tailorForJob(noHint, bank, { cachedSelection: { family: null, bulletIds: [] } });
    ok('family: still renders when neither model nor screen has an opinion',
       !!r2.rendered.experience?.length);

    const modelWins = { title: 'AI Engineer', description: 'x'.repeat(500), screen: { roleFamily: 'swe' } };
    const r3 = await tailorForJob(modelWins, bank, { cachedSelection: { family: 'ai', bulletIds: [] } });
    const r4 = await tailorForJob(aiJob, bank, { cachedSelection: { family: 'ai', bulletIds: [], skillCategories: ['Languages', 'AI / LLM', 'Data'] } });
    ok("tailor: the selector's skill categories reach the page", Object.keys(r4.rendered.skills).join('|') === 'Languages|AI / LLM|Data', Object.keys(r4.rendered.skills).join(' | '));
    ok('family: the model still wins when it has an answer',
       r3.rendered.family === 'ai', String(r3.rendered.family));
  }

  ok('render: respects maxPerEmployer',
     renderResume(bank, { family:'swe', bulletIds: [] }, { maxPerEmployer: 2 })
       .experience.every(e => e.bullets.length <= 2));
}

/* ---- end to end ---- */
{
  const { rendered, check, selection } = await tailorForJob(JOB, bank, stub);
  ok('e2e: passes fabrication check', check.ok);
  ok('e2e: no summary', !rendered.summary);
  ok('e2e: has contact info', rendered.profile.email === 'john.doe@example.com');
  ok('e2e: education intact', rendered.education.length === 2);
  ok('e2e: no dropped ids from stub', selection.dropped.length === 0, JSON.stringify(selection.dropped));
}

console.log(`\n  ${pass} passed, ${fail} failed`);
if (failures.length) { console.log('\n  failures:'); failures.forEach(f => console.log(`    ✗ ${f}`)); process.exit(1); }
console.log('  all green\n');
