import { createHash } from 'node:crypto';

export interface Site { id: string; name: string; url: string; apiPath: string }
export interface Account { id: string; siteId: string; username: string; nickname?: string }
export interface Scope { siteId: string; accountId?: string; groupId?: number; contestId?: number }
export interface Page<T> { records: T[]; total: number }
export interface Group { id: number; name: string; description?: string; auth?: number }
export interface Contest {
  id: number; title: string; startTime: string; endTime: string; now?: string;
  description?: string; auth?: number; gid?: number; type?: number; status?: number;
}
export interface ProblemSummary { id?: number; pid?: number; problemId?: string; displayId?: string; title?: string; displayTitle?: string; difficulty?: number; score?: number }
/** `/get-user-problem-status` entry: the latest verdict (AC wins outside contests); `score` only in contests. */
export interface ProblemStatus { status: number; score?: number | null }
export interface Sample { input: string; output: string }
export interface Problem {
  id: number; problemId: string; title: string; description?: string; input?: string; output?: string;
  hint?: string; source?: string; timeLimit?: number; memoryLimit?: number; examples?: unknown;
  isRemote?: boolean; type?: number; isFileIO?: boolean; ioReadFileName?: string; ioWriteFileName?: string;
}
export interface ProblemDetail { problem: Problem; languages: string[]; codeTemplate?: Record<string, string>; tags?: {name: string}[] }
export interface OpenProblem { scope: Scope; displayId: string; detail: ProblemDetail; samples: Sample[] }
export interface Submission {
  submitId: number; status: number; score?: number | null; oiRankScore?: number | null; time?: number; memory?: number;
  language?: string; displayPid?: string; displayId?: string; title?: string; errorMessage?: string; code?: string; submitTime?: string; username?: string;
  caseResult?: JudgeCaseResult | null; caseResultError?: string;
}
export interface JudgeCase {
  status?: number | null; time?: number | null; memory?: number | null; score?: number | null;
  seq?: number | null; groupNum?: number | null; caseId?: number | null;
  userOutput?: string | null; inputData?: string | null; outputData?: string | null;
  errorMessage?: string | null; stderr?: string | null;
}
export interface SubTaskJudgeCase extends JudgeCase { ac?: number | null; total?: number | null; subtaskDetailList?: JudgeCase[] | null }
export interface JudgeCaseResult {
  judgeCaseMode?: string | null; judgeCaseList?: JudgeCase[] | null; subTaskJudgeCaseVoList?: SubTaskJudgeCase[] | null;
}
/** One problem cell of an ACM contest scoreboard; `ACTime` is seconds since the contest started. */
export interface AcmCell { isAC?: boolean; ACTime?: number | null; errorNum?: number | null; tryNum?: number | null; isFirstAC?: boolean }
/** `/get-contest-rank` row: ACM rows carry ac/totalTime and AcmCell info, OI rows totalScore and per-problem scores. */
export interface ContestRankRow {
  rank?: number | null; uid?: string; username?: string; nickname?: string | null; realname?: string | null; school?: string | null;
  ac?: number | null; total?: number | null; totalTime?: number | null; totalScore?: number | null;
  submissionInfo?: Record<string, AcmCell | number | null> | null;
}
/** `/get-rank-list` row for the site-wide ACM (solved count) or OI (score) rankings. */
export interface RankRow { uid?: string; username?: string; nickname?: string | null; signature?: string | null; ac?: number | null; total?: number | null; totalScore?: number | null; solved?: number | null }
export type RankKind = 'contest' | 'acm' | 'oi';
/** Status-page filters; `onlyMine: false` lists everyone's submissions. */
export interface SubmissionFilter { onlyMine: boolean; status?: number; username?: string }
export interface Binding { files: string[]; active?: string; language?: string; languageMode?: 'auto' | 'manual'; sampleDir?: string; sampleCount?: number }
/** `msvc` is a vcvarsall.bat whose environment compile and run need. */
export interface RunnerProfile { compile?: string[]; run: string[]; msvc?: string }
export function sameScope(a: Scope, b: Scope): boolean { return a.siteId === b.siteId && a.accountId === b.accountId && a.groupId === b.groupId && a.contestId === b.contestId; }

