import { Account, asPage, Contest, ContestRankRow, RankRow, SubmissionFilter, Group, isPending, JudgeCase, JudgeCaseResult, Page, ProblemDetail, ProblemStatus, ProblemSummary, Scope, Site, Submission } from './domain';

export interface Secrets { get(key: string): Thenable<string | undefined> | Promise<string | undefined>; store(key: string, value: string): Thenable<void> | Promise<void> }
export interface AcceptedCode { code: string; language?: string }
export const tokenKey = (siteId: string, accountId: string) => `hoj-connecter.token.${siteId}.${accountId}`;
export const passwordKey = (siteId: string, accountId: string) => `hoj-connecter.password.${siteId}.${accountId}`;
// Shared across clients so concurrent 401s for one account trigger a single login.
const relogins = new Map<string, Promise<boolean>>();
export class ApiError extends Error {
  constructor(message: string, readonly status: number, readonly endpoint: string) { super(message); this.name = 'ApiError'; }
}
export class HojClient {
  constructor(readonly site: Site, private readonly secrets: Secrets, readonly account?: Account, private readonly timeout = 20000) {}

  async request<T>(endpoint: string, params: Record<string, unknown> = {}, body?: unknown, anonymous = false): Promise<{ data: T; token?: string }> {
    const key = !anonymous && this.account ? tokenKey(this.site.id, this.account.id) : undefined;
    const token = key ? await this.secrets.get(key) : undefined;
    try { return await this.send<T>(endpoint, params, body, key, token); }
    catch (error) {
      if (!key || !(error instanceof ApiError) || error.status !== 401) { throw error; }
      // Another request may already have renewed the token; otherwise log in again with the saved password.
      const latest = await this.secrets.get(key);
      if (latest === token && !await this.relogin(error)) { throw error; }
      return await this.send<T>(endpoint, params, body, key, await this.secrets.get(key));
    }
  }
  /** Logs in again with the saved password; false when none is saved. */
  async relogin(cause?: ApiError): Promise<boolean> {
    if (!this.account) { return false; }
    const account = this.account, key = tokenKey(this.site.id, account.id);
    let pending = relogins.get(key);
    if (!pending) {
      pending = (async () => {
        const password = await this.secrets.get(passwordKey(this.site.id, account.id)); if (!password) { return false; }
        try { await this.secrets.store(key, (await this.login(account.username, password)).token); return true; }
        catch (error) {
          const reason = error instanceof Error ? error.message : String(error);
          throw new ApiError(`登录已失效，使用保存的密码自动重新登录失败：${reason}`, cause?.status ?? 401, cause?.endpoint ?? '/login');
        }
      })().finally(() => relogins.delete(key));
      relogins.set(key, pending);
    }
    return pending;
  }
  private async send<T>(endpoint: string, params: Record<string, unknown>, body: unknown, key: string | undefined, token: string | undefined): Promise<{ data: T; token?: string }> {
    const url = new URL(`${this.site.url}${this.site.apiPath}${endpoint}`);
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== null && value !== '') { url.searchParams.set(key, String(value)); }
    }
    const headers: Record<string, string> = { Accept: 'application/json', 'Content-Type': 'application/json', 'Url-Type': 'general' };
    if (token) { headers.Authorization = token; }
    let response: Response;
    try {
      response = await fetch(url, { method: body === undefined ? 'GET' : 'POST', headers, body: body === undefined ? undefined : JSON.stringify(body), redirect: 'error', signal: AbortSignal.timeout(this.timeout) });
    } catch (error) {
      throw new ApiError(`无法连接 ${this.site.name}：${error instanceof Error ? error.message : String(error)}。请检查地址和 API 前缀。`, 0, endpoint);
    }
    const refreshed = response.headers.get('authorization') ?? undefined;
    if (refreshed && key && response.headers.has('refresh-token')) { await this.secrets.store(key, refreshed); }
    // Cap responses before parsing so an accidental website URL cannot exhaust the extension host.
    const reader = response.body?.getReader();
    const parts: Uint8Array[] = []; let size = 0;
    if (reader) {
      try {
        while (true) {
          const next = await reader.read(); if (next.done) { break; }
          size += next.value.length;
          if (size > 12 * 1024 * 1024) { await reader.cancel(); throw new ApiError('服务器响应超过 12 MB。', response.status, endpoint); }
          parts.push(next.value);
        }
      } finally { reader.releaseLock(); }
    }
    let json: { status?: number; data: T; msg?: string };
    try { json = JSON.parse(Buffer.concat(parts).toString('utf8')); }
    catch { throw new ApiError('服务器未返回 JSON，请检查站点地址及 API 前缀（通常为 /api）。', response.status, endpoint); }
    const status = Number(json.status ?? response.status);
    if (!response.ok || status !== 200) {
      const hint = status === 401 ? '登录已失效，请重新登录。' : status === 403 ? '没有访问权限，请确认团队成员资格或比赛密码。' : '';
      throw new ApiError([json.msg ?? `HTTP ${response.status}`, hint].filter(Boolean).join(' · '), status, endpoint);
    }
    return { data: json.data, token: refreshed };
  }
  async login(username: string, password: string): Promise<{ data: { username?: string; nickname?: string }; token: string }> {
    const result = await this.request<{ username?: string; nickname?: string; token?: string }>('/login', {}, { username, password }, true);
    const token = result.token ?? result.data?.token;
    if (!token) { throw new Error('登录响应中没有 Authorization Token。可改用“通过浏览器 Token 登录”。'); }
    return { data: result.data, token };
  }
  async identity(): Promise<{ username: string; nickname?: string }> {
    // Standard HOJ returns only roles here. The profile endpoint without uid or
    // username resolves the authenticated principal; forks may include the name here.
    const { data } = await this.request<{ username?: string; nickname?: string; roles?: string[] }>('/get-user-auth-info');
    if (data?.username) { return { username: data.username, nickname: data.nickname }; }
    const profile = (await this.request<{ username: string; nickname?: string }>('/get-user-home-info')).data;
    if (!profile?.username) { throw new Error('站点未返回 Token 对应的用户信息。'); } return profile;
  }
  async problems(scope: Scope, page: number, limit: number, keyword = ''): Promise<Page<ProblemSummary>> {
    if (scope.contestId) { return asPage((await this.request<ProblemSummary[]>('/get-contest-problem', { cid: scope.contestId, containsEnd: true })).data); }
    return asPage((await this.request<Page<ProblemSummary>>(scope.groupId ? '/group/get-problem-list' : '/get-problem-list', { currentPage: page, limit, gid: scope.groupId, keyword })).data);
  }
  /** Current account's status per numeric problem ID; empty for guests. */
  async problemStatus(scope: Scope, pids: readonly number[]): Promise<Record<string, ProblemStatus>> {
    if (!this.account || !pids.length) { return {}; }
    return (await this.request<Record<string, ProblemStatus> | null>('/get-user-problem-status', {}, { pidList: pids, isContestProblemList: !!scope.contestId, cid: scope.contestId, gid: scope.groupId, containsEnd: true })).data ?? {};
  }
  async problem(scope: Scope, displayId: string): Promise<ProblemDetail> {
    const endpoint = scope.contestId ? '/get-contest-problem-details' : '/get-problem-detail';
    const params = scope.contestId ? { displayId, cid: scope.contestId, containsEnd: true } : { problemId: displayId, gid: scope.groupId };
    const { data } = await this.request<ProblemDetail>(endpoint, params);
    if (!data?.problem || !Array.isArray(data.languages)) { throw new Error('题目详情格式与 HOJ 不兼容。'); } return data;
  }
  async groups(page: number, limit: number, keyword = ''): Promise<Page<Group>> {
    return asPage((await this.request<Page<Group>>('/get-group-list', { currentPage: page, limit, keyword, onlyMine: !!this.account })).data);
  }
  async group(id: number): Promise<Group> { return (await this.request<Group>('/get-group-detail', { gid: id })).data; }
  async contests(scope: Scope, page: number, limit: number, keyword = ''): Promise<Page<Contest>> {
    return asPage((await this.request<Page<Contest>>(scope.groupId ? '/group/get-contest-list' : '/get-contest-list', { currentPage: page, limit, gid: scope.groupId, keyword })).data);
  }
  async contest(id: number): Promise<Contest> { return (await this.request<Contest>('/get-contest-info', { cid: id })).data; }
  async contestAccess(id: number): Promise<boolean> { return (await this.request<{ access: boolean }>('/get-contest-access', { cid: id })).data.access; }
  async contestRank(cid: number, page: number, limit: number, options: { keyword?: string; removeStar?: boolean; forceRefresh?: boolean } = {}): Promise<Page<ContestRankRow>> {
    return asPage((await this.request<Page<ContestRankRow>>('/get-contest-rank', {}, { currentPage: page, limit, cid, forceRefresh: !!options.forceRefresh, removeStar: !!options.removeStar, concernedList: [], keyword: options.keyword || null, containsEnd: true })).data);
  }
  /** Site-wide ranking; HOJ uses type 0 for ACM and 1 for OI. */
  async rankList(kind: 'acm' | 'oi', page: number, limit: number, searchUser = ''): Promise<Page<RankRow>> {
    return asPage((await this.request<Page<RankRow>>('/get-rank-list', { currentPage: page, limit, searchUser, type: kind === 'oi' ? 1 : 0 })).data);
  }
  async registerContest(id: number, password: string): Promise<void> { await this.request('/register-contest', {}, { cid: id, password }); }
  async submit(problem: OpenProblemForSubmit, language: string, code: string): Promise<Submission> {
    return (await this.request<Submission>('/submit-problem-judge', {}, { pid: problem.displayId, language, code, cid: problem.scope.contestId ?? 0, gid: problem.scope.groupId ?? null, tid: null, isRemote: !!problem.detail.problem.isRemote })).data;
  }
  async submission(id: number): Promise<Submission> {
    const { data } = await this.request<{ submission: Submission }>('/get-submission-detail', { submitId: id });
    const submission = data.submission;
    // Fetch only after judging finishes; case-result access can be restricted
    // independently of the submission, so failure must not hide the verdict/code.
    if (!isPending(submission.status)) {
      try { submission.caseResult = await this.submissionCases(id); }
      catch (error) { submission.caseResultError = error instanceof Error ? error.message : String(error); }
    }
    return submission;
  }
  async submissionCases(id: number): Promise<JudgeCaseResult | null> {
    const { data } = await this.request<JudgeCaseResult | JudgeCase[] | null>('/get-all-case-result', { submitId: id });
    if (data == null) { return null; }
    const validList = (value: unknown): boolean => Array.isArray(value) && value.every(c => c != null && typeof c === 'object' && !Array.isArray(c));
    // Older HOJ deployments return the flat list directly.
    if (Array.isArray(data)) {
      if (validList(data)) { return { judgeCaseMode: 'default', judgeCaseList: data }; }
    } else if (typeof data === 'object'
      && (Array.isArray(data.judgeCaseList) || Array.isArray(data.subTaskJudgeCaseVoList))
      && (data.judgeCaseList == null || validList(data.judgeCaseList))
      && (data.subTaskJudgeCaseVoList == null || (validList(data.subTaskJudgeCaseVoList)
        && data.subTaskJudgeCaseVoList.every(g => g.subtaskDetailList == null || validList(g.subtaskDetailList))))) {
      return data;
    }
    throw new Error('站点返回的测试点详情格式与 HOJ 不兼容。');
  }
  async lastAcceptedCode(problem: OpenProblemForSubmit): Promise<AcceptedCode> {
    if (!this.account) { throw new Error('请先登录，再获取最后一次通过的代码。'); }
    // HOJ expects the internal numeric problem ID, including for contest aliases.
    const { data } = await this.request<AcceptedCode | null>('/get-last-ac-code', { pid: problem.detail.problem.id, cid: problem.scope.contestId });
    if (data == null) { throw new Error('当前账号在此题中没有可获取的通过代码。'); }
    if (typeof data.code !== 'string' || !data.code.trim() || (data.language !== undefined && typeof data.language !== 'string')) { throw new Error('站点未返回有效的通过代码，当前文件未修改。'); }
    return data;
  }
  async submissions(scope: Scope, displayId: string | undefined, page: number, limit: number, filter: SubmissionFilter = { onlyMine: true }): Promise<Page<Submission>> {
    return asPage((await this.request<Page<Submission>>(scope.contestId ? '/contest-submissions' : '/get-submission-list', { currentPage: page, limit, onlyMine: filter.onlyMine, problemID: displayId, completeProblemID: true, contestID: scope.contestId ?? 0, beforeContestSubmit: scope.contestId ? false : undefined, gid: scope.groupId, status: filter.status, username: filter.onlyMine ? undefined : filter.username })).data);
  }
}
interface OpenProblemForSubmit { displayId: string; scope: Scope; detail: ProblemDetail }
