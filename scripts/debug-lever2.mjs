const url = 'https://api.lever.co/v0/postings/CesiumAstro?mode=json';
const r0 = await fetch(url);
const etag = r0.headers.get('etag');
await r0.text();
console.log('etag:', etag, '\n');

const variants = [
  ['baseline (accept: application/json)', { accept: 'application/json', 'if-none-match': etag }],
  ['accept: */*',                          { accept: '*/*', 'if-none-match': etag }],
  ['no accept header',                     { 'if-none-match': etag }],
  ['accept-encoding: identity',            { accept: '*/*', 'accept-encoding': 'identity', 'if-none-match': etag }],
  ['strong etag (W/ stripped)',            { accept: '*/*', 'if-none-match': etag.replace(/^W\//, '') }],
  ['+ user-agent',                         { accept: '*/*', 'user-agent': 'job-hunt/0.1', 'if-none-match': etag }],
];

for (const [label, headers] of variants) {
  try {
    const r = await fetch(url, { headers });
    console.log(`  ${String(r.status).padStart(3)}  ${label}`);
    await r.text().catch(() => {});
  } catch (e) {
    console.log(`  ERR  ${label} — ${e.message}`);
  }
}
