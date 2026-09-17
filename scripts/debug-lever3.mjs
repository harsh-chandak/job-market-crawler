import https from 'node:https';

const opts = {
  hostname: 'api.lever.co',
  path: '/v0/postings/CesiumAstro?mode=json',
  method: 'GET',
};

function req(headers = {}) {
  return new Promise((resolve) => {
    const r = https.request({ ...opts, headers }, (res) => {
      res.resume();
      res.on('end', () => resolve({ status: res.statusCode, etag: res.headers.etag }));
    });
    r.on('error', (e) => resolve({ status: 0, err: e.message }));
    r.end();
  });
}

const first = await req({ accept: '*/*' });
console.log('node:https  fresh   ->', first.status, first.etag);
const second = await req({ accept: '*/*', 'if-none-match': first.etag });
console.log('node:https  replay  ->', second.status);

// same thing through fetch for comparison
const f1 = await fetch('https://api.lever.co/v0/postings/CesiumAstro?mode=json');
const fe = f1.headers.get('etag'); await f1.text();
const f2 = await fetch('https://api.lever.co/v0/postings/CesiumAstro?mode=json', { headers: { 'if-none-match': fe } });
console.log('fetch       replay  ->', f2.status);
