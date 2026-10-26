import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HojClient, ApiError, passwordKey, tokenKey } from '../src/api';
import { compareOutput, contestClock, isPending, normalizeSiteUrl, parseSamples, problemKey, safeSegment, scoreText, validateApiPath } from '../src/domain';
import { expandCommand, runProcess } from '../src/process';
import { fixture } from './fixture';
import * as path from 'node:path';
import { suggestLanguage } from '../src/language';
import { renderMarkdown } from '../src/markdown';
import './toolchains';
import './ranks';

test('HOJ session, pagination, team/contest routing, submit identity and score use real HTTP', async () => {
  const mock = await fixture();
  try {
    const values = new Map<string, string>(); const secrets = { get: async (k: string) => values.get(k), store: async (k: string, v: string) => { values.set(k, v); } };
    const site = { id: 'school', name: 'School', url: mock.url, apiPath: '/api' };
    const alice = { id: 'a', siteId: site.id, username: 'alice' }, bob = { id: 'b', siteId: site.id, username: 'bob' };
    const client = new HojClient(site, secrets, alice);
    const login = await client.login('alice', 'secret'); assert.equal(login.token, 'token-alice');
    assert.equal(mock.requests.at(-1)!.authorization, undefined);
    await secrets.store(tokenKey(site.id, alice.id), login.token);
    await secrets.store(tokenKey(site.id, bob.id), 'bob-token');
    const scope = { siteId: site.id, accountId: alice.id, groupId: 7, contestId: 12 };
    const detail = await client.problem(scope, 'A');
    assert.equal(mock.requests.at(-1)!.query.get('displayId'), 'A');
    assert.equal(mock.requests.at(-1)!.query.get('cid'), '12');
    assert.equal(mock.requests.at(-1)!.authorization, 'token-alice');
    await client.problems({ siteId: site.id, groupId: 7 }, 2, 30);
    assert.equal(mock.requests.at(-1)!.path, '/group/get-problem-list'); assert.equal(mock.requests.at(-1)!.query.get('currentPage'), '2');
    await client.problems(scope, 1, 30); assert.equal(mock.requests.at(-1)!.path, '/get-contest-problem');
    await client.groups(1, 30); assert.equal(mock.requests.at(-1)!.query.get('onlyMine'), 'true');
    await client.contests(scope, 1, 30); assert.equal(mock.requests.at(-1)!.path, '/group/get-contest-list');
    await client.registerContest(12, 'password'); assert.deepEqual(mock.requests.at(-1)!.body, { cid: 12, password: 'password' });
    const submission = await client.submit({ displayId: 'A', scope, detail }, 'C++', 'int main(){}');
    assert.equal(submission.submitId, 42);
    assert.deepEqual(mock.requests.at(-1)!.body, { pid: 'A', language: 'C++', code: 'int main(){}', cid: 12, gid: 7, tid: null, isRemote: false });
    assert.equal(isPending((await client.submission(42)).status), true);
    assert.equal(mock.requests.some(r => r.path === '/get-all-case-result'), false, 'pending submissions must not fetch incomplete cases');
    const result = await client.submission(42); assert.equal(isPending(result.status), false); assert.equal(scoreText(result), '75 分');
    assert.equal(result.caseResult?.judgeCaseList?.length, 4);
    assert.equal(result.caseResult?.judgeCaseList?.[2].userOutput, 'wrong answer: expected 42, found 41');
    assert.equal(mock.requests.at(-1)!.query.get('submitId'), '42'); assert.equal(mock.requests.at(-1)!.authorization, 'token-alice');
    await client.submissions(scope, 'A', 1, 30); assert.equal(mock.requests.at(-1)!.query.get('contestID'), '12'); assert.equal(mock.requests.at(-1)!.query.get('problemID'), 'A'); assert.equal(mock.requests.at(-1)!.query.get('beforeContestSubmit'), 'false');
    assert.equal(mock.requests.at(-1)!.query.get('onlyMine'), 'true'); assert.equal(mock.requests.at(-1)!.query.has('status'), false);
    await client.submissions(scope, 'A', 2, 30, { onlyMine: false, status: 0, username: 'bob' });
    const all = mock.requests.at(-1)!.query;
    assert.equal(all.get('onlyMine'), 'false'); assert.equal(all.get('status'), '0'); assert.equal(all.get('username'), 'bob'); assert.equal(all.get('currentPage'), '2');
    await client.submissions(scope, 'A', 1, 30, { onlyMine: true, username: 'bob' }); assert.equal(mock.requests.at(-1)!.query.has('username'), false, 'only-mine ignores a username filter');
    await client.request('/refresh'); assert.equal(values.get(tokenKey(site.id, alice.id)), 'renewed-token'); assert.equal(values.get(tokenKey(site.id, bob.id)), 'bob-token');
    await new HojClient(site, secrets, bob).identity(); assert.equal(mock.requests.at(-1)!.authorization, 'bob-token');
    const imported = { id: 'import', siteId: site.id, username: '' };
    values.set(tokenKey(site.id, imported.id), `header.${Buffer.from(JSON.stringify({ sub: 'alice-uid' })).toString('base64url')}.signature`);
    assert.equal((await new HojClient(site, secrets, imported).identity()).username, 'alice');
    assert.equal(mock.requests.at(-1)!.query.has('uid'), false); assert.equal(mock.requests.at(-1)!.query.has('username'), false);
    await new HojClient(site, secrets).problems({ siteId: site.id }, 1, 5); assert.equal(mock.requests.at(-1)!.authorization, undefined);
    await assert.rejects(client.request('/denied'), e => e instanceof ApiError && e.status === 401 && /登录/.test(e.message));
    await assert.rejects(client.request('/html'), /JSON/);
    await assert.rejects(client.request('/redirect'), /无法连接/);
  } finally { await mock.close(); }
});

