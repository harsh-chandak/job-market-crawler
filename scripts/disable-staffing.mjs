/**
 * Disable staffing firms, outsourcers and body shops.
 *
 * The import-time denylist matched tokens exactly, so digit-suffixed variants
 * slipped through ("Randstad4", "Collabera2", "Idexcel3"). These dominate H-1B
 * approval counts — they sponsor at huge volume — which would otherwise make
 * them look like the best sponsors in the entire dataset.
 */
import 'dotenv/config';
import { getDb, closeDb } from '../src/db.js';
import { slugKey } from '../src/sponsorship.js';

const DENY = [
  'randstad', 'collabera', 'idexcel', 'insightglobal', 'roberthalf', 'teksystems',
  'aerotek', 'adecco', 'kforce', 'apexsystems', 'motionrecruitment', 'infosys',
  'wipro', 'cognizant', 'hcl', 'ltimindtree', 'mphasis', 'tcs', 'techmahindra',
  'syntel', 'virtusa', 'ust', 'zensar', 'birlasoft', 'persistent', 'mindtree',
  'compunnel', 'artech', 'judge', 'modis', 'experis', 'volt', 'yoh', 'nlbservices',
  'diverselynx', 'mastech', 'sunera', 'infoservices', 'miraclesoftware',
  'procom', 'integratedresources', 'nlbservices', 'akraya', 'eteam',
  'nityainc', 'sunrisesystems', 'russelltobin', 'axelon', 'beaconhill',
  'accenture', 'deloitte', 'capgemini', 'atos', 'dxc', 'genpact', 'crossover',
];
const DENY_RE = [/staffing/i, /recruit/i, /consultanc/i, /outsourc/i, /bodyshop/i, /talentsolutions/i];

const db = await getDb();
const companies = db.collection('companies');
const all = await companies.find({ enabled: { $ne: false } }, { projection: { token: 1, ats: 1, sponsorship: 1 } }).toArray();

const hits = all.filter((c) => {
  const k = slugKey(c.token);
  if (DENY.some((d) => k.startsWith(d))) return true;
  return DENY_RE.some((re) => re.test(c.token));
});

if (hits.length) {
  await companies.updateMany(
    { _id: { $in: hits.map((h) => h._id) } },
    { $set: { enabled: false, disabledReason: 'staffing_or_outsourcer' } },
  );
}

console.log(`disabled ${hits.length} staffing/outsourcing boards:`);
for (const h of hits.slice(0, 20)) {
  const a = h.sponsorship?.h1bApprovals ?? 0;
  console.log(`  ${h.token.padEnd(28)} ${a ? `${a} H-1B approvals` : ''}`);
}
const left = await companies.countDocuments({ enabled: { $ne: false } });
console.log(`\n${left} boards remain enabled`);
await closeDb();
