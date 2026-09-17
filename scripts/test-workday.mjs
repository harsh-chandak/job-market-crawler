/** Workday adapter unit tests — no network. node scripts/test-workday.mjs */
import { parsePostedOn, splitBulletFields, normalizePosting, jobUrl, boardUrl } from '../src/adapters/workday.js';

let pass = 0, fail = 0; const failures = [];
const ok = (n, c, d = '') => (c ? pass++ : (fail++, failures.push(`${n}${d ? ` — ${d}` : ''}`)));
const NOW = new Date('2026-08-01T12:00:00Z');
const days = (d) => new Date(NOW.getTime() - d * 86400000).toISOString();

const CO = { ats: 'workday', token: 'boeing', wdHost: 'wd1', wdSite: 'EXTERNAL_CAREERS' };

/* ---- urls ---- */
ok('boardUrl', boardUrl(CO) === 'https://boeing.wd1.myworkdayjobs.com/wday/cxs/boeing/EXTERNAL_CAREERS/jobs', boardUrl(CO));
ok('jobUrl', jobUrl(CO, '/job/USA---Berkeley-MO/Tech_JR1') === 'https://boeing.wd1.myworkdayjobs.com/en-US/EXTERNAL_CAREERS/job/USA---Berkeley-MO/Tech_JR1');

/* ---- relative posted dates ---- */
ok('postedOn: Today', parsePostedOn('Posted Today', NOW).toISOString() === NOW.toISOString());
ok('postedOn: Yesterday', parsePostedOn('Posted Yesterday', NOW).toISOString() === days(1));
ok('postedOn: 3 Days Ago', parsePostedOn('Posted 3 Days Ago', NOW).toISOString() === days(3));
ok('postedOn: 30+ Days Ago', parsePostedOn('Posted 30+ Days Ago', NOW).toISOString() === days(30));
ok('postedOn: null on junk', parsePostedOn('whenever', NOW) === null);
ok('postedOn: null on empty', parsePostedOn('', NOW) === null);

/* ---- bulletFields is positional and inconsistent across tenants ---- */
{
  // Parsons: ["US - TX (Field Location)", "R184158"]
  const r = splitBulletFields(['US - TX (Field Location)', 'R184158']);
  ok('bullets: location + reqId', r.reqId === 'R184158' && r.locations[0] === 'US - TX (Field Location)', JSON.stringify(r));
}
{
  // Boeing: ["JR2026503880"] only
  const r = splitBulletFields(['JR2026503880']);
  ok('bullets: reqId only', r.reqId === 'JR2026503880' && r.locations.length === 0, JSON.stringify(r));
}
{
  const r = splitBulletFields([]);
  ok('bullets: empty', r.reqId === null && r.locations.length === 0);
}
{
  // no identifier-looking tail — treat everything as location
  const r = splitBulletFields(['Seattle, WA']);
  ok('bullets: no reqId', r.reqId === null && r.locations[0] === 'Seattle, WA', JSON.stringify(r));
}

/* ---- normalization ---- */
{
  const p = {
    title: 'Software Engineer',
    externalPath: '/job/USA---Seattle-WA/Software-Engineer_JR123',
    locationsText: 'USA - Seattle, WA',
    postedOn: 'Posted Today',
    bulletFields: ['JR123'],
  };
  const j = normalizePosting(p, CO, NOW);
  ok('normalize: id from bulletFields', j.sourceJobId === 'JR123', j.sourceJobId);
  ok('normalize: title', j.title === 'Software Engineer');
  ok('normalize: location', j.locations.includes('USA - Seattle, WA'));
  ok('normalize: applyUrl absolute', j.applyUrl.startsWith('https://boeing.wd1.myworkdayjobs.com/en-US/EXTERNAL_CAREERS/job/'));
  ok('normalize: postedAt parsed', j.postedAtClaimed === NOW.toISOString());
  ok('normalize: no description at poll time', j.description === '');
}
{
  // Parsons shape: no locationsText, location hides in bulletFields
  const p = {
    title: 'Electronics Technician',
    externalPath: '/job/US---TX-Field-Location/Electronics-Technician_R184158',
    bulletFields: ['US - TX (Field Location)', 'R184158'],
  };
  const j = normalizePosting(p, CO, NOW);
  ok('normalize: location recovered from bulletFields', j.locations.includes('US - TX (Field Location)'), JSON.stringify(j.locations));
  ok('normalize: id from bulletFields tail', j.sourceJobId === 'R184158');
  ok('normalize: null postedAt when absent', j.postedAtClaimed === null);
}
{
  const p = { title: 'Remote Role', externalPath: '/job/X/Remote-Role_R1', remoteType: 'Fully Remote', bulletFields: ['R1'] };
  const j = normalizePosting(p, CO, NOW);
  ok('normalize: remoteType adds Remote', j.locations.includes('Remote'), JSON.stringify(j.locations));
}
{
  // falls back to the externalPath tail when bulletFields carries no id
  const p = { title: 'X', externalPath: '/job/Loc/Some-Title_R999', bulletFields: ['Austin, TX'] };
  const j = normalizePosting(p, CO, NOW);
  ok('normalize: id falls back to path tail', j.sourceJobId === 'Some-Title_R999', j.sourceJobId);
}

console.log(`\n  ${pass} passed, ${fail} failed`);
if (failures.length) { console.log('\n  failures:'); failures.forEach(f => console.log(`    ✗ ${f}`)); process.exit(1); }
console.log('  all green\n');