test('expired sessions log in again once with the saved password and retry', async () => {
  const mock = await fixture();
  try {
    const values = new Map<string, string>(); const secrets = { get: async (k: string) => values.get(k), store: async (k: string, v: string) => { values.set(k, v); } };
    const site = { id: 'school', name: 'School', url: mock.url, apiPath: '/api' };
    const alice = { id: 'a', siteId: site.id, username: 'alice' };
    const client = new HojClient(site, secrets, alice);
    values.set(tokenKey(site.id, alice.id), 'expired');
    await assert.rejects(client.request('/session'), e => e instanceof ApiError && e.status === 401, 'without a saved password the 401 surfaces');
    assert.equal(mock.requests.some(r => r.path === '/login'), false);
    values.set(passwordKey(site.id, alice.id), 'secret');
    const results = await Promise.all([client.request('/session'), client.request('/session'), new HojClient(site, secrets, alice).request('/session')]);
    assert.ok(results.every(r => (r.data as { ok: boolean }).ok));
    assert.equal(mock.requests.filter(r => r.path === '/login').length, 1, 'concurrent 401s share one login');
    assert.deepEqual(mock.requests.find(r => r.path === '/login')!.body, { username: 'alice', password: 'secret' });
    assert.equal(values.get(tokenKey(site.id, alice.id)), 'token-alice');
    assert.equal(mock.requests.at(-1)!.authorization, 'token-alice');
    values.set(tokenKey(site.id, alice.id), 'expired'); values.set(passwordKey(site.id, alice.id), 'wrong');
    await assert.rejects(client.request('/session'), e => e instanceof ApiError && e.status === 401 && /自动重新登录失败/.test(e.message));
    await assert.rejects(client.request('/denied'), /自动重新登录失败/);
    await assert.rejects(new HojClient(site, secrets).request('/session'), e => e instanceof ApiError && e.status === 401, 'guests never log in');
  } finally { await mock.close(); }
});

test('submission case details support subtasks and preserve the verdict/code when details are unavailable', async () => {
  const mock = await fixture();
  try {
    const client = new HojClient({ id: 'fixture', name: 'Fixture', url: mock.url, apiPath: '/api' }, { get: async () => undefined, store: async () => {} });
    mock.setSubmission({ status: 8 });
    const subtask = { judgeCaseMode: 'subtask_lowest', subTaskJudgeCaseVoList: [
      { groupNum: 1, status: 3, score: 0, ac: 0, total: 2, subtaskDetailList: [{ status: 3, time: 0, memory: 0, userOutput: 'SIGSEGV' }, { status: -4 }] }
    ] };
    mock.setCaseResult(subtask);
    assert.deepEqual((await client.submission(42)).caseResult, subtask);
    mock.setCaseResult([{ status: -1, userOutput: 'expected 42' }]);
    assert.equal((await client.submission(42)).caseResult?.judgeCaseList?.[0].userOutput, 'expected 42');
    for (const data of [null, { judgeCaseMode: 'default', judgeCaseList: [] }]) {
      mock.setCaseResult(data);
      const result = await client.submission(42);
      assert.deepEqual(result.caseResult, data); assert.equal(result.caseResultError, undefined);
    }
    for (const status of [401, 403, 404, 500]) {
      mock.setCaseResult(null, status);
      const result = await client.submission(42);
      assert.equal(result.status, 8); assert.equal(result.code, 'console.log(1)');
      assert.ok(result.caseResultError); assert.equal(result.caseResult, undefined);
    }
    for (const invalid of [{ unexpected: true }, [null], { judgeCaseList: [null] }, { judgeCaseList: [], subTaskJudgeCaseVoList: {} },
      { subTaskJudgeCaseVoList: [null] }, { subTaskJudgeCaseVoList: [{ subtaskDetailList: {} }] }]) {
      mock.setCaseResult(invalid);
      const result = await client.submission(42);
      assert.match(result.caseResultError!, /测试点详情格式/); assert.equal(result.caseResult, undefined);
    }
    mock.setSubmission({ status: -2, errorMessage: 'error: missing semicolon' });
    mock.setCaseResult({ judgeCaseMode: 'default', judgeCaseList: [] });
    assert.equal((await client.submission(42)).errorMessage, 'error: missing semicolon');
    for (const status of [5, 6, 7, 9]) {
      mock.setSubmission({ status }); const reads = mock.requests.length;
      assert.equal((await client.submission(42)).caseResult, undefined);
      assert.equal(mock.requests.length, reads + 1);
    }
  } finally { await mock.close(); }
});

