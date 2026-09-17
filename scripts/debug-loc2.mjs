import 'dotenv/config';
import { getDb, closeDb } from '../src/db.js';
import { locationVerdict, classifyLocation } from '../src/util/location.js';
const db = await getDb();
const js = await db.collection('jobs').find({ companyToken: 'skydio', locations: /Zurich/ }).limit(2).toArray();
for (const j of js) {
  console.log('title    :', j.title);
  console.log('locations:', JSON.stringify(j.locations));
  console.log('per-loc  :', j.locations.map(l => `${l} => ${classifyLocation(l)}`).join(' | '));
  console.log('verdict  :', JSON.stringify(locationVerdict(j.locations)), '\n');
}
await closeDb();