export function normalizeSiteUrl(value: string): string {
  const url = new URL(value.trim());
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error('请输入不含密码、查询参数和锚点的 HTTP(S) 站点地址。');
  }
  return url.toString().replace(/\/+$/, '');
}
export function validateApiPath(value: string): string {
  const path = value.trim().replace(/\/+$/, '');
  if (!/^\/(?:[A-Za-z0-9_-]+\/?)*$/.test(path) || path.startsWith('//')) { throw new Error('API 前缀应为 /api 这样的相对路径。'); }
  return path;
}
export function problemId(item: ProblemSummary): string { return String(item.displayId ?? item.problemId ?? item.pid ?? item.id ?? ''); }
export function problemTitle(item: ProblemSummary): string { return item.displayTitle ?? item.title ?? '未命名题目'; }
export function problemKey(scope: Scope, displayId: string): string {
  return createHash('sha256').update(JSON.stringify([scope.siteId, scope.accountId ?? '', scope.groupId ?? 0, scope.contestId ?? 0, displayId])).digest('hex').slice(0, 24);
}
export function parseSamples(value: unknown): Sample[] {
  if (Array.isArray(value)) { return value.filter((s): s is Sample => !!s && typeof s.input === 'string' && typeof s.output === 'string'); }
  if (typeof value !== 'string' || !value.trim()) { return []; }
  try { const parsed: unknown = JSON.parse(value); if (Array.isArray(parsed)) { return parseSamples(parsed); } } catch { /* HOJ uses input/output tags. */ }
  return [...value.matchAll(/<input>([\s\S]*?)<\/input>\s*<output>([\s\S]*?)<\/output>/g)].map(m => ({ input: m[1], output: m[2] }));
}
export function asPage<T>(value: Page<T> | T[]): Page<T> {
  if (Array.isArray(value)) { return { records: value, total: value.length }; }
  if (!value || !Array.isArray(value.records)) { throw new Error('站点返回的列表格式与 HOJ 不兼容。'); }
  return { records: value.records, total: Number(value.total ?? value.records.length) };
}
const verdicts: Record<number, string> = { '-10': '未提交', '-5': '结果未知', '-4': '已取消', '-3': 'PE · 格式错误', '-2': 'CE · 编译错误', '-1': 'WA · 答案错误', 0: 'AC · 通过', 1: 'TLE · 超时', 2: 'MLE · 内存超限', 3: 'RE · 运行错误', 4: 'SE · 系统错误', 5: '排队中', 6: '编译中', 7: '评测中', 8: 'PAC · 部分通过', 9: '远程提交中', 10: '提交失败' };
export function verdict(status: number): string { return verdicts[status] ?? `未知状态 (${status})`; }
/** Short verdict code, e.g. "WA" or "排队中". */
export function verdictCode(status: number): string { return verdict(status).split(' · ')[0]; }
export function isPending(status: number): boolean { return [5, 6, 7, 9].includes(status); }
export function scoreText(s: Submission): string { const score = s.score ?? s.oiRankScore; return score == null ? '' : `${score} 分`; }
export function compareOutput(actual: string, expected: string, mode: string): boolean {
  const normalize = (s: string) => s.replace(/\r\n/g, '\n');
  if (mode === 'tokens') { return normalize(actual).trim().split(/\s+/).join(' ') === normalize(expected).trim().split(/\s+/).join(' '); }
  if (mode === 'exact') { return normalize(actual) === normalize(expected); }
  const trim = (s: string) => normalize(s).split('\n').map(l => l.trimEnd()).join('\n').trimEnd();
  return trim(actual) === trim(expected);
}
export function safeSegment(value: string): string {
  const result = value.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/^[. ]+|[. ]+$/g, '').slice(0, 70);
  return !result || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(result) ? `_${result || 'problem'}` : result;
}
export function durationText(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(seconds / 3600).toString().padStart(2, '0')}:${Math.floor(seconds / 60 % 60).toString().padStart(2, '0')}:${(seconds % 60).toString().padStart(2, '0')}`;
}
export function contestClock(contest: Contest, now = Date.now()): string {
  const start = Date.parse(contest.startTime), end = Date.parse(contest.endTime);
  if (!Number.isFinite(start) || !Number.isFinite(end)) { return '比赛时间未知'; }
  if (now < start) { return `距开始 ${durationText(start - now)}`; }
  if (now < end) { return `剩余 ${durationText(end - now)}`; }
  return '已结束';
}
