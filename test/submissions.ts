import * as vscode from 'vscode';
import assert from 'node:assert/strict';
import { App } from '../src/extension';
import { submissionMarkdown } from '../src/documents';
import { renderMarkdown } from '../src/markdown';
import { fixture } from './fixture';

export async function verifySubmissionDetails(app: App, mock: Awaited<ReturnType<typeof fixture>>, check: (name: string) => void): Promise<void> {
  const open = () => vscode.commands.executeCommand('hoj-connecter.openSubmission', { id: 42, scope: { ...app.store.scope }, displayId: 'P1000' });
  const flat = app.docs.active!.attachment!.submission!.caseResult!;
  await open();
  let content = app.docs.active!.content;
  assert.match(content, /共 \*\*4\*\* 个测试点/);
  assert.match(content, /\| #1 \| AC · 通过 \| 25 \| 0 \| 1024 \|/);
  assert.match(content, /wrong answer: expected 42, found 41/);
  assert.doesNotMatch(content, /The error message does not support viewing/);
  assert.ok(app.docs.active!.attachment!.submission!.caseResult);
  check('polled and historical results include every case, score, time, memory and judge diagnostic without the HOJ placeholder');

  const diagnostic = 'SIGSEGV\n```\n<script>alert(1)</script>\n[link](command:hoj-connecter.submit)';
  mock.setCaseResult({ judgeCaseMode: 'subtask_lowest', subTaskJudgeCaseVoList: [
    { groupNum: 2, status: 3, score: 0, ac: 0, total: 2, subtaskDetailList: [
      { status: 3, time: 0, memory: 0, score: 0, userOutput: diagnostic, inputData: '2.in', outputData: '2.out' },
      { status: -4, time: null, memory: null, score: null }
    ] },
    { groupNum: 3, status: -1, score: 0, ac: 0, total: 1, subtaskDetailList: [{ status: -1 }] }
  ] });
  await open(); content = app.docs.active!.content;
  assert.match(content, /### 子任务 #2/); assert.match(content, /### 子任务 #3/);
  assert.match(content, /共 \*\*3\*\* 个测试点/);
  assert.match(content, /\| #1 \| RE · 运行错误 \| 0 \| 0 \| 0 \|/);
  assert.match(content, /\| #2 \| 跳过 \| — \| — \| — \|/);
  assert.ok(content.includes(diagnostic)); assert.match(content, /2\.in/); assert.match(content, /2\.out/);
  assert.match(content, /未返回具体错误提示/);
  const html = renderMarkdown(content);
  assert.match(html, /<table>/); assert.match(html, /&lt;script&gt;/);
  assert.doesNotMatch(html, /<script>|href="command:/);
  const attachment = app.docs.active!.attachment!.submission!;
  const aiResult = submissionMarkdown({ ...attachment, code: undefined });
  assert.ok(aiResult.includes(diagnostic)); assert.match(aiResult, /子任务 #2/); assert.doesNotMatch(aiResult, /## 提交代码/);
  check('subtasks retain their cases and skipped results; multiline diagnostics stay inert in sidebar and AI context');

  for (const [data, status, expected] of [
    [null, 200, /服务器未开放/],
    [{ judgeCaseMode: 'default', judgeCaseList: [] }, 200, /服务器未返回测试点结果/],
    [null, 403, /测试点详情获取失败/],
    [null, 500, /测试点详情获取失败/]
  ] as const) {
    mock.setCaseResult(data, status); await open(); content = app.docs.active!.content;
    assert.match(content, expected); assert.match(content, /75 分/); assert.match(content, /console\.log\(1\)/);
    assert.doesNotMatch(content, /The error message does not support viewing/);
  }
  mock.setSubmission({ status: -2, errorMessage: 'error: missing semicolon' });
  mock.setCaseResult({ judgeCaseMode: 'default', judgeCaseList: [] });
  await open(); content = app.docs.active!.content;
  assert.match(content, /error: missing semicolon/); assert.match(content, /编译失败，未运行测试点/);
  mock.setSubmission({}); mock.setCaseResult(flat);
  check('unavailable, empty and denied case details explain the reason while retaining verdict/code and compiler errors');
}
