/** BofA adapter tests — no network. node scripts/test-bofa.mjs */
import { parsePostedDate, parseLocations, normalizeJob, searchUrl } from '../src/adapters/bofa.js';

let pass = 0, fail = 0; const failures = [];
const ok = (n, c, d = '') => (c ? pass++ : (fail++, failures.push(`${n}${d ? ` — ${d}` : ''}`)));

/* url: `start` is an offset WITHIN the returned set, not a cursor — so there is
   no page loop and the url must always request from 0. */
ok('url: always start=0', searchUrl(500).includes('start=0'), searchUrl(500));
ok('url: rows is the total fetched', searchUrl(500).includes('rows=500'));
ok('url: getAllJobs mode', searchUrl().includes('search=getAllJobs'));

/* dates are MM/DD/YYYY */
ok('date: MM/DD/YYYY', parsePostedDate('08/01/2026')?.startsWith('2026-08-01'), parsePostedDate('08/01/2026'));
ok('date: single-digit month', parsePostedDate('8/1/2026')?.startsWith('2026-08-01'));
ok('date: null on empty', parsePostedDate('') === null);
ok('date: null on junk', parsePostedDate('not a date') === null);
ok('date: ISO passthrough', parsePostedDate('2026-08-01T00:00:00Z')?.startsWith('2026-08-01'));

/* locations: additionalLocations is a comma-joined list of
   "US - SC - Charleston - 540 Folly Rd (SC1344)" — the street/branch must go */
{
  const l = parseLocations({
    city: 'Charlotte', stateAbbriviation: 'NC',
    additionalLocations: 'US - SC - Charleston - 540 Folly Rd (SC1344),US - SC - Mount Pleasant - 1020 Anna Knapp Blvd',
  });
  ok('loc: primary city/state', l.includes('Charlotte, NC'), JSON.stringify(l));
  ok('loc: strips street address', l.some(x => x === 'US, SC, Charleston'), JSON.stringify(l));
  ok('loc: no branch codes leak', !l.some(x => /SC1344|Folly Rd/.test(x)), JSON.stringify(l));
}
{
  const l = parseLocations({ city: 'Seattle', state: 'WA', timeType: 'Remote' });
  ok('loc: remote flag', l.includes('Remote'), JSON.stringify(l));
}
{
  const l = parseLocations({});
  ok('loc: empty input safe', Array.isArray(l) && l.length === 0);
}
{
  const l = parseLocations({ city: 'X', state: 'NY', additionalLocationsList: ['US - NY - New York - 1 Bryant Park'] });
  ok('loc: array form handled', l.some(x => x === 'US, NY, New York'), JSON.stringify(l));
}

/* normalization — the payload carries structured YoE, which beats regexing prose */
{
  const j = normalizeJob({
    jobRequisitionId: '26026551',
    postingTitle: 'Software Engineer II',
    jobDescriptionExternal: 'Build banking systems.',
    city: 'Charlotte', stateAbbriviation: 'NC',
    postedDate: '08/01/2026',
    minYearsOfExperience: 3, maxYearsOfExperience: 5,
    jcrURL: '/en-us/job-detail/26026551/software-engineer-ii',
    lob: 'Global Technology', family: 'Technology',
  });
  ok('norm: id from jobRequisitionId', j.sourceJobId === '26026551');
  ok('norm: description present', /banking systems/.test(j.description));
  ok('norm: absolute applyUrl', j.applyUrl === 'https://careers.bankofamerica.com/en-us/job-detail/26026551/software-engineer-ii', j.applyUrl);
  ok('norm: structured YoE surfaced', j.meta.minYoE === 3 && j.meta.maxYoE === 5);
  ok('norm: posted parsed', j.postedAtClaimed?.startsWith('2026-08-01'));
}
{
  const j = normalizeJob({ jobRequisitionId: '1', postingTitle: 'X', externalUrl: 'https://elsewhere.com/j/1' });
  ok('norm: absolute externalUrl kept', j.applyUrl === 'https://elsewhere.com/j/1', j.applyUrl);
  ok('norm: missing YoE -> null', j.meta.minYoE === null);
}
{
  const j = normalizeJob({});
  ok('norm: empty job yields empty id', j.sourceJobId === '');
}

console.log(`\n  ${pass} passed, ${fail} failed`);
if (failures.length) { console.log('\n  failures:'); failures.forEach(f => console.log(`    ✗ ${f}`)); process.exit(1); }
console.log('  all green\n');
