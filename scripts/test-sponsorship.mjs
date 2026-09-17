/** Matcher tests — no network, no DB. node scripts/test-sponsorship.mjs */
import { aggregateH1b, buildIndex, matchCompany, classifySponsorship, slugKey, looksCapExempt } from '../src/sponsorship.js';

let pass = 0, fail = 0; const failures = [];
const ok = (n, c, d = '') => (c ? pass++ : (fail++, failures.push(`${n}${d ? ` — ${d}` : ''}`)));

const rows = [
  { 'Fiscal Year': '2023', Employer: 'SPEECHIFY INC', 'Initial Approval': '12', 'Initial Denial': '1', 'Continuing Approval': '4', 'Continuing Denial': '0', State: 'CA', City: 'SAN FRANCISCO' },
  { 'Fiscal Year': '2023', Employer: 'DOORDASH INC', 'Initial Approval': '300', 'Initial Denial': '2', 'Continuing Approval': '400', 'Continuing Denial': '1', State: 'CA', City: 'SAN FRANCISCO' },
  { 'Fiscal Year': '2023', Employer: 'INTUIT INC', 'Initial Approval': '900', 'Initial Denial': '10', 'Continuing Approval': '800', 'Continuing Denial': '5', State: 'CA', City: 'MOUNTAIN VIEW' },
  { 'Fiscal Year': '2023', Employer: 'LINKEDIN CORPORATION', 'Initial Approval': '500', 'Initial Denial': '2', 'Continuing Approval': '600', 'Continuing Denial': '1', State: 'CA', City: 'SUNNYVALE' },
  { 'Fiscal Year': '2023', Employer: 'JANE STREET CAPITAL LLC', 'Initial Approval': '40', 'Initial Denial': '0', 'Continuing Approval': '20', 'Continuing Denial': '0', State: 'NY', City: 'NEW YORK' },
  { 'Fiscal Year': '2023', Employer: 'CITIZENS FINANCIAL GROUP INC', 'Initial Approval': '30', 'Initial Denial': '0', 'Continuing Approval': '10', 'Continuing Denial': '0', State: 'RI', City: 'PROVIDENCE' },
  { 'Fiscal Year': '2023', Employer: 'ANDURIL INDUSTRIES, INC', 'Initial Approval': '25', 'Initial Denial': '0', 'Continuing Approval': '5', 'Continuing Denial': '0', State: 'AZ', City: 'PHOENIX' },
  { 'Fiscal Year': '2019', Employer: 'OLDSPONSOR SYSTEMS INC', 'Initial Approval': '3', 'Initial Denial': '0', 'Continuing Approval': '0', 'Continuing Denial': '0', State: 'TX', City: 'AUSTIN' },
  { 'Fiscal Year': '2023', Employer: 'ARIZONA STATE UNIVERSITY', 'Initial Approval': '80', 'Initial Denial': '1', 'Continuing Approval': '40', 'Continuing Denial': '0', State: 'AZ', City: 'TEMPE' },
];

const idx = buildIndex(aggregateH1b(rows));

/* ---- normalization ---- */
ok('slug: legal name despaced', slugKey('ANDURIL INDUSTRIES, INC') === 'andurilindustries', slugKey('ANDURIL INDUSTRIES, INC'));
ok('slug: token unchanged', slugKey('andurilindustries') === 'andurilindustries');
ok('slug: suffix stripped', slugKey('Speechify Inc') === 'speechify');

/* ---- exact ---- */
{
  const m = matchCompany('speechify', idx);
  ok('exact: speechify', m.matchType === 'exact' && m.rec.totalApprovals === 16);
}
{
  const m = matchCompany('andurilindustries', idx);
  ok('exact: anduril despaced legal name', m.matchType === 'exact', JSON.stringify(m.matchType));
  ok('anduril flagged phoenix', m.rec?.phoenix === true);
}

/* ---- REGRESSION: the two false positives from the live run ---- */
{
  const m = matchCompany('Intuitive', idx);
  ok('REJECTS intuitive -> INTUIT', m.rec === null, `matched ${m.rec?.names?.[0]}`);
}
{
  const m = matchCompany('Citizen', idx);
  ok('REJECTS citizen -> CITIZENS FINANCIAL', m.rec === null, `matched ${m.rec?.names?.[0]}`);
}

/* ---- legitimate prefix matches must survive ---- */
{
  const m = matchCompany('LinkedIn3', idx);
  ok('ACCEPTS LinkedIn3 -> LINKEDIN (numeric suffix)', m.matchType === 'prefix' && /LINKEDIN/.test(m.rec.names[0]), JSON.stringify(m.matchType));
}
{
  const m = matchCompany('janestreet', idx);
  ok('ACCEPTS janestreet -> JANE STREET CAPITAL', m.matchType === 'prefix' && /JANE STREET/.test(m.rec.names[0]), JSON.stringify(m.matchType));
}
{
  const m = matchCompany('doordashusa', idx);
  ok('ACCEPTS doordashusa -> DOORDASH (geo qualifier)', m.matchType === 'prefix' && /DOORDASH/.test(m.rec.names[0]), JSON.stringify(m.matchType));
}
{
  const m = matchCompany('intuitiveglobal', idx);
  ok('still REJECTS intuitive+qualifier -> INTUIT', m.rec === null, `matched ${m.rec?.names?.[0]}`);
}
{
  const m = matchCompany('notarealcompanyxyz', idx);
  ok('no match for unknown token', m.rec === null);
}

/* ---- classification ---- */
{
  const c = classifySponsorship(matchCompany('speechify', idx).rec);
  ok('classify: strong (recent + volume)', c.status === 'strong', c.status);
  ok('classify: approval rate computed', c.approvalRate > 0.9);
}
{
  const c = classifySponsorship(matchCompany('oldsponsorsystems', idx).rec);
  ok('classify: stale record is yes/stale', c.status === 'yes' && c.confidence === 'stale', `${c.status}/${c.confidence}`);
}
{
  const c = classifySponsorship(null);
  ok('classify: no record is none + no_record', c.status === 'none' && c.confidence === 'no_record');
  ok('classify: absence is not a false claim', c.capExempt === false && c.h1bApprovals === 0);
}
{
  const c = classifySponsorship(matchCompany('arizonastateuniversity', idx).rec);
  ok('classify: university is cap_exempt', c.status === 'cap_exempt', c.status);
}
ok('capExempt: university', looksCapExempt('ARIZONA STATE UNIVERSITY'));
ok('capExempt: hospital', looksCapExempt('MASS GENERAL HOSPITAL'));
ok('capExempt: not a normal corp', !looksCapExempt('SNOWFLAKE INC'));

console.log(`\n  ${pass} passed, ${fail} failed`);
if (failures.length) { console.log('\n  failures:'); failures.forEach(f => console.log(`    ✗ ${f}`)); process.exit(1); }
console.log('  all green\n');
