/** Amazon + Microsoft adapter tests — no network. node scripts/test-proprietary.mjs */
import { parseLocations as azLoc, parsePostedDate, normalizeJob, searchUrl as azUrl, AMAZON_QUERIES } from '../src/adapters/amazon.js';
import { parseLocations as msLoc, normalizePosition, searchUrl as msUrl, MICROSOFT_QUERIES } from '../src/adapters/microsoft.js';

let pass = 0, fail = 0; const failures = [];
const ok = (n, c, d = '') => (c ? pass++ : (fail++, failures.push(`${n}${d ? ` — ${d}` : ''}`)));

/* ======================= AMAZON ======================= */

ok('az: url has US filter', azUrl('software engineer').includes('country%5B%5D=USA'), azUrl('x'));
ok('az: url sorted recent', azUrl('x').includes('sort=recent'));
ok('az: queries cover 3 families', AMAZON_QUERIES.length >= 6);

/* locations[] is an array of JSON-encoded STRINGS, not objects */
{
  const job = {
    location: 'US, MA, Cambridge',
    locations: [JSON.stringify({ normalizedLocation: 'Cambridge, Massachusetts, USA', city: 'Cambridge', region: 'MA', type: 'ONSITE' })],
  };
  const l = azLoc(job);
  ok('az: parses JSON-string locations', l.includes('Cambridge, Massachusetts, USA'), JSON.stringify(l));
  ok('az: keeps plain location field', l.includes('US, MA, Cambridge'));
}
{
  const l = azLoc({ location: 'US, VA, Arlington', locations: [JSON.stringify({ normalizedLocation: 'Arlington, Virginia, USA', type: 'REMOTE' })] });
  ok('az: remote type adds Remote', l.includes('Remote'), JSON.stringify(l));
}
{
  const l = azLoc({ locations: ['not json at all'], city: 'Seattle', state: 'WA' });
  ok('az: malformed entry does not throw', Array.isArray(l) && l.includes('not json at all'), JSON.stringify(l));
}
{
  const l = azLoc({ city: 'Tempe', state: 'AZ' });
  ok('az: falls back to city/state', l.includes('Tempe, AZ'), JSON.stringify(l));
}

ok('az: posted_date parsed', parsePostedDate({ posted_date: 'July 31, 2026' })?.startsWith('2026-07-31'));
ok('az: bad date -> null', parsePostedDate({ posted_date: 'sometime' }) === null);
ok('az: missing date -> null', parsePostedDate({}) === null);

{
  // qualifications carry the citizenship/clearance language more often than description
  const j = normalizeJob({
    id_icims: '10489794',
    title: 'Software Development Engineer',
    job_path: '/en/jobs/10489794/sde',
    description: 'Build things.',
    basic_qualifications: 'Must be a US citizen.',
    preferred_qualifications: '5+ years of experience',
    location: 'US, WA, Seattle',
    posted_date: 'July 31, 2026',
    is_intern: null,
  });
  ok('az: id from id_icims', j.sourceJobId === '10489794');
  ok('az: absolute applyUrl', j.applyUrl === 'https://www.amazon.jobs/en/jobs/10489794/sde', j.applyUrl);
  ok('az: quals folded into description', /US citizen/.test(j.description) && /5\+ years/.test(j.description));
  ok('az: intern flag normalized to bool', j.meta.isIntern === false);
}

/* ======================= MICROSOFT ======================= */

ok('ms: url has domain param', msUrl('software engineer').includes('domain=microsoft.com'));
ok('ms: url paginates via start', msUrl('x', 20).includes('start=20'));
ok('ms: queries defined', MICROSOFT_QUERIES.length >= 4);

{
  const p = { standardizedLocations: ['US', 'Redmond, WA, US', 'Mountain View, CA, US'], locations: ['United States, Washington, Redmond'] };
  const l = msLoc(p);
  ok('ms: prefers standardizedLocations', l.includes('Redmond, WA, US'), JSON.stringify(l));
  ok('ms: drops bare country codes', !l.includes('US'), JSON.stringify(l));
}
{
  const l = msLoc({ standardizedLocations: [], locations: ['United States, Washington, Redmond'] });
  ok('ms: falls back to verbose locations', l.includes('United States, Washington, Redmond'), JSON.stringify(l));
}
{
  const l = msLoc({ standardizedLocations: ['Redmond, WA, US'], workLocationOption: 'remote' });
  ok('ms: remote flag', l.includes('Remote'), JSON.stringify(l));
}
{
  const p = {
    id: 1970393556942068, displayJobId: '200044839',
    name: 'Software Engineer II', standardizedLocations: ['Redmond, WA, US'],
    postedTs: 1785518624, department: 'Software Engineering', positionUrl: '/careers/job/1970393556942068',
  };
  const j = normalizePosition(p);
  ok('ms: id from displayJobId', j.sourceJobId === '200044839', j.sourceJobId);
  ok('ms: unix postedTs -> ISO', j.postedAtClaimed === new Date(1785518624 * 1000).toISOString(), j.postedAtClaimed);
  ok('ms: absolute applyUrl', j.applyUrl.startsWith('https://apply.careers.microsoft.com/careers/job/'));
  ok('ms: no body at search time', j.description === '');
}
{
  const j = normalizePosition({ displayJobId: '1', name: 'X', standardizedLocations: [] });
  ok('ms: missing ts -> null', j.postedAtClaimed === null);
  ok('ms: applyUrl fallback', j.applyUrl.includes('jobs.careers.microsoft.com'), j.applyUrl);
}

/* ---- Microsoft detail hydration ----
   The search row has two identifiers and they are NOT interchangeable:
   `displayJobId` (200039153) is what we store as sourceJobId, `id`
   (1970393556872425) is what position_details wants. Passing the display id
   returns 404. The internal id is recovered from the apply URL. */
{
  const { positionIdFrom, detailUrl } = await import("../src/adapters/microsoft.js");
  ok(
    "ms: positionId from apply URL",
    positionIdFrom("https://apply.careers.microsoft.com/careers/job/1970393556872425") ===
      "1970393556872425",
  );
  ok(
    "ms: display-id URL yields no position id",
    positionIdFrom("https://jobs.careers.microsoft.com/global/en/job/200039153") === null,
  );
  ok("ms: null on empty", positionIdFrom("") === null);
  ok("ms: null on junk", positionIdFrom("https://example.com/x") === null);
  ok(
    "ms: detailUrl carries position_id and domain",
    detailUrl("https://apply.careers.microsoft.com/careers/job/1970393556872425") ===
      "https://apply.careers.microsoft.com/api/pcsx/position_details" +
        "?position_id=1970393556872425&domain=microsoft.com&hl=en",
    String(detailUrl("https://apply.careers.microsoft.com/careers/job/1970393556872425")),
  );
  ok("ms: detailUrl null when underivable", detailUrl("https://example.com/x") === null);
}


console.log(`\n  ${pass} passed, ${fail} failed`);
if (failures.length) { console.log('\n  failures:'); failures.forEach(f => console.log(`    ✗ ${f}`)); process.exit(1); }
console.log('  all green\n');
