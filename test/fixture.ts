import { createServer, IncomingMessage, ServerResponse } from 'node:http';
import { AddressInfo } from 'node:net';
import type { Submission } from '../src/domain';

export async function fixture() {
  const requests: { path: string; query: URLSearchParams; authorization?: string; body?: Record<string, unknown> }[] = [];
  let statusReads = 0;
  let submissionOverride: Partial<Submission> = {};
  let acceptedCode: unknown = { code: 'console.log(3);\n', language: 'JavaScript' }, acceptedStatus = 200;
  let caseResult: unknown = { judgeCaseMode: 'default', judgeCaseList: [
    { status: 0, score: 25, time: 0, memory: 1024, seq: 0 },
    { status: 0, score: 25, time: 10, memory: 2048, seq: 1 },
    { status: -1, score: 0, time: 12, memory: 2048, seq: 2, userOutput: 'wrong answer: expected 42, found 41' },
    { status: 0, score: 25, time: 11, memory: 2048, seq: 3 }
  ] };
  let caseStatus = 200;
  const detail = { problem: { id: 10, problemId: 'P1000', title: 'A + B', description: '计算两个整数之和。', input: '两个整数', output: '和', timeLimit: 1000, memoryLimit: 256, examples: '<input>1 2\n</input><output>3\n</output><input>100 -20\n</input><output>80\n</output>', isRemote: false }, languages: ['JavaScript', 'C++', 'Python3'], codeTemplate: {} };
  const server = createServer((req, res) => { void handle(req, res); });
  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url!, 'http://localhost');
    const chunks: Buffer[] = []; for await (const chunk of req) { chunks.push(Buffer.from(chunk)); }
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown> : undefined;
    const pathname = url.pathname.replace(/^\/api/, '');
    requests.push({ path: pathname, query: url.searchParams, authorization: req.headers.authorization, body });
    const json = (data: unknown, status = 200, headers = {}) => { res.writeHead(status, { 'Content-Type': 'application/json', ...headers }); res.end(JSON.stringify({ status, data, msg: status === 200 ? 'success' : '需要登录' })); };
    if (pathname === '/login' && body?.password === 'wrong') { json(null, 400); return; }
    if (pathname === '/login') { json({ username: body?.username, nickname: 'Tester' }, 200, { Authorization: `token-${body?.username}` }); return; }
    if (pathname === '/get-user-auth-info') { if (!req.headers.authorization) { json(null, 401); } else { json({ roles: ['user'] }); } return; }
    if (pathname === '/get-user-home-info') { json({ username: url.searchParams.get('username') ?? 'alice', nickname: 'Tester' }); return; }
    if (pathname === '/refresh') { json({}, 200, { Authorization: 'renewed-token', 'refresh-token': 'true' }); return; }
    if (pathname === '/denied') { json(null, 401); return; }
    // Only tokens issued by /login are accepted, so stale tokens expire.
    if (pathname === '/session') { if (req.headers.authorization?.startsWith('token-')) { json({ ok: true }); } else { json(null, 401); } return; }
    if (pathname === '/html') { res.writeHead(200); res.end('<html>not an API</html>'); return; }
    if (pathname === '/redirect') { res.writeHead(302, { Location: 'http://127.0.0.1:1/stolen' }); res.end(); return; }
    if (pathname === '/get-problem-detail' || pathname === '/get-contest-problem-details') { json(detail); return; }
    if (pathname === '/get-contest-problem') { json([{ pid: 10, displayId: 'A', displayTitle: 'A + B' }]); return; }
    if (pathname === '/get-problem-list' || pathname === '/group/get-problem-list') { json({ records: [{ pid: 10, problemId: 'P1000', title: 'A + B' }], total: 100 }); return; }
    if (pathname === '/get-group-list') { json({ records: [{ id: 7, name: '训练营' }, { id: 8, name: '提高组' }], total: 2 }); return; }
    if (pathname === '/get-group-detail') { const id = Number(url.searchParams.get('gid')); json({ id, name: id === 8 ? '提高组' : '训练营' }); return; }
    if (pathname === '/get-contest-list' || pathname === '/group/get-contest-list') {
      const gid = Number(url.searchParams.get('gid')); json({ records: [{ id: gid === 8 ? 13 : gid === 7 ? 12 : 14, title: gid === 8 ? '提高赛' : gid === 7 ? '周赛' : '公开赛' }], total: 1 }); return;
    }
    if (pathname === '/get-contest-info') {
      const id = Number(url.searchParams.get('cid')); json({ id, title: id === 13 ? '提高赛' : id === 14 ? '公开赛' : '周赛', type: 1, gid: id === 14 ? undefined : id === 13 ? 8 : 7, auth: 0, now: new Date().toISOString(), startTime: new Date(Date.now() - 60000).toISOString(), endTime: new Date(Date.now() + 3600000).toISOString() }); return;
    }
    if (pathname === '/get-contest-access') { json({ access: true }); return; }
    if (pathname === '/register-contest') { json(null); return; }
    if (pathname === '/submit-problem-judge') { statusReads = 0; json({ submitId: 42, status: 5 }); return; }
    if (pathname === '/get-submission-detail') { json({ submission: { submitId: 42, status: ++statusReads === 1 ? 7 : 8, score: 75, time: 12, memory: 2048, language: 'JavaScript', code: 'console.log(1)', errorMessage: 'The error message does not support viewing.', ...submissionOverride } }); return; }
    if (pathname === '/get-last-ac-code') { json(acceptedCode, acceptedStatus); return; }
    if (pathname === '/get-all-case-result') { json(caseResult, caseStatus); return; }
    if (pathname === '/get-contest-rank') {
      json({ records: [
        { rank: 1, username: 'alice', nickname: 'A|B', ac: 2, totalTime: 3900, submissionInfo: { A: { isAC: true, ACTime: 600, errorNum: 0, isFirstAC: true }, B: { isAC: true, ACTime: 3000, errorNum: 1 }, C: { isAC: false, errorNum: 2 } } },
        { rank: -1, username: 'carol', ac: 0, totalTime: 0, submissionInfo: {} }
      ], total: 41 }); return;
    }
    if (pathname === '/get-rank-list') { json({ records: [], total: 0 }); return; }
    if (pathname === '/get-submission-list' || pathname === '/contest-submissions') { json({ records: [{ submitId: 42, status: 8, score: 75 }], total: 1 }); return; }
    json(null, 404);
  };
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, requests, detail, setSubmission: (override: Partial<Submission>) => { submissionOverride = override; },
    setAcceptedCode: (value: unknown, status = 200) => { acceptedCode = value; acceptedStatus = status; },
    setCaseResult: (value: unknown, status = 200) => { caseResult = value; caseStatus = status; },
    close: () => new Promise<void>((resolve, reject) => { server.close(error => error ? reject(error) : resolve()); server.closeAllConnections(); }) };
}