test('last accepted code uses authenticated numeric problem IDs and contest context; missing or invalid code fails', async () => {
  const mock = await fixture();
  try {
    const site = { id: 'school', name: 'School', url: mock.url, apiPath: '/api' };
    const account = { id: 'alice', siteId: site.id, username: 'alice' };
    const secrets = { get: async () => 'alice-token', store: async () => {} };
    const problem = { displayId: '01', detail: mock.detail, scope: { siteId: site.id, accountId: account.id, groupId: 7, contestId: 12 } };
    await assert.rejects(new HojClient(site, secrets).lastAcceptedCode(problem), /请先登录/);
    assert.equal(mock.requests.length, 0);
    const client = new HojClient(site, secrets, account);
    assert.deepEqual(await client.lastAcceptedCode(problem), { code: 'console.log(3);\n', language: 'JavaScript' });
    assert.equal(mock.requests.at(-1)!.authorization, 'alice-token');
    assert.equal(mock.requests.at(-1)!.path, '/get-last-ac-code');
    assert.deepEqual(Object.fromEntries(mock.requests.at(-1)!.query), { pid: '10', cid: '12' });
    await client.lastAcceptedCode({ ...problem, scope: { siteId: site.id, accountId: account.id, groupId: 7 } });
    assert.deepEqual(Object.fromEntries(mock.requests.at(-1)!.query), { pid: '10' });
    mock.setAcceptedCode(null); await assert.rejects(client.lastAcceptedCode(problem), /没有可获取/);
    for (const value of [{}, { code: '' }, { code: '   ' }, { code: 42 }, { code: 'hello', language: 42 }]) {
      mock.setAcceptedCode(value); await assert.rejects(client.lastAcceptedCode(problem), /未返回有效/);
    }
    mock.setAcceptedCode(null, 403); await assert.rejects(client.lastAcceptedCode(problem), error => error instanceof ApiError && error.status === 403);
  } finally { await mock.close(); }
});

test('HOJ samples preserve literal code/data and whitespace; file bindings isolate site, account and contest', () => {
  assert.deepEqual(parseSamples('<input>\n&lt; 1\n</input><output>2\n</output>'), [{ input: '\n&lt; 1\n', output: '2\n' }]);
  assert.equal(parseSamples('[{"input":"1","output":"2"}]').length, 1);
  assert.deepEqual(parseSamples('bad sample'), []);
  const scope = { siteId: 'one', accountId: 'alice', contestId: 1 };
  const keys = [problemKey(scope, 'A'), problemKey({ ...scope, siteId: 'two' }, 'A'), problemKey({ ...scope, accountId: 'bob' }, 'A'), problemKey({ ...scope, contestId: 2 }, 'A'), problemKey(scope, 'B')];
  assert.equal(new Set(keys).size, 5);
  assert.equal(compareOutput('1 2 \r\n\r\n', '1 2\n', 'trimEnd'), true);
  assert.equal(compareOutput('1\n2', '1 2', 'trimEnd'), false);
  assert.equal(compareOutput('1\n2', '1 2', 'tokens'), true);
  assert.equal(compareOutput('3\n', '3', 'exact'), false);
  assert.equal(isPending(9), true); assert.equal(isPending(8), false);
  assert.match(safeSegment('../CON/.'), /^_/); assert.equal(safeSegment('CON'), '_CON');
  assert.equal(normalizeSiteUrl(' http://localhost/oj/ '), 'http://localhost/oj');
  assert.throws(() => normalizeSiteUrl('https://user:pass@example.com'));
  assert.throws(() => validateApiPath('//elsewhere/api')); assert.equal(validateApiPath('/api/'), '/api');
  const contest = { id: 1, title: 'Contest', startTime: '2026-10-18T00:00:00Z', endTime: '2026-10-18T02:00:00Z' };
  assert.equal(contestClock(contest, Date.parse('2026-10-18T01:00:00Z')), '剩余 01:00:00');
});

