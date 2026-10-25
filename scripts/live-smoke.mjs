// Read-only compatibility check against the user's target site; never logs in or submits.
import assert from 'node:assert/strict';
const site = process.env.HOJ_CONNECTER_SITE?.replace(/\/+$/, '');
if (!site) { console.error('Set HOJ_CONNECTER_SITE to the OJ address to check, e.g. https://oj.example.com'); process.exit(1); }
for (const endpoint of ['/get-problem-list?currentPage=1&limit=2', '/get-problem-detail?problemId=P1000', '/get-contest-list?currentPage=1&limit=2']) {
  const response = await fetch(`${site}/api${endpoint}`, { signal: AbortSignal.timeout(20000), redirect: 'error' });
  assert.equal(response.status, 200);
  const json = await response.json(); assert.equal(json.status, 200);
  if (endpoint.startsWith('/get-problem-detail')) { assert.ok(json.data.problem.title); assert.ok(json.data.languages.length); assert.match(json.data.problem.examples, /<input>/); }
  else { assert.ok(Array.isArray(json.data.records)); }
  console.log(`PASS ${endpoint.split('?')[0]}${json.data.total != null ? ` (${json.data.total} records)` : ` (${json.data.problem.title})`}`);
}
