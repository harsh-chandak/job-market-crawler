/** Alert-email parser tests. node scripts/test-email.mjs */
import { parseAlertEmail, stripTracking, identifySource, linkToAtsCandidate, extractLinks } from '../src/adapters/email.js';

let pass = 0, fail = 0; const failures = [];
const ok = (n, c, d = '') => (c ? pass++ : (fail++, failures.push(`${n}${d ? ` — ${d}` : ''}`)));

/* ---- tracking strip ---- */
ok('strip: linkedin tracking',
  stripTracking('https://www.linkedin.com/jobs/view/4012345678/?trackingId=abc%3D&refId=xyz&lipi=urn') === 'https://www.linkedin.com/jobs/view/4012345678/',
  stripTracking('https://www.linkedin.com/jobs/view/4012345678/?trackingId=abc%3D&refId=xyz&lipi=urn'));
ok('strip: keeps meaningful params',
  stripTracking('https://www.indeed.com/viewjob?jk=abc123&utm_source=email') === 'https://www.indeed.com/viewjob?jk=abc123',
  stripTracking('https://www.indeed.com/viewjob?jk=abc123&utm_source=email'));
ok('strip: bad url passthrough', stripTracking('not a url') === 'not a url');

/* ---- source identification ---- */
{
  const r = identifySource('https://www.linkedin.com/comm/jobs/view/4012345678/?trackingId=x');
  ok('linkedin: comm url', r?.source === 'linkedin' && r.id === '4012345678', JSON.stringify(r));
  ok('linkedin: canonicalized', r?.canonical === 'https://www.linkedin.com/jobs/view/4012345678/');
}
ok('indeed: jk param', identifySource('https://www.indeed.com/viewjob?jk=9f8e7d6c5b4a3210')?.id === '9f8e7d6c5b4a3210');
ok('unknown host -> null', identifySource('https://example.com/careers/123') === null);

/* ---- ATS reconciliation ---- */
{
  const r = linkToAtsCandidate('https://job-boards.greenhouse.io/anthropic/jobs/4567890');
  ok('ats link: greenhouse', r?.ats === 'greenhouse' && r.token === 'anthropic' && r.sourceJobId === '4567890', JSON.stringify(r));
}
ok('ats link: lever', linkToAtsCandidate('https://jobs.lever.co/palantir/abc-123-def')?.token === 'palantir');
ok('ats link: none', linkToAtsCandidate('https://www.linkedin.com/jobs/view/1') === null);

/* ---- link extraction ignores junk ---- */
{
  const html = `<a href="mailto:x@y.com">m</a><a href="#top">t</a><a href="/relative">r</a><a href="https://ok.com/a">o</a>`;
  const links = extractLinks(html);
  ok('links: only absolute http(s)', links.length === 1 && links[0] === 'https://ok.com/a', JSON.stringify(links));
}

/* ---- realistic LinkedIn alert shape ---- */
const LINKEDIN_EMAIL = `
<html><body>
<table><tr><td>
  <a href="https://www.linkedin.com/comm/jobs/view/4012345678/?trackingId=aBc%3D&amp;refId=xyz">
    <strong>Software Engineer, Backend</strong>
  </a>
  <p>Anthropic</p>
  <p>San Francisco, CA (Hybrid)</p>
  <p>Posted 2 hours ago</p>
</td></tr>
<tr><td>
  <a href="https://www.linkedin.com/comm/jobs/view/4087654321/?trackingId=zZz%3D">
    <strong>Machine Learning Engineer</strong>
  </a>
  <p>Scale AI</p>
  <p>Remote</p>
</td></tr>
<tr><td>
  <a href="https://www.linkedin.com/comm/jobs/view/4012345678/?trackingId=dupe">
    <strong>Software Engineer, Backend</strong>
  </a>
</td></tr>
<tr><td><a href="https://www.linkedin.com/comm/unsubscribe?token=1">Unsubscribe</a></td></tr>
</table></body></html>`;

{
  const rows = parseAlertEmail(LINKEDIN_EMAIL);
  ok('email: parsed 2 unique jobs (dupe collapsed)', rows.length === 2, `got ${rows.length}`);
  ok('email: unsubscribe link ignored', !rows.some(r => /unsubscribe/i.test(r.applyUrl)));
  ok('email: source tagged', rows.every(r => r.source === 'linkedin'));
  ok('email: ids extracted', rows[0].sourceJobId === '4012345678' && rows[1].sourceJobId === '4087654321', rows.map(r=>r.sourceJobId).join(','));
  ok('email: tracking stripped from applyUrl', rows.every(r => !/trackingId/.test(r.applyUrl)), rows[0].applyUrl);
  ok('email: title extracted', /Software Engineer/.test(rows[0].title), JSON.stringify(rows[0].title));
  ok('email: no description (auth-walled)', rows.every(r => r.description === ''));
}

/* ---- alert that links straight at an ATS we already poll ---- */
{
  const html = `<a href="https://job-boards.greenhouse.io/anthropic/jobs/4567890?utm_source=alert"><b>Research Engineer</b></a><p>Anthropic</p><p>San Francisco, CA</p>`;
  const rows = parseAlertEmail(html, { defaultSource: 'jobright' });
  ok('email: ats candidate detected', rows[0]?.atsCandidate?.ats === 'greenhouse', JSON.stringify(rows[0]?.atsCandidate));
  ok('email: ats token captured', rows[0]?.atsCandidate?.token === 'anthropic');
  ok('email: utm stripped', !/utm_source/.test(rows[0].applyUrl), rows[0].applyUrl);
}

/* ---- empty / junk input ---- */
ok('email: empty html', parseAlertEmail('').length === 0);
ok('email: no job links', parseAlertEmail('<a href="https://example.com">hi</a>').length === 0);

console.log(`\n  ${pass} passed, ${fail} failed`);
if (failures.length) { console.log('\n  failures:'); failures.forEach(f => console.log(`    ✗ ${f}`)); process.exit(1); }
console.log('  all green\n');