test('local process reads stdin, preserves arguments with spaces, reports nonzero exit and compares WA', async () => {
  const result = await runProcess([process.execPath, '-e', "let s='';process.stdin.on('data',x=>s+=x);process.stdin.on('end',()=>console.log(s.trim().split(/\\s+/).map(Number).reduce((a,b)=>a+b,0)))"], process.cwd(), '20 22\n', 3000, 8192);
  assert.equal(result.code, 0); assert.equal(compareOutput(result.stdout, '42', 'trimEnd'), true); assert.equal(compareOutput(result.stdout, '43', 'trimEnd'), false);
  const args = expandCommand(['node', '${file}', '${output}', '$(not-a-shell)'], path.join(process.cwd(), 'folder with spaces', 'Main.js'), path.join(process.cwd(), 'build dir'));
  assert.equal(args.length, 4); assert.ok(args[1].includes('folder with spaces')); assert.equal(args[3], '$(not-a-shell)');
  const failure = await runProcess([process.execPath, '-e', "process.stderr.write('bad');process.exit(3)"], process.cwd(), '', 2000, 8192);
  assert.equal(failure.code, 3); assert.equal(failure.stderr, 'bad');
  await assert.rejects(runProcess(['hoj-connecter-this-executable-does-not-exist'], process.cwd(), '', 1000, 1024), /无法启动/);
});

test('local timeout, output cap and cancellation stop real child processes', async () => {
  const timeout = await runProcess([process.execPath, '-e', 'setInterval(()=>{},100)'], process.cwd(), '', 150, 4096);
  assert.equal(timeout.timedOut, true); assert.ok(timeout.elapsed < 5000);
  const overflow = await runProcess([process.execPath, '-e', "for(;;)process.stdout.write('a'.repeat(4096))"], process.cwd(), '', 3000, 1024);
  assert.equal(overflow.outputExceeded, true); assert.ok(Buffer.byteLength(overflow.stdout) <= 1024);
  const abort = new AbortController();
  const cancellation = { get isCancellationRequested() { return abort.signal.aborted; }, onCancellationRequested(fn: () => void) { abort.signal.addEventListener('abort', fn); return { dispose() { abort.signal.removeEventListener('abort', fn); } }; } };
  const pending = runProcess([process.execPath, '-e', 'setInterval(()=>{},100)'], process.cwd(), '', 3000, 4096, cancellation);
  setTimeout(() => abort.abort(), 150); assert.equal((await pending).cancelled, true);
});

test('submission language recommendation respects the file, allowed languages, C++ standards and Python version', () => {
  const allowed = ['C', 'C++', 'C++ 17', 'C++ 20', 'Java', 'Python3', 'Python2', 'JavaScript'];
  assert.equal(suggestLanguage(allowed, 'C++', { fileName: 'Main.py' })?.language, 'Python3');
  assert.equal(suggestLanguage(allowed, 'C++', { fileName: 'Main.js', languageId: 'javascript' })?.language, 'JavaScript');
  assert.equal(suggestLanguage(allowed, 'C++', { fileName: 'Main.c' })?.language, 'C');
  assert.equal(suggestLanguage(allowed, 'C++', { fileName: 'Main.java' })?.language, 'Java');
  assert.equal(suggestLanguage(allowed, 'C++', { fileName: 'Main.py', source: 'n = raw_input()' })?.language, 'Python2');
  assert.equal(suggestLanguage(allowed, 'C++', { fileName: 'Main.cpp', source: '#include <ranges>\nint main(){}' })?.language, 'C++ 20');
  assert.equal(suggestLanguage(['C++ 17'], 'C++', { fileName: 'Main.cpp', source: '#include <ranges>' })?.compatible, false);
  assert.equal(suggestLanguage(['C++'], 'C++', { fileName: 'Main.py' }), undefined);
  assert.equal(suggestLanguage(allowed, 'C++', { fileName: 'Main.cs' }), undefined);
  assert.equal(suggestLanguage(['C++ 17', 'Python3'], 'C++ 20')?.language, 'C++ 17');
  assert.equal(suggestLanguage(['GNU G++17', 'GNU G++20'], 'C++', { fileName: 'Main.cpp' })?.language, 'GNU G++17');
});

test('sidebar Markdown renders formulas and tables while keeping remote content inert', () => {
  const html = renderMarkdown('# 题面\n\n$x^2$\n\n$$\n\\frac{a}{b}\n$$\n\n|a|b|\n|-|-|\n|1|2|\n\n<script>alert(1)</script>\n\n[恶意](command:hoj-connecter.submit)');
  assert.match(html, /class="katex"/); assert.match(html, /katex-display/); assert.match(html, /<table>/);
  assert.doesNotMatch(html, /<script>|href="command:/);
});
