import 'dotenv/config';
import { getDb, closeDb } from '../src/db.js';
const db = await getDb();
const c = await db.collection('companies').findOne({ ats: 'lever', etag: { $ne: null } });
console.log('stored token:', c.token);
console.log('stored etag: ', JSON.stringify(c.etag));

const url = `https://api.lever.co/v0/postings/${c.token}?mode=json`;

// 1. plain fetch, capture etag
const r1 = await fetch(url, { headers: { 'user-agent': 'job-hunt/0.1', accept: 'application/json' } });
const e1 = r1.headers.get('etag');
console.log('\nfresh fetch etag:', JSON.stringify(e1));
console.log('content-encoding:', r1.headers.get('content-encoding'));
await r1.text();

// 2. replay it immediately
const r2 = await fetch(url, { headers: { 'user-agent': 'job-hunt/0.1', accept: 'application/json', 'if-none-match': e1 } });
console.log('replay same-request etag ->', r2.status);

// 3. replay the STORED etag
const r3 = await fetch(url, { headers: { 'user-agent': 'job-hunt/0.1', accept: 'application/json', 'if-none-match': c.etag } });
console.log('replay stored etag      ->', r3.status);
console.log('stored === fresh?', c.etag === e1);
await closeDb();
