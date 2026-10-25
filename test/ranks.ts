import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HojClient } from '../src/api';
import { contestRankMarkdown, rankListMarkdown } from '../src/ranks';
import { renderMarkdown } from '../src/markdown';
import type { Contest } from '../src/domain';
import { fixture } from './fixture';

test('rankings request contest and site endpoints and render escaped scoreboards', async () => {
  const mock = await fixture();
  try {
    const secrets = { get: async () => undefined, store: async () => undefined };
    const site = { id: 'school', name: 'School', url: mock.url, apiPath: '/api' };
    const client = new HojClient(site, secrets);
    const contestRank = await client.contestRank(12, 2, 20, { keyword: 'ali', forceRefresh: true });
    const request = mock.requests.at(-1)!;
    assert.equal(request.path, '/get-contest-rank');
    assert.deepEqual([request.body?.cid, request.body?.currentPage, request.body?.limit, request.body?.keyword, request.body?.forceRefresh], [12, 2, 20, 'ali', true]);
    assert.equal(contestRank.total, 41);
    await client.rankList('oi', 3, 25, 'bob');
    const list = mock.requests.at(-1)!.query;
    assert.equal(mock.requests.at(-1)!.path, '/get-rank-list');
    assert.deepEqual([list.get('type'), list.get('currentPage'), list.get('limit'), list.get('searchUser')], ['1', '3', '25', 'bob']);
    await client.rankList('acm', 1, 25); assert.equal(mock.requests.at(-1)!.query.get('type'), '0');

    const contest: Contest = { id: 12, title: 'Weekly', startTime: '2026-01-01T00:00:00Z', endTime: '2026-01-01T03:00:00Z', type: 0 };
    const view = { kind: 'contest' as const, page: 2, limit: 20, me: 'alice' };
    const acm = contestRankMarkdown(contest, ['A', 'B', 'C'], contestRank, view);
    assert.match(acm, /第 2\/3 页 · 共 41 人/);
    assert.match(acm, /\| 1 \| \*\*alice \(A\\\|B\)\*\* ← \| 2 \| 01:05:00 \| ★ 00:10:00 \| ✓ 00:50:00 \(-1\) \| ✗ -2 \|/);
    assert.match(acm, /\| \* \| carol \| 0 \|/, 'unofficial participants show a star rank');
    const html = renderMarkdown(acm);
    assert.match(html, /<table>/); assert.equal((html.match(/<tr>/g) ?? []).length, 3, 'a pipe in a nickname must not split the row');
    const oi = contestRankMarkdown({ ...contest, type: 1 }, ['A', 'B'], { records: [{ rank: 1, username: 'bob', totalScore: 150, submissionInfo: { A: 100, B: 50 } }], total: 1 }, view);
    assert.match(oi, /\| 1 \| bob \| 150 \| 100 \| 50 \|/);
    const site2 = rankListMarkdown(site, { records: [{ username: 'alice', ac: 3, total: 4 }], total: 1 }, { kind: 'acm', page: 1, limit: 30, me: 'alice' });
    assert.match(site2, /\| 1 \| \*\*alice\*\* ← \| 3 \| 4 \| 75\.0% \|/);
    assert.match(rankListMarkdown(site, { records: [], total: 0 }, { kind: 'oi', page: 1, limit: 30 }), /暂无排名数据/);
  } finally { await mock.close(); }
});
