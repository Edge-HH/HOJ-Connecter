import * as vscode from 'vscode';
import { randomUUID } from 'node:crypto';
import * as path from 'node:path';
import { Account, Contest, contestClock, Group, isPending, normalizeSiteUrl, OpenProblem, parseSamples, problemId, problemKey, RankKind, sameScope, Scope, scoreText, Site, SubmissionFilter, validateApiPath, verdict } from './domain';
import { ApiError, HojClient, passwordKey, tokenKey } from './api';
import { contestRankMarkdown, rankListMarkdown } from './ranks';
import { DetailAttachment, Documents, contestMarkdown, fence, problemMarkdown, submissionMarkdown } from './documents';
import { AssistantId, attachToAssistant, installedAssistants } from './assistants';
import { Explorer, Navigation, Node, ViewModel, ViewName } from './explorer';
import { Cancelled, Files, requireTrust } from './files';
import { Samples } from './samples';
import { Store } from './store';

function value<T>(arg: unknown): T | undefined { return (arg instanceof Node ? arg.value : arg) as T | undefined; }
/** A list row (inline buttons) or a pager node inside the list. */
function pager(arg: unknown): { view?: ViewName; list?: string; section?: ViewName } | undefined { return arg instanceof Node && (arg.list || arg.section) ? arg : value(arg); }
export class App implements vscode.Disposable, ViewModel {
  readonly store: Store;
  readonly files: Files;
  readonly samples: Samples;
  readonly docs: Documents;
  readonly views: Record<ViewName, Explorer>;
  readonly navigation: Navigation;
  readonly output = vscode.window.createOutputChannel('HOJ-Connecter');
  readonly status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 40);
  current?: OpenProblem; group?: Group; contest?: Contest;
  keyword = ''; revision = 0; serverOffset = 0;
  private readonly subscriptions: vscode.Disposable[] = [];
  private readonly polling = new Set<AbortController>();
  private readonly submitting = new Set<string>();
  private attaching = false;
  private readonly timer: ReturnType<typeof setInterval>;
  private rank?: { kind: RankKind; page: number; limit: number; keyword?: string; contestId?: number; total?: number };
  private ticks = 0;
  constructor(private readonly context: vscode.ExtensionContext) {
    this.store = new Store(context); this.files = new Files(this.store, () => this.refreshLocal(), () => this.current);
    this.samples = new Samples(context, this.store, this.files, () => this.refreshLocal());
    this.views = Object.fromEntries((['session', 'problems', 'groups', 'contests', 'current', 'submissions'] as ViewName[]).map(name => [name, new Explorer(name, this)])) as Record<ViewName, Explorer>;
    this.navigation = new Navigation(this, this.views);
    this.docs = new Documents(context, async command => vscode.commands.executeCommand(command), error => this.report(error), () => ({ hasFile: !!this.current && !!this.store.binding(this.current).active, loggedIn: !!this.store.account, assistants: installedAssistants() }));
    this.subscriptions.push(vscode.workspace.registerTextDocumentContentProvider('hoj-connecter', this.docs), vscode.window.registerWebviewViewProvider('hoj-connecter.details', this.docs, { webviewOptions: { retainContextWhenHidden: true } }));
    this.registerCommands(); this.status.command = 'hoj-connecter.showNavigation'; this.updateStatus(); this.status.show();
    this.timer = setInterval(() => { this.updateStatus(); if (this.contest) { this.navigation.tick(); } if (++this.ticks % 30 === 0) { this.autoRefreshRank(); } }, 1000);
    this.subscriptions.push(vscode.workspace.onDidChangeConfiguration(e => { if (e.affectsConfiguration('hoj-connecter')) { this.refresh(); } }));
    this.subscriptions.push(vscode.window.onDidChangeActiveTextEditor(() => this.refreshLocal()));
    this.subscriptions.push(vscode.workspace.onDidSaveTextDocument(() => this.refreshLocal()));
    this.subscriptions.push(vscode.extensions.onDidChange(() => this.docs.refresh(true)));
    void vscode.commands.executeCommand('setContext', 'hoj-connecter.hasProblem', false);
    void vscode.commands.executeCommand('setContext', 'hoj-connecter.hasProblemFile', false);
    void vscode.commands.executeCommand('setContext', 'hoj-connecter.isProblemFile', false);
    this.docs.clear();
  }
  report(error: unknown, notify = true): void {
    if (error instanceof Cancelled) { return; }
    const message = error instanceof Error ? error.message : String(error);
    this.output.appendLine(`[${new Date().toLocaleTimeString()}] ${message}`);
    if (!notify) { return; }
    if (error instanceof ApiError && error.status === 401 && this.store.account) {
      void vscode.window.showErrorMessage(`HOJ-Connecter：${message}`, '重新登录').then(choice => { if (choice) { void vscode.commands.executeCommand('hoj-connecter.relogin'); } });
    } else { void vscode.window.showErrorMessage(`HOJ-Connecter：${message}`); }
  }
  refresh(reset = false): void { for (const view of Object.values(this.views)) { view.refresh(reset); } this.navigation.refreshLists(reset); this.updateStatus(); }
  refreshLocal(): void {
    this.views.current.refresh(); this.updateStatus(); this.docs?.refresh();
    void vscode.commands.executeCommand('setContext', 'hoj-connecter.hasProblemFile', !!this.current && !!this.store.binding(this.current).active);
    void vscode.commands.executeCommand('setContext', 'hoj-connecter.isProblemFile', !!this.current && this.store.binding(this.current).active === vscode.window.activeTextEditor?.document.uri.toString());
  }
  private updateStatus(): void {
    const site = this.store.sites.find(s => s.id === this.store.scope.siteId);
    this.status.text = this.contest ? `$(calendar) ${this.contest.title} · ${contestClock(this.contest, Date.now() + this.serverOffset)}` : `$(globe) ${site?.name ?? 'HOJ-Connecter'}${this.current ? ` · ${this.current.displayId}` : ''}`;
    this.status.tooltip = `${site?.url ?? '添加站点'}\n账号：${this.store.account?.username ?? '游客'}${this.group ? `\n团队：${this.group.name}` : ''}${this.current ? `\n题目：${this.current.displayId}` : ''}`;
    void vscode.commands.executeCommand('setContext', 'hoj-connecter.inContest', !!this.contest);
    void vscode.commands.executeCommand('setContext', 'hoj-connecter.inGroup', !!this.group);
    void vscode.commands.executeCommand('setContext', 'hoj-connecter.loggedIn', !!this.store.account);
  }
  private async reset(): Promise<void> {
    this.revision++; this.current = undefined; this.group = undefined; this.contest = undefined; this.keyword = ''; this.serverOffset = 0;
    this.docs.clear();
    this.store.scope = { siteId: this.store.scope.siteId, accountId: this.store.scope.accountId }; await this.store.save();
    await vscode.commands.executeCommand('setContext', 'hoj-connecter.hasProblem', false);
    await vscode.commands.executeCommand('setContext', 'hoj-connecter.hasProblemFile', false);
    await vscode.commands.executeCommand('setContext', 'hoj-connecter.isProblemFile', false);
    for (const view of Object.values(this.views)) { view.refresh(true); } this.navigation.refreshLists(); this.updateStatus();
  }
  private problem(): OpenProblem {
    if (!this.current) { throw new Error('请先在 HOJ-Connecter 题库中打开一道题。'); }
    if (!sameScope(this.current.scope, this.store.scope)) { throw new Error('站点、账号或比赛已切换，请重新打开题目。'); }
    return this.current;
  }
  private registerCommands(): void {
    const commands: Record<string, (...args: unknown[]) => unknown> = {
      addSite: () => this.addSite(), editSite: arg => this.editSite(value<Site>(arg)), removeSite: arg => this.removeSite(value<Site>(arg)), switchSite: arg => this.switchSite(value<Site>(arg)),
      login: arg => this.login(value<Site>(arg)), relogin: arg => this.relogin(value<{ site: Site; account?: Account }>(arg)?.account), importToken: () => this.importToken(), switchAccount: arg => this.switchAccount(value<{ site: Site; account?: Account }>(arg)), removeAccount: arg => this.removeAccount(value<{ account: Account }>(arg)?.account),
      refresh: () => this.refresh(), searchProblems: arg => this.search(arg instanceof Node ? arg : undefined), openProblemById: () => this.openById(), openProblem: arg => { const p = value<{ displayId: string; scope: Scope }>(arg); return p && this.openProblem(p.displayId, p.scope); },
      showNavigation: () => this.navigation.reveal('problems'), showProblem: () => this.showProblem(), restoreSidebar: () => this.docs.restore(), openDetailAsFile: () => this.docs.openAsFile(), openProblemAsFile: () => this.docs.openAsFile('problem'), openResultAsFile: () => this.docs.openAsFile('result'), showTests: () => vscode.commands.executeCommand('workbench.view.testing.focus'),
      attachToCodex: () => this.attach('codex'), attachToClaude: () => this.attach('claude'), attachToCopilot: () => this.attach('copilot'),
      enterGroup: arg => arg ? this.enterGroup(value<{ id: number; scope: Scope }>(arg)) : this.pickGroups(), addGroup: () => this.enterGroup(), enterContest: arg => this.enterContest(value<{ id: number; scope: Scope }>(arg)), registerContest: () => this.registerContest(),
      leaveContext: () => this.leaveContext(), leaveContest: () => this.leaveContest(), contestInfo: () => this.showContest(),
      newSolution: () => this.files.create(this.problem()), bindActiveFile: () => this.files.bindActive(this.problem()), switchSolution: () => this.files.switch(this.problem()), openSolution: () => this.files.open(this.problem()), selectLanguage: () => this.files.language(this.problem(), true),
      fetchLastAcceptedCode: () => this.files.fetchLastAcceptedCode(this.problem()), resetToTemplate: () => this.files.resetToTemplate(this.problem()),
      submit: () => this.submit(), openSubmission: arg => this.openSubmission(value<{ id: number; scope: Scope; displayId?: string }>(arg)), importSamples: () => this.samples.import(this.problem()), testSamples: () => this.testSamples(), openInBrowser: () => this.openBrowser(),
      configureRunner: () => this.samples.runners.configure(this.current && this.store.binding(this.current).active ? vscode.Uri.parse(this.store.binding(this.current).active!) : undefined),
      page: arg => { const data = value<{ view: ViewName; list?: string; page: number }>(arg); this.navigation.explorerFor(data)?.go(data!.page); },
      morePage: arg => this.navigation.explorerFor(pager(arg))?.more(),
      previousPage: arg => { const view = this.navigation.explorerFor(pager(arg)); view?.go(view.start - 1); },
      nextPage: arg => { const view = this.navigation.explorerFor(pager(arg)); view?.go(view.page + 1); },
      jumpPage: arg => this.jumpPage(this.navigation.explorerFor(pager(arg))),
      showRank: arg => this.showRank(value<RankKind>(arg)), rankPrevious: () => this.rankPage(-1), rankNext: () => this.rankPage(1), rankSearch: () => this.rankSearch(), rankMe: () => this.rankSearch(true), rankRefresh: () => this.loadRank(false, true),
      filterSubmissions: () => this.filterSubmissions(), problemSubmissions: () => this.setSubmissionFilter({ onlyMine: false })
    };
    for (const [name, handler] of Object.entries(commands)) {
      this.subscriptions.push(vscode.commands.registerCommand(`hoj-connecter.${name}`, async (...args: unknown[]) => { try { return await handler(...args); } catch (error) { this.report(error); } }));
    }
  }
  private async pickSite(): Promise<Site | undefined> {
    const pick = await vscode.window.showQuickPick(this.store.sites.map(site => ({ label: site.name, description: site.url, site })), { title: '切换 OJ 站点' }); return pick?.site;
  }
  private async siteForm(existing?: Site): Promise<Site | undefined> {
    const name = await vscode.window.showInputBox({ title: '站点名称', value: existing?.name, prompt: '例如：学校 OJ', validateInput: s => s.trim() ? undefined : '名称不能为空' }); if (name === undefined) { return; }
    const url = await vscode.window.showInputBox({ title: 'OJ 网址', value: existing?.url, prompt: '例如：https://oj.example.com', validateInput: s => { try { normalizeSiteUrl(s); return undefined; } catch (e) { return (e as Error).message; } } }); if (url === undefined) { return; }
    const apiPath = await vscode.window.showInputBox({ title: 'API 前缀', value: existing?.apiPath ?? '/api', prompt: '标准 HOJ 为 /api；网址中的子路径会保留。', validateInput: s => { try { validateApiPath(s); return undefined; } catch (e) { return (e as Error).message; } } }); if (apiPath === undefined) { return; }
    return { id: existing?.id ?? randomUUID(), name: name.trim(), url: normalizeSiteUrl(url), apiPath: validateApiPath(apiPath) };
  }
  private async addSite(): Promise<void> {
    const site = await this.siteForm(); if (!site) { return; } this.store.sites.push(site); await this.store.selectSite(site); await this.reset();
  }
  private async editSite(site?: Site): Promise<void> {
    site ??= await this.pickSite(); if (!site) { return; }
    const edited = await this.siteForm(site); if (!edited) { return; }
    if (site.url !== edited.url || site.apiPath !== edited.apiPath) {
      const accounts = this.store.accounts.filter(a => a.siteId === site!.id);
      if (accounts.length && await vscode.window.showWarningMessage('更改站点地址会移除其已保存的登录状态，避免将 Token 发送到其他站点。', { modal: true }, '更改地址') !== '更改地址') { return; }
      for (const account of accounts) { await this.store.removeAccount(account); }
    }
    this.store.sites = this.store.sites.map(s => s.id === site!.id ? edited : s); await this.store.save(); await this.reset();
  }
  private async removeSite(site?: Site): Promise<void> {
    site ??= await this.pickSite(); if (!site) { return; }
    if (await vscode.window.showWarningMessage(`移除站点“${site.name}”及保存的账号？本地代码和样例会保留。`, { modal: true }, '移除站点') !== '移除站点') { return; }
    for (const account of this.store.accounts.filter(a => a.siteId === site!.id)) { await this.store.removeAccount(account); }
    this.store.sites = this.store.sites.filter(s => s.id !== site!.id);
    if (this.store.scope.siteId === site.id) { this.store.scope = { siteId: this.store.sites[0]?.id ?? '' }; }
    await this.store.save(); await this.reset();
  }
  private async switchSite(site?: Site): Promise<void> {
    site ??= await this.pickSite(); if (site && site.id !== this.store.scope.siteId) { await this.store.selectSite(site); await this.reset(); }
  }
  private async login(site?: Site, username?: string): Promise<void> {
    if (site && site.id !== this.store.scope.siteId) { await this.switchSite(site); }
    const selected = this.store.site, rev = this.revision, client = this.store.client();
    const method = await vscode.window.showQuickPick(['用户名和密码', '浏览器 Token（验证码 / 单点登录）'], { title: `${selected.name} · ${username ? `重新登录 ${username}` : '登录方式'}` });
    if (!method) { return; } if (method.startsWith('浏览器')) { await this.importToken(); return; }
    username ??= await vscode.window.showInputBox({ title: 'HOJ 用户名', ignoreFocusOut: true, validateInput: s => s.trim() ? undefined : '请输入用户名' }); if (username === undefined) { return; }
    const password = await vscode.window.showInputBox({ title: `HOJ 密码 · ${username.trim()}`, prompt: '密码保存在 VS Code SecretStorage 中，登录失效时自动重新登录。', password: true, ignoreFocusOut: true }); if (password === undefined) { return; }
    if (rev !== this.revision) { throw new Error('站点或上下文已切换，请重新登录。'); }
    const result = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `登录 ${selected.name}` }, () => client.login(username!.trim(), password));
    if (rev !== this.revision) { throw new Error('站点已切换，请在目标站点重新登录。'); }
    await this.afterLogin(() => this.store.upsertAccount(result.data?.username ?? username!.trim(), result.token, result.data?.nickname, password));
    vscode.window.showInformationMessage(`已登录 ${this.store.account!.username}`);
  }
  /** Renews the account's session in place, using the saved password when there is one. */
  private async relogin(account = this.store.account): Promise<void> {
    if (!account) { await this.login(); return; }
    const site = this.store.sites.find(s => s.id === account.siteId); if (!site) { throw new Error('该账号所属站点已被移除。'); }
    if (account.id !== this.store.scope.accountId) { await this.switchAccount({ site, account }); }
    if (await this.context.secrets.get(passwordKey(site.id, account.id))) {
      try {
        await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `重新登录 ${account.username}` }, () => this.store.client().relogin());
        this.refresh(); vscode.window.showInformationMessage(`已重新登录 ${account.username}`); return;
      } catch (error) { this.report(error, false); vscode.window.showWarningMessage('使用保存的密码重新登录失败，请重新输入。'); }
    }
    await this.login(site, account.username);
  }
  /** Same account → keep the open problem and context; a different account → full reset. */
  private async afterLogin(save: () => Promise<Account>): Promise<void> {
    const before = { ...this.store.scope }, account = await save();
    if (account.id === before.accountId) { this.store.scope = before; await this.store.save(); this.refresh(); } else { await this.reset(); }
  }
  private async importToken(): Promise<void> {
    const site = this.store.site, rev = this.revision;
    const token = await vscode.window.showInputBox({ title: `${site.name} · 导入登录 Token`, prompt: '在浏览器登录后，从开发者工具 → Application → Local Storage 复制 token 值（无需额外添加 Bearer）。', password: true, ignoreFocusOut: true, validateInput: s => s.trim() && !/[\r\n]/.test(s) ? undefined : '请输入单行 Token' });
    if (!token) { return; }
    const temporary: Account = { id: randomUUID(), siteId: site.id, username: '' };
    await this.context.secrets.store(tokenKey(site.id, temporary.id), token.trim());
    try {
      const identity = await new HojClient(site, this.context.secrets, temporary).identity();
      if (rev !== this.revision) { throw new Error('站点已切换，请重新导入。'); }
      // Validation may renew the token; keep the most recent value.
      const latest = await this.context.secrets.get(tokenKey(site.id, temporary.id));
      await this.afterLogin(() => this.store.upsertAccount(identity.username, latest ?? token.trim(), identity.nickname));
      vscode.window.showInformationMessage(`已登录 ${identity.username}`);
    } finally { await this.context.secrets.delete(tokenKey(site.id, temporary.id)); }
  }
  private async switchAccount(target?: { site: Site; account?: Account }): Promise<void> {
    if (target) { if (target.site.id !== this.store.scope.siteId) { await this.store.selectSite(target.site); } await this.store.selectAccount(target.account); await this.reset(); return; }
    const picked = await vscode.window.showQuickPick([{ label: '游客', account: undefined as Account | undefined }, ...this.store.accounts.filter(a => a.siteId === this.store.scope.siteId).map(account => ({ label: account.username, account }))], { title: `${this.store.site.name} · 切换账号` });
    if (picked) { await this.store.selectAccount(picked.account); await this.reset(); }
  }
  private async removeAccount(account?: Account): Promise<void> {
    if (!account) {
      const pick = await vscode.window.showQuickPick(this.store.accounts.map(a => ({ label: a.username, description: this.store.sites.find(s => s.id === a.siteId)?.name, account: a })), { title: '移除保存的账号' }); account = pick?.account;
    }
    if (!account) { return; } await this.store.removeAccount(account); await this.reset();
  }
  private setSubmissionFilter(filter: SubmissionFilter): Promise<void> {
    this.views.submissions.submissionFilter = filter; this.views.submissions.refresh(true);
    return this.navigation.reveal('submissions');
  }
  private async filterSubmissions(): Promise<void> {
    const view = this.views.submissions, filter = { ...view.submissionFilter };
    type Item = vscode.QuickPickItem & { apply?: () => Promise<boolean> | boolean };
    const statuses = [0, -1, 1, 2, 3, -2, -3, 8, 4];
    const items: Item[] = [
      { label: `${filter.onlyMine ? '$(check) ' : ''}只看我的提交`, apply: () => { filter.onlyMine = true; filter.username = undefined; return true; } },
      { label: `${!filter.onlyMine && !filter.username ? '$(check) ' : ''}所有人的提交`, apply: () => { filter.onlyMine = false; filter.username = undefined; return true; } },
      { label: `$(person) 指定用户名…`, description: !filter.onlyMine && filter.username ? `当前：${filter.username}` : undefined, apply: async () => {
        const username = await vscode.window.showInputBox({ title: '只看此用户的提交', value: filter.username, prompt: '留空则显示所有人' });
        if (username === undefined) { return false; } filter.onlyMine = false; filter.username = username.trim() || undefined; return true;
      } },
      { label: '评测结果', kind: vscode.QuickPickItemKind.Separator },
      { label: `${filter.status === undefined ? '$(check) ' : ''}全部结果`, apply: () => { filter.status = undefined; return true; } },
      ...statuses.map(status => ({ label: `${filter.status === status ? '$(check) ' : ''}${verdict(status)}`, apply: () => { filter.status = status; return true; } }))
    ];
    const pick = await vscode.window.showQuickPick(items, { title: `筛选提交（${this.current ? `本题 ${this.current.displayId}` : '全部题目'}）`, placeHolder: view.filterText });
    if (pick?.apply && await pick.apply()) { await this.setSubmissionFilter(filter); }
  }
  /** Opens the current contest's scoreboard, or asks for the site-wide ACM / OI ranking. */
  /** Keeps a visible scoreboard of a running contest current. */
  private autoRefreshRank(): void {
    const contest = this.contest, now = Date.now() + this.serverOffset;
    if (this.rank?.kind !== 'contest' || this.docs.active?.kind !== 'rank' || !contest || contest.id !== this.rank.contestId || now < Date.parse(contest.startTime) || now >= Date.parse(contest.endTime)) { return; }
    void this.loadRank().catch(error => this.report(error, false));
  }
  private async showRank(kind?: RankKind): Promise<void> {
    if (!kind) {
      const items = [...(this.contest ? [{ label: '$(calendar) 当前比赛排行榜', description: this.contest.title, rank: 'contest' as const }] : []),
        { label: '$(graph) ACM 排行榜', description: '按通过题数', rank: 'acm' as const }, { label: '$(graph) OI 排行榜', description: '按总分', rank: 'oi' as const }];
      kind = (await vscode.window.showQuickPick(items, { title: '查看排行榜' }))?.rank; if (!kind) { return; }
    }
    if (kind === 'contest' && !this.contest) { throw new Error('请先进入一场比赛。'); }
    this.rank = { kind, page: 1, limit: vscode.workspace.getConfiguration('hoj-connecter').get('pageSize', 30), contestId: this.contest?.id };
    await this.loadRank(true);
  }
  private async loadRank(reveal = false, forceRefresh = false): Promise<void> {
    const rank = this.rank; if (!rank) { return; }
    const client = this.store.client(), view = { ...rank, me: this.store.account?.username };
    if (rank.kind === 'contest') {
      const contest = this.contest; if (!contest || contest.id !== rank.contestId) { throw new Error('比赛已切换，请重新打开排行榜。'); }
      const [data, problems] = await Promise.all([client.contestRank(contest.id, rank.page, rank.limit, { keyword: rank.keyword, forceRefresh }), client.problems({ ...this.store.scope }, 1, 0)]);
      rank.total = data.total;
      await this.docs.show(`rank-${this.store.site.id}-contest-${contest.id}`, `${contest.title} 排行榜`, contestRankMarkdown(contest, problems.records.map(problemId), data, view), 'rank', reveal);
    } else {
      const data = await client.rankList(rank.kind, rank.page, rank.limit, rank.keyword);
      rank.total = data.total;
      await this.docs.show(`rank-${this.store.site.id}-${rank.kind}`, `${rank.kind === 'oi' ? 'OI' : 'ACM'} 排行榜`, rankListMarkdown(this.store.site, data, view), 'rank', reveal);
    }
  }
  private async rankPage(delta: number): Promise<void> {
    const rank = this.rank; if (!rank) { return; }
    const pages = Math.max(1, Math.ceil((rank.total ?? 0) / rank.limit)), page = Math.min(pages, Math.max(1, rank.page + delta));
    if (page !== rank.page) { rank.page = page; await this.loadRank(); }
  }
  private async rankSearch(me = false): Promise<void> {
    const rank = this.rank; if (!rank) { return; }
    if (me && !this.store.account) { throw new Error('请先登录，再定位到自己的排名。'); }
    const keyword = me ? this.store.account!.username : await vscode.window.showInputBox({ title: '在排行榜中搜索用户', value: rank.keyword, prompt: '输入用户名，留空显示全部' });
    if (keyword === undefined) { return; }
    rank.keyword = keyword.trim() || undefined; rank.page = 1; await this.loadRank();
  }
  private async jumpPage(view?: Explorer): Promise<void> {
    if (!view?.paged) { return; }
    const pages = view.pageCount, items = Array.from({ length: pages }, (_, i) => ({ label: `第 ${i + 1} 页`, page: i + 1, description: i + 1 >= view.start && i + 1 <= view.page ? '当前' : undefined }));
    const pick = vscode.window.createQuickPick<typeof items[number]>();
    pick.title = `跳转到页（共 ${pages} 页 · ${view.total} 项）`; pick.placeholder = '输入页码，或从列表中选择'; pick.items = items;
    pick.activeItems = items.filter(item => item.page === view.start);
    const page = await new Promise<number | undefined>(resolve => {
      pick.onDidAccept(() => { const typed = Number(pick.value.trim()); resolve(Number.isInteger(typed) && typed >= 1 && typed <= pages ? typed : pick.selectedItems[0]?.page); pick.hide(); });
      pick.onDidHide(() => { resolve(undefined); pick.dispose(); });
      pick.show();
    });
    if (page !== undefined) { view.go(page); }
  }
  private async search(node?: Node): Promise<void> {
    await this.navigation.getChildren();
    const view = node?.list ? this.navigation.getList(node.list) : this.navigation.getProblemList(); if (!view) { return; }
    const scope = view.scope, revision = this.revision;
    const text = await vscode.window.showInputBox({ title: '搜索题目', value: view.browseScope ? view.keyword : this.keyword, prompt: scope.contestId ? '在当前比赛题单中筛选编号或标题' : scope.groupId ? '在团队题单的当前页筛选编号 / 标题；留空清除，可继续翻页' : '输入编号 / 标题，留空清除搜索' });
    if (text !== undefined && revision === this.revision) {
      if (view.browseScope) { view.keyword = text.trim(); } else { this.keyword = text.trim(); }
      view.refresh(true); this.navigation.refresh();
    }
  }
  private async openById(): Promise<void> {
    const id = await vscode.window.showInputBox({ title: this.contest ? '输入比赛题号，例如 A' : '输入题目编号，例如 P1000', validateInput: s => s.trim() ? undefined : '编号不能为空' });
    if (id) { await this.openProblem(id.trim(), { ...this.store.scope }); }
  }
  async openProblem(displayId: string, scope: Scope = { ...this.store.scope }): Promise<void> {
    this.checkBrowseScope(scope);
    const rev = ++this.revision, client = this.store.client(scope);
    const detail = await vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title: `加载 ${displayId}` }, () => client.problem(scope, displayId));
    if (rev !== this.revision) { return; }
    if (!sameScope(scope, this.store.scope)) {
      await this.reset(); this.group = this.store.selectedGroups.find(group => group.id === scope.groupId);
      this.store.scope = { ...scope }; await this.store.save(); this.refresh();
    }
    this.current = { displayId, scope: { ...scope }, detail, samples: parseSamples(detail.problem.examples) };
    this.samples.restore(this.current); await vscode.commands.executeCommand('setContext', 'hoj-connecter.hasProblem', true);
    this.refreshLocal(); this.views.submissions.refresh(true);
    await this.navigation.reveal('current'); await this.showProblem();
  }
  private async showProblem(): Promise<void> {
    const p = this.problem(), site = this.store.client(p.scope).site;
    await this.docs.show(problemKey(p.scope, p.displayId), `${p.displayId} ${p.detail.problem.title}`, problemMarkdown(p, site), 'problem', true, { problem: p, site });
  }
  private async attach(id: AssistantId): Promise<void> {
    if (this.attaching) { throw new Error('正在附加上下文，请稍候。'); }
    const entry = this.docs.active, attachment = entry?.attachment;
    if (!entry || !attachment) { throw new Error('请先打开题面或未通过的评测结果。'); }
    this.attaching = true;
    try {
      const { problem, site, submission } = attachment;
      const solutionUri = attachment.solutionUri ?? (entry.kind === 'problem' && problem ? this.store.binding(problem).active : undefined);
      let code = submission?.code ?? attachment.code;
      let language = submission?.language;
      if (entry.kind === 'problem' && solutionUri) {
        const document = await vscode.workspace.openTextDocument(vscode.Uri.parse(solutionUri));
        code = document.getText(); language = document.languageId;
      }
      await attachToAssistant(id, {
        statement: problem ? problemMarkdown(problem, site) : undefined,
        result: submission ? submissionMarkdown({ ...submission, code: undefined }) : entry.kind === 'result' ? entry.content : undefined,
        solutionUri, code, language
      });
    } finally { this.attaching = false; }
  }
  private async testSamples(): Promise<void> {
    const p = this.problem(); await this.samples.test(p);
    if (!this.current || !sameScope(p.scope, this.store.scope) || this.current.displayId !== p.displayId) { return; }
    const key = problemKey(p.scope, p.displayId), result = this.samples.lastOutcomes.get(key);
    if (result) {
      const attachment = result.failed + result.errored > 0 ? { problem: p, site: this.store.client(p.scope).site, ...this.samples.lastSources.get(key) } : undefined;
      await this.docs.show(`samples-${key}`, `${p.displayId} · 本地样例`, [`# ${p.displayId} · 本地样例`, `通过 **${result.passed}** · 失败 **${result.failed}** · 错误 **${result.errored}** · 跳过 **${result.skipped}**`, ...(this.samples.lastMessages.get(key) ?? []).map(m => fence(m, 'text'))].join('\n\n'), 'result', true, attachment);
    }
  }
  private async inputId(title: string): Promise<number | undefined> {
    const id = await vscode.window.showInputBox({ title, validateInput: s => /^\d+$/.test(s) && Number.isSafeInteger(Number(s)) && Number(s) > 0 ? undefined : '请输入正整数编号' }); return id ? Number(id) : undefined;
  }
  private checkScope(scope?: Scope): void {
    if (scope && !sameScope(scope, this.store.scope)) { throw new Error('站点、账号或比赛已切换，请刷新后重新选择。'); }
  }
  private checkSession(scope: Scope): void {
    if (scope.siteId !== this.store.scope.siteId || scope.accountId !== this.store.scope.accountId) { throw new Error('站点或账号已切换，请刷新后重新选择。'); }
  }
  private checkBrowseScope(scope: Scope): void {
    this.checkSession(scope);
    if (scope.contestId ? !sameScope(scope, this.store.scope) : scope.groupId && !this.store.selectedGroups.some(group => group.id === scope.groupId)) { throw new Error('该题目列表已过期，请刷新后重新选择。'); }
  }
  async selectGroups(groups: readonly Group[], scope: Scope): Promise<void> {
    this.checkSession(scope); this.revision++;
    await this.store.selectGroups(groups); this.checkSession(scope);
    if (this.group && !groups.some(group => group.id === this.group!.id)) { await this.reset(); } else { this.refresh(); }
  }
  private async pickGroups(): Promise<void> {
    const scope = { ...this.store.scope }, revision = this.revision, client = this.store.client(scope);
    const groups = new Map(this.store.selectedGroups.map(group => [group.id, group]));
    for (let page = 1; ; page++) {
      const data = await client.groups(page, 100);
      if (revision !== this.revision) { return; }
      for (const group of data.records) { groups.set(group.id, group); }
      if (!data.records.length || page * 100 >= data.total) { break; }
    }
    const selected = await vscode.window.showQuickPick([...groups.values()].map(group => ({ label: group.name, description: `#${group.id}`, picked: this.store.selectedGroups.some(selected => selected.id === group.id), group })), { title: '选择显示的团队', placeHolder: '可勾选多个团队，同时显示各团队的题单和比赛；取消勾选可隐藏', canPickMany: true });
    if (selected && revision === this.revision) { await this.selectGroups(selected.map(item => item.group), scope); }
  }
  private async enterGroup(target?: { id: number; scope: Scope }): Promise<void> {
    if (target) { this.checkSession(target.scope); } const id = target?.id ?? await this.inputId('输入团队编号'); if (!id) { return; }
    const rev = ++this.revision, group = await this.store.client().group(id); if (rev !== this.revision) { return; }
    await this.reset(); await this.store.selectGroups([...this.store.selectedGroups, group]); this.group = group; this.store.scope = { ...this.store.scope, groupId: id, contestId: undefined }; await this.store.save(); this.refresh(); await this.navigation.reveal('contests');
  }
  private async enterContest(target?: { id: number; scope: Scope }): Promise<void> {
    if (target) { this.checkBrowseScope(target.scope); } let id = target?.id;
    if (!id) {
      const input = await vscode.window.showInputBox({ title: '进入比赛', prompt: '输入比赛编号或网址，例如 1001 或 https://站点/contest/1001', validateInput: s => /^\d+$/.test(s.trim()) || /\/contest\/\d+/.test(s) ? undefined : '请输入比赛编号或包含 /contest/编号 的网址' });
      if (!input) { return; } id = Number(input.trim().match(/^\d+$/)?.[0] ?? input.match(/\/contest\/(\d+)/)?.[1]);
    }
    if (!id || !Number.isSafeInteger(id)) { return; }
    const rev = ++this.revision, client = this.store.client(), contest = await client.contest(id);
    if (rev !== this.revision) { return; }
    if (contest.auth === 1 || contest.auth === 2) {
      if (!this.store.account) { throw new Error('该比赛需要先登录账号。'); }
      if (!await client.contestAccess(id)) {
        const password = await vscode.window.showInputBox({ title: `${contest.title} · 比赛密码`, password: true, ignoreFocusOut: true });
        if (password === undefined) { return; } await client.registerContest(id, password);
      }
    }
    let group: Group | undefined;
    if (contest.gid) {
      try { group = this.store.selectedGroups.find(group => group.id === contest.gid) ?? await client.group(contest.gid); }
      catch (error) { this.report(error, false); group = { id: contest.gid, name: `团队 ${contest.gid}` }; }
    }
    if (rev !== this.revision) { return; }
    await this.reset(); this.group = group; this.contest = contest;
    if (group) { await this.store.selectGroups([...this.store.selectedGroups, group]); }
    this.serverOffset = contest.now ? Date.parse(contest.now) - Date.now() : 0;
    if (!Number.isFinite(this.serverOffset)) { this.serverOffset = 0; }
    this.store.scope = { ...this.store.scope, groupId: contest.gid || undefined, contestId: id }; await this.store.save(); this.refresh();
    // Load immediately even when the old problem view was collapsed or never shown.
    await this.views.problems.getChildren(); await this.navigation.reveal('problems'); await this.showContest();
  }
  private async registerContest(): Promise<void> {
    if (!this.contest) { throw new Error('请先进入比赛。'); }
    if (!this.store.account) { throw new Error('请先登录账号。'); }
    const contest = this.contest, client = this.store.client();
    const password = await vscode.window.showInputBox({ title: `${contest.title} · 比赛密码`, password: true, ignoreFocusOut: true });
    if (password !== undefined) { await client.registerContest(contest.id, password); this.refresh(); }
  }
  private async showContest(): Promise<void> { if (!this.contest) { throw new Error('请先进入一场比赛。'); } await this.docs.show(`contest-${this.store.site.id}-${this.contest.id}`, this.contest.title, contestMarkdown(this.contest, this.store.site), 'contest'); }
  private async leaveContext(): Promise<void> { this.store.scope = { siteId: this.store.scope.siteId, accountId: this.store.scope.accountId }; await this.store.save(); await this.reset(); }
  private async leaveContest(): Promise<void> {
    const group = this.group; await this.reset(); this.group = group; this.store.scope = { ...this.store.scope, groupId: group?.id }; await this.store.save(); this.refresh();
  }
  private async submit(): Promise<void> {
    requireTrust(); const problem = this.problem(); if (!this.store.account) { throw new Error('请先登录账号再提交。'); }
    const key = problemKey(problem.scope, problem.displayId);
    if (this.submitting.has(key)) { throw new Error('此题的提交操作正在进行。'); }
    this.submitting.add(key);
    try {
      const client = this.store.client(problem.scope), doc = await this.files.document(problem), language = await this.files.language(problem);
      this.checkScope(problem.scope); const code = doc.getText(); if (!code.trim()) { throw new Error('代码文件为空。'); }
      const submission = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `${problem.displayId} · 提交 ${path.basename(doc.uri.fsPath)} (${language})` }, () => client.submit(problem, language, code));
      if (!submission?.submitId) { throw new Error('站点没有返回提交编号，请先检查“我的提交”，避免重复提交。'); }
      this.output.appendLine(`提交 #${submission.submitId} · ${client.site.name} / ${client.account?.username} / ${problem.displayId} / ${path.basename(doc.uri.fsPath)}`);
      await this.docs.show(`submission-${client.site.id}-${submission.submitId}`, `提交 ${submission.submitId}`, `# ${problem.displayId} · 提交 #${submission.submitId}\n\n正在等待评测…\n\n文件：${path.basename(doc.uri.fsPath)} · ${language}`, 'result');
      this.views.submissions.refresh(true); await this.poll(client, submission.submitId, { problem, site: client.site, solutionUri: doc.uri.toString(), code });
    } finally { this.submitting.delete(key); }
  }
  private async poll(client: HojClient, id: number, source: DetailAttachment & { problem: OpenProblem }): Promise<void> {
    const { displayId, scope } = source.problem;
    const controller = new AbortController(); this.polling.add(controller);
    try {
      await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `${client.site.name} · ${displayId} · 提交 #${id}`, cancellable: true }, async (progress, token) => {
        const cancel = token.onCancellationRequested(() => controller.abort());
        try {
          const config = vscode.workspace.getConfiguration('hoj-connecter'); const end = Date.now() + config.get('pollTimeoutSeconds', 180) * 1000;
          while (!controller.signal.aborted && Date.now() < end) {
            const result = await client.submission(id); if (controller.signal.aborted) { return; }
            progress.report({ message: `${verdict(result.status)} ${scoreText(result)}` }); this.views.submissions.refresh();
            if (sameScope(scope, this.store.scope) && this.current?.displayId === displayId) {
              await this.docs.show(`submission-${client.site.id}-${id}`, `提交 ${id}`, submissionMarkdown(result), 'result', false, result.status !== 0 && !isPending(result.status) ? { ...source, submission: result } : undefined);
            }
            if (!isPending(result.status)) {
              this.output.appendLine(`#${id} · ${verdict(result.status)} ${scoreText(result)} · ${result.time ?? '?'} ms`);
              // Problem rows show the account's latest verdict.
              this.views.problems.refresh(); this.navigation.refreshLists();
              void vscode.window.showInformationMessage(`${displayId} · #${id} · ${verdict(result.status)} ${scoreText(result)}`); return;
            }
            await new Promise<void>(resolve => {
              const abort = () => { clearTimeout(timer); resolve(); };
              const timer = setTimeout(() => { controller.signal.removeEventListener('abort', abort); resolve(); }, config.get('pollIntervalMs', 1500));
              controller.signal.addEventListener('abort', abort, { once: true });
            });
          }
          if (!controller.signal.aborted) { vscode.window.showInformationMessage(`提交 #${id} 仍在评测，可在“我的提交”中刷新。`); }
        } finally { cancel.dispose(); }
      });
    } finally { this.polling.delete(controller); }
  }
  private async openSubmission(target?: { id: number; scope: Scope; displayId?: string }): Promise<void> {
    this.checkScope(target?.scope);
    let id = target?.id; if (!id) { id = await this.inputId('输入提交编号'); } if (!id) { return; }
    const revision = this.revision;
    const scope = target?.scope ?? { ...this.store.scope }, client = this.store.client(scope), result = await client.submission(id);
    const displayId = target?.displayId ?? result.displayId ?? result.displayPid;
    let problem: OpenProblem | undefined;
    if (displayId && result.status !== 0 && !isPending(result.status)) {
      if (this.current?.displayId === displayId && sameScope(this.current.scope, scope)) { problem = this.current; }
      else {
        try { const detail = await client.problem(scope, displayId); problem = { scope, displayId, detail, samples: parseSamples(detail.problem.examples) }; }
        catch (error) { this.report(error, false); }
      }
    }
    if (revision !== this.revision || !sameScope(scope, this.store.scope)) { return; }
    await this.docs.show(`submission-${scope.siteId}-${scope.accountId ?? 'guest'}-${id}`, `提交 ${id}`, submissionMarkdown(result), 'result', true,
      result.status !== 0 && !isPending(result.status) ? { site: client.site, problem, submission: result, solutionUri: problem ? this.store.binding(problem).active : undefined } : undefined);
  }
  private async openBrowser(): Promise<void> {
    const scope = this.store.scope, id = this.current?.displayId;
    const suffix = scope.contestId ? `/contest/${scope.contestId}${id ? `/problem/${encodeURIComponent(id)}` : ''}` : id ? `${scope.groupId ? `/group/${scope.groupId}` : ''}/problem/${encodeURIComponent(id)}` : scope.groupId ? `/group/${scope.groupId}` : '/problem';
    await vscode.env.openExternal(vscode.Uri.parse(`${this.store.site.url}${suffix}`));
  }
  dispose(): void {
    clearInterval(this.timer); this.polling.forEach(p => p.abort()); this.subscriptions.forEach(s => s.dispose()); this.navigation.dispose(); Object.values(this.views).forEach(v => v.dispose()); this.samples.dispose(); this.docs.dispose(); this.output.dispose(); this.status.dispose();
  }
}
export function activate(context: vscode.ExtensionContext): App { const app = new App(context); context.subscriptions.push(app); return app; }
export function deactivate(): void {}
