import * as vscode from 'vscode';
import * as path from 'node:path';
import { Contest, contestClock, Group, isPending, OpenProblem, ProblemStatus, ProblemSummary, problemId, problemTitle, Scope, Submission, SubmissionFilter, verdict, verdictCode, scoreText } from './domain';
import { ApiError } from './api';
import { Store } from './store';
import { Files } from './files';

export type ViewName = 'session' | 'problems' | 'groups' | 'contests' | 'current' | 'submissions';
export interface ViewModel {
  store: Store; files: Files; current?: OpenProblem; group?: Group; contest?: Contest; serverOffset: number;
  keyword: string; revision: number; report(error: unknown, notify?: boolean): void;
  selectGroups(groups: readonly Group[], scope: Scope): Promise<void>;
}
const verdictColors: Record<number, string> = { 0: 'testing.iconPassed', '-1': 'testing.iconFailed', '-3': 'testing.iconFailed', 1: 'charts.orange', 2: 'charts.orange', 3: 'charts.purple', '-2': 'charts.yellow', 8: 'charts.blue', 4: 'problemsWarningIcon.foreground', 10: 'problemsWarningIcon.foreground' };
/** Green check for AC, a spinner while judging, otherwise a dot in the verdict's color. */
export function verdictIcon(status: number): vscode.ThemeIcon {
  if (status === 0) { return new vscode.ThemeIcon('pass-filled', new vscode.ThemeColor(verdictColors[0])); }
  if (isPending(status)) { return new vscode.ThemeIcon('sync~spin'); }
  const color = verdictColors[status];
  return color ? new vscode.ThemeIcon('error', new vscode.ThemeColor(color)) : new vscode.ThemeIcon('circle-outline');
}
function submissionNode(s: Submission, scope: Scope, displayId?: string, showUser = false): Node {
  const node = new Node(`#${s.submitId} · ${verdict(s.status)}${showUser && s.username ? ` · ${s.username}` : ''}`, 'hoj-connecter.openSubmission', { id: s.submitId, scope, displayId: displayId ?? s.displayId ?? s.displayPid }, undefined, [scoreText(s), s.displayId ?? s.displayPid, s.language].filter(Boolean).join(' · '));
  node.iconPath = verdictIcon(s.status); node.tooltip = `${s.title ?? ''}\n${s.time ?? '?'} ms / ${s.memory ?? '?'} KB${s.submitTime ? `\n${s.submitTime}` : ''}`; return node;
}
export class Node extends vscode.TreeItem {
  constructor(label: string, command?: string, readonly value?: unknown, icon?: string, description?: string) {
    super(label); this.description = description;
    if (command) { this.command = { command, title: label, arguments: [this] }; }
    if (icon) { this.iconPath = new vscode.ThemeIcon(icon); }
  }
  children?: Node[];
  /** Lazily fetched children, loaded each time the node expands. */
  load?: () => Promise<Node[]>;
  section?: ViewName;
  list?: string;
}
interface PageData { nodes: Node[]; total: number; count: number }
export type PaginationMode = 'append' | 'page';
export class Explorer implements vscode.TreeDataProvider<Node>, vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<Node | undefined>();
  readonly onDidChangeTreeData = this.changed.event;
  private readonly loaded = new vscode.EventEmitter<void>();
  /** Fires when the page status shown on the list's own row changes. */
  readonly onDidLoad = this.loaded.event;
  private cache?: Promise<Node[]>;
  private readonly pages = new Map<number, Promise<PageData>>();
  private generation = 0;
  /** Loaded pages are `start..page`; page mode keeps them equal, append mode grows `page`. */
  start = 1;
  page = 1;
  total = 0;
  shown = 0;
  limit = 30;
  paged = false;
  keyword = '';
  message?: string;
  submissionFilter: SubmissionFilter = { onlyMine: true };
  constructor(readonly name: ViewName, private readonly model: ViewModel, readonly browseScope?: Scope, readonly key?: string) {}
  get scope(): Scope { return { ...(this.browseScope ?? this.model.store.scope) }; }
  get pageCount(): number { return Math.max(1, Math.ceil(this.total / this.limit)); }
  get mode(): PaginationMode { return vscode.workspace.getConfiguration('hoj-connecter').get<PaginationMode>('paginationMode', 'append'); }
  get status(): string | undefined {
    if (!this.paged) { return undefined; }
    const range = this.start === this.page ? `第 ${this.page}/${this.pageCount} 页` : `第 ${this.start}-${this.page}/${this.pageCount} 页`;
    return this.mode === 'append' && this.hasNext ? `${range} · 已显示 ${this.shown}/${this.total}` : `${range} · 共 ${this.total} 项`;
  }
  /** Short summary of the submission filters, e.g. "全部人 · AC · 用户 alice". */
  get filterText(): string {
    const f = this.submissionFilter;
    return [f.onlyMine ? '只看我' : '全部人', f.status === undefined ? '' : verdict(f.status).split(' · ')[0], !f.onlyMine && f.username ? `用户 ${f.username}` : ''].filter(Boolean).join(' · ');
  }
  get hasPrevious(): boolean { return this.paged && this.start > 1; }
  get hasNext(): boolean { return this.paged && this.page * this.limit < this.total; }
  refresh(resetPage = false): void { if (resetPage) { this.start = this.page = 1; } this.pages.clear(); this.reload(); }
  private reload(): void { this.generation++; this.cache = undefined; this.changed.fire(undefined); }
  /** Shows only `page`, clamped to the known page range. */
  go(page: number): void { this.start = this.page = Math.min(Math.max(1, Math.floor(page) || 1), this.paged ? this.pageCount : Number.MAX_SAFE_INTEGER); this.reload(); }
  /** Appends the next page and reuses the pages already fetched. */
  more(): void { if (this.hasNext) { this.page++; this.reload(); } }
  getTreeItem(node: Node): Node { return node; }
  async getChildren(node?: Node): Promise<Node[]> {
    if (node) { return node.load ? node.load() : node.children ?? []; }
    if (!this.cache) {
      const generation = this.generation, before = this.status;
      this.cache = this.load().catch(error => {
        this.model.report(error, false); this.paged = false;
        return [new Node(error instanceof Error ? error.message : String(error), 'hoj-connecter.refresh', undefined, 'warning', '点击重试')];
      }).then(nodes => {
        if (generation !== this.generation) { return this.getChildren(); }
        if (this.status !== before) { this.loaded.fire(); }
        return nodes;
      });
    }
    return this.cache;
  }
  private async paginate(fetch: (page: number) => Promise<PageData>, empty: Node, extra: Node[] = []): Promise<Node[]> {
    const nodes: Node[] = []; let total = 0;
    for (let page = this.start; page <= this.page; page++) {
      let data = this.pages.get(page);
      if (!data) { data = fetch(page); this.pages.set(page, data); data.catch(() => this.pages.delete(page)); }
      const result = await data; nodes.push(...result.nodes); total = result.total;
      if (!result.count) { this.page = Math.max(this.start, page); break; }
    }
    this.paged = true; this.total = total; this.shown = nodes.length;
    if (!nodes.length) { nodes.push(empty); }
    if (this.hasPrevious) { nodes.unshift(new Node('上一页', 'hoj-connecter.page', { view: this.name, list: this.key, page: this.start - 1 }, 'chevron-left', `第 ${this.start - 1} 页`)); }
    nodes.push(...extra);
    if (this.hasNext) {
      nodes.push(this.mode === 'append'
        ? new Node('加载更多', 'hoj-connecter.morePage', { view: this.name, list: this.key }, 'chevron-down', `已显示 ${this.shown}/${this.total}`)
        : new Node('下一页', 'hoj-connecter.page', { view: this.name, list: this.key, page: this.page + 1 }, 'chevron-right', `第 ${this.page}/${this.pageCount} 页 · 共 ${this.total} 项`));
    }
    if (this.pageCount > 1) { nodes.push(new Node('跳转到页…', 'hoj-connecter.jumpPage', { view: this.name, list: this.key }, 'list-selection', `共 ${this.pageCount} 页`)); }
    return nodes;
  }
  private async load(): Promise<Node[]> {
    const m = this.model, store = m.store;
    const scope = this.scope, current = m.current, keyword = this.browseScope ? this.keyword : m.keyword;
    this.paged = false;
    if (this.name === 'session') { return this.sessions(); }
    if (!store.sites.length) { return [new Node('添加一个 HOJ 站点', 'hoj-connecter.addSite', undefined, 'add')]; }
    if (this.name === 'current') { return this.currentNodes(); }
    const client = store.client(scope), limit = this.limit = vscode.workspace.getConfiguration('hoj-connecter').get('pageSize', 30);
    if (this.name === 'problems') {
      this.message = `${scope.contestId ? `比赛：${m.contest?.title}` : scope.groupId ? `团队：${store.selectedGroups.find(g => g.id === scope.groupId)?.name}` : '公共题单'}${keyword ? ` · ${scope.groupId && !scope.contestId ? '当前页筛选：' : ''}${keyword}` : ''}`;
      const problemNodes = async (records: ProblemSummary[]) => {
        const pids = records.map(p => Number(p.pid ?? p.id)).filter(Number.isSafeInteger);
        let statuses: Record<string, ProblemStatus> = {};
        try { statuses = await client.problemStatus(scope, pids); } catch (error) { m.report(error, false); }
        return records.map(p => {
          const state = statuses[String(p.pid ?? p.id)], status = state?.status ?? -10, score = state?.score;
          const tried = status !== -10;
          const result = !tried || status === 0 ? undefined : score != null ? `${score} 分` : verdictCode(status);
          const node = new Node(`${problemId(p)} · ${problemTitle(p)}`, 'hoj-connecter.openProblem', { displayId: problemId(p), scope }, 'circle-large-outline', [result, p.score == null ? '' : `满分 ${p.score}`].filter(Boolean).join(' · ') || undefined);
          if (tried) { node.iconPath = verdictIcon(status); node.tooltip = `${verdict(status)}${score != null ? ` · ${score} 分` : ''}`; }
          node.contextValue = 'hoj-connecter.problem'; return node;
        });
      };
      const filter = (records: ProblemSummary[]) => (scope.contestId || scope.groupId) && keyword ? records.filter(p => `${problemId(p)} ${problemTitle(p)}`.toLowerCase().includes(keyword.toLowerCase())) : records;
      const empty = new Node(scope.contestId ? '题单暂未公布或当前筛选无匹配项' : '没有匹配的题目', 'hoj-connecter.refresh', undefined, 'info', '点击刷新');
      if (scope.contestId) {
        const nodes = await problemNodes(filter((await client.problems(scope, 1, limit, keyword)).records));
        return [new Node('比赛信息与时间', 'hoj-connecter.contestInfo', undefined, 'clock'), new Node('排行榜', 'hoj-connecter.showRank', 'contest', 'graph'), ...(nodes.length ? nodes : [empty])];
      }
      return this.paginate(async page => { const data = await client.problems(scope, page, limit, keyword); return { nodes: await problemNodes(filter(data.records)), total: data.total, count: data.records.length }; }, empty);
    }
    if (this.name === 'groups') {
      this.message = store.account ? '我的团队' : '公开团队';
      const groupNode = (group: Group) => {
        const node = new Node(group.name, undefined, { group, scope }, 'organization', `#${group.id}`);
        node.id = `group.${scope.siteId}.${scope.accountId ?? 'guest'}.${group.id}`;
        node.checkboxState = store.selectedGroups.some(g => g.id === group.id) ? vscode.TreeItemCheckboxState.Checked : vscode.TreeItemCheckboxState.Unchecked;
        return node;
      };
      const nodes = await this.paginate(async page => {
        const data = await client.groups(page, limit);
        const groups = page === this.start ? [...new Map([...store.selectedGroups, ...data.records].map(g => [g.id, g])).values()] : data.records;
        return { nodes: groups.map(groupNode), total: data.total, count: data.records.length };
      }, new Node('没有可加入的团队', undefined, undefined, 'info'), [new Node('按编号添加团队…', 'hoj-connecter.addGroup', undefined, 'go-to-file')]);
      // Appended pages can repeat a selected team already shown on the first page.
      const seen = new Set<string>(); return nodes.filter(node => !node.id || (!seen.has(node.id) && !!seen.add(node.id)));
    }
    if (this.name === 'contests') {
      this.message = scope.groupId ? `团队：${store.selectedGroups.find(g => g.id === scope.groupId)?.name}` : '公共比赛';
      return this.paginate(async page => {
        const data = await client.contests(scope, page, limit);
        return { nodes: data.records.map(c => new Node(c.title, 'hoj-connecter.enterContest', { id: c.id, scope }, 'calendar', `#${c.id} · ${contestClock(c, Date.now() + m.serverOffset)}`)), total: data.total, count: data.records.length };
      }, new Node('暂无比赛', undefined, undefined, 'info'), [new Node('按编号或网址进入比赛…', 'hoj-connecter.enterContest', undefined, 'go-to-file')]);
    }
    const filter = { ...this.submissionFilter };
    const filterNode = new Node(`筛选：${this.filterText}`, 'hoj-connecter.filterSubmissions', undefined, 'filter', current ? `本题 ${current.displayId}` : '全部题目');
    if (filter.onlyMine && !store.account) { return [new Node('登录后查看我的提交', 'hoj-connecter.login', undefined, 'sign-in'), filterNode]; }
    this.message = [current?.displayId, filter.onlyMine ? store.account?.username : '全部提交'].filter(Boolean).join(' · ');
    const nodes = await this.paginate(async page => {
      let data;
      try { data = await client.submissions(scope, current?.displayId, page, limit, filter); }
      catch (error) {
        if (!filter.onlyMine && error instanceof ApiError && error.status === 403) { throw new Error(scope.contestId ? '无权查看其他人的比赛提交（比赛可能已封榜或仅允许查看本人提交）。' : '站点不允许查看其他人的提交。'); }
        throw error;
      }
      return { nodes: data.records.map(s => submissionNode(s, scope, current?.displayId, !filter.onlyMine)), total: data.total, count: data.records.length };
    }, new Node(filter.onlyMine && filter.status === undefined ? '暂无提交' : '没有符合筛选条件的提交', undefined, undefined, 'inbox'));
    return [filterNode, ...nodes];
  }
  private sessions(): Node[] {
    const store = this.model.store;
    return store.sites.map(site => {
      const active = site.id === store.scope.siteId;
      const node = new Node(site.name, 'hoj-connecter.switchSite', site, 'globe', active ? '当前站点' : undefined);
      node.tooltip = `${site.url}\nAPI：${site.apiPath}`; node.contextValue = 'hoj-connecter.site';
      node.collapsibleState = active ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed;
      const guest = new Node('游客', 'hoj-connecter.switchAccount', { site, account: undefined }, 'person', active && !store.account ? '当前' : undefined);
      node.children = [guest, ...store.accounts.filter(a => a.siteId === site.id).map(account => {
        const item = new Node(account.nickname ? `${account.username} (${account.nickname})` : account.username, 'hoj-connecter.switchAccount', { site, account }, 'account', active && store.account?.id === account.id ? '当前' : undefined);
        item.contextValue = 'hoj-connecter.account'; return item;
      }), new Node('添加账号', 'hoj-connecter.login', site, 'sign-in')];
      return node;
    }).concat([new Node('添加站点', 'hoj-connecter.addSite', undefined, 'add')]);
  }
  private currentNodes(): Node[] {
    const m = this.model, p = m.current;
    if (!p) { return []; }
    const binding = m.store.binding(p), suggestion = m.files.suggestion(p);
    const files = new Node('题目文件', undefined, undefined, 'files', binding.active ? path.basename(vscode.Uri.parse(binding.active).fsPath) : '尚未关联');
    files.collapsibleState = vscode.TreeItemCollapsibleState.Collapsed;
    files.children = [new Node('新建题目文件', 'hoj-connecter.newSolution', undefined, 'new-file'), new Node('使用当前打开的文件', 'hoj-connecter.bindActiveFile', undefined, 'link'), new Node('切换 / 选择其他文件', 'hoj-connecter.switchSolution', undefined, 'folder-opened')];
    if (binding.active) { files.children.unshift(new Node(path.basename(vscode.Uri.parse(binding.active).fsPath), 'hoj-connecter.openSolution', undefined, 'file-code', '当前文件')); files.tooltip = vscode.Uri.parse(binding.active).fsPath; }
    const last = binding.files.at(-1);
    if (!binding.active && last) { files.children.unshift(new Node('重新关联', 'hoj-connecter.relinkSolution', undefined, 'link', binding.files.length > 1 ? `${binding.files.length} 个历史文件` : path.basename(vscode.Uri.parse(last).fsPath))); }
    if (binding.active) {
      files.children.push(new Node('取消关联当前文件', 'hoj-connecter.unbindSolution', undefined, 'debug-disconnect', '文件保留'), new Node('获取最后一次通过的代码', m.store.account ? 'hoj-connecter.fetchLastAcceptedCode' : undefined, undefined, 'cloud-download', m.store.account ? '覆盖当前代码' : '请先登录'), new Node('重置为模板', 'hoj-connecter.resetToTemplate', undefined, 'discard', '覆盖当前代码'));
    }
    const samples = new Node('样例', undefined, undefined, 'beaker', `${p.samples.length} 组`);
    samples.collapsibleState = vscode.TreeItemCollapsibleState.Collapsed;
    samples.children = [new Node('一键测试样例', 'hoj-connecter.testSamples', undefined, 'play'), new Node('选择 / 配置本地编译器', 'hoj-connecter.configureRunner', undefined, 'tools'), new Node('填入 / 更新本地样例', 'hoj-connecter.importSamples', undefined, 'cloud-download'), new Node('在测试面板查看', 'hoj-connecter.showTests', undefined, 'beaker')];
    const language = binding.languageMode !== 'auto' && binding.language ? binding.language : suggestion?.language;
    const languageNode = new Node(language ?? '选择提交语言', 'hoj-connecter.selectLanguage', undefined, 'code', binding.language && binding.languageMode !== 'auto' ? '手动' : '自动推荐');
    languageNode.tooltip = suggestion?.reason ?? '请关联代码文件，结合题目允许的语言自动推荐';
    return [new Node('查看题面', 'hoj-connecter.showProblem', undefined, 'book'), files, languageNode,
      new Node(m.store.account ? '提交评测' : '登录后提交', m.store.account ? 'hoj-connecter.submit' : 'hoj-connecter.login', undefined, 'cloud-upload'), samples,
      this.historyNode(p)];
  }
  /** The account's recent submissions to the open problem, fetched whenever it expands. */
  private historyNode(p: OpenProblem): Node {
    const store = this.model.store, account = store.account;
    const node = new Node('本题提交记录', undefined, undefined, 'history', account ? '我的最近提交' : '登录后查看我的提交');
    node.collapsibleState = vscode.TreeItemCollapsibleState.Expanded;
    const everyone = new Node('查看所有人的提交', 'hoj-connecter.problemSubmissions', undefined, 'organization');
    node.load = async () => {
      if (!account) { return [new Node('登录后查看', 'hoj-connecter.login', undefined, 'sign-in'), everyone]; }
      try {
        const data = await store.client(p.scope).submissions(p.scope, p.displayId, 1, 10, { onlyMine: true });
        const nodes = data.records.map(s => submissionNode(s, p.scope, p.displayId));
        return [...(nodes.length ? nodes : [new Node('暂无提交', undefined, undefined, 'inbox')]), ...(data.total > nodes.length ? [new Node('查看我的全部提交', 'hoj-connecter.mySubmissions', undefined, 'history', `共 ${data.total} 次`)] : []), everyone];
      } catch (error) {
        this.model.report(error, false);
        return [new Node(error instanceof Error ? error.message : String(error), 'hoj-connecter.refresh', undefined, 'warning', '点击重试'), everyone];
      }
    };
    return node;
  }
  dispose(): void { this.changed.dispose(); this.loaded.dispose(); }
}

/** One native tree, with lazy sections; only the active problem exposes actions. */
export class Navigation implements vscode.TreeDataProvider<Node>, vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<Node | undefined>();
  readonly onDidChangeTreeData = this.changed.event;
  readonly view: vscode.TreeView<Node>;
  private readonly parents = new WeakMap<Node, Node>();
  private readonly roots = new Map<ViewName, Node>();
  private readonly lists = new Map<string, { node: Node; explorer: Explorer }>();
  private sessionKey = '';
  private readonly subscriptions: vscode.Disposable[] = [];
  constructor(private readonly model: ViewModel, private readonly sections: Record<ViewName, Explorer>) {
    for (const [name, label, icon] of [['session', '站点与账号', 'globe'], ['current', '当前题目', 'book'], ['problems', '比赛题单', 'list-unordered'], ['groups', '选择团队', 'organization'], ['submissions', '我的提交', 'history']] as const) {
      const node = new Node(label, undefined, undefined, icon); node.id = `section.${name}`; node.section = name;
      node.collapsibleState = ['problems', 'current'].includes(name) ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed;
      this.roots.set(name, node);
      this.subscriptions.push(sections[name].onDidChangeTreeData(() => this.refresh()), sections[name].onDidLoad(() => this.refresh()));
    }
    this.view = vscode.window.createTreeView('hoj-connecter.navigation', { treeDataProvider: this, showCollapseAll: true, manageCheckboxStateManually: true });
    this.subscriptions.push(this.view.onDidChangeCheckboxState(event => { void this.setCheckedGroups(event.items).catch(error => { this.refresh(); this.model.report(error); }); }));
  }
  refresh(): void { this.changed.fire(undefined); }
  refreshLists(resetPage = false): void { for (const { explorer } of this.lists.values()) { explorer.refresh(resetPage); } this.refresh(); }
  getList(key: string): Explorer | undefined { return this.lists.get(key)?.explorer; }
  /** Resolves a list row or a pager node's `{ view, list }` value to its explorer. */
  explorerFor(target: { view?: ViewName; list?: string; section?: ViewName } | undefined): Explorer | undefined {
    if (!target) { return undefined; }
    if (target.list) { return this.getList(target.list); }
    const name = target.section ?? target.view; return name ? this.sections[name] : undefined;
  }
  /** Shows page status on the list's own row and exposes the inline paging buttons. */
  private decorate(node: Node, explorer: Explorer, base: string, description?: string): void {
    node.description = [description, explorer.status].filter(Boolean).join(' · ') || undefined;
    node.contextValue = [base, explorer.hasPrevious && 'hoj-connecter.paged.prev', explorer.hasNext && 'hoj-connecter.paged.next', explorer.paged && explorer.pageCount > 1 && 'hoj-connecter.paged.jump'].filter(Boolean).join(' ');
  }
  getProblemList(): Explorer | undefined {
    const scope = this.model.store.scope;
    return scope.contestId ? this.sections.problems : this.getList(JSON.stringify([scope.siteId, scope.accountId ?? '', 'problems', scope.groupId ?? 0]));
  }
  async setCheckedGroups(items: readonly [Node, vscode.TreeItemCheckboxState][]): Promise<void> {
    const groups = new Map(this.model.store.selectedGroups.map(group => [group.id, group]));
    let scope: Scope | undefined;
    for (const [node, state] of items) {
      const target = node.value as { group?: Group; scope?: Scope } | undefined;
      if (!target?.group || !target.scope) { continue; }
      scope = target.scope;
      if (scope.siteId !== this.model.store.scope.siteId || scope.accountId !== this.model.store.scope.accountId) { throw new Error('站点或账号已切换，请重新选择团队。'); }
      if (state === vscode.TreeItemCheckboxState.Checked) { groups.set(target.group.id, target.group); } else { groups.delete(target.group.id); }
    }
    if (scope) { await this.model.selectGroups([...groups.values()], scope); }
  }
  private list(name: 'problems' | 'contests', scope: Scope, label: string): Node {
    const key = JSON.stringify([scope.siteId, scope.accountId ?? '', name, scope.groupId ?? 0]);
    let entry = this.lists.get(key);
    if (!entry) {
      const explorer = new Explorer(name, this.model, { ...scope }, key);
      explorer.onDidLoad(() => this.refresh());
      const node = new Node(label, undefined, undefined, name === 'problems' ? 'list-unordered' : 'calendar');
      node.id = `list.${key}`; node.list = key;
      node.collapsibleState = name === 'problems' && !scope.groupId ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed;
      entry = { node, explorer }; this.lists.set(key, entry);
    }
    entry.node.label = label; this.decorate(entry.node, entry.explorer, name === 'problems' ? 'hoj-connecter.problemList' : 'hoj-connecter.contestList', entry.explorer.keyword);
    return entry.node;
  }
  tick(): void { const root = this.roots.get('problems')!; root.description = this.model.contest ? contestClock(this.model.contest, Date.now() + this.model.serverOffset) : undefined; this.changed.fire(root); }
  getTreeItem(node: Node): Node { return node; }
  getParent(node: Node): Node | undefined { return this.parents.get(node); }
  async getChildren(node?: Node): Promise<Node[]> {
    if (!node) {
      const m = this.model, site = m.store.sites.find(s => s.id === m.store.scope.siteId);
      const scope: Scope = { siteId: m.store.scope.siteId, accountId: m.store.scope.accountId };
      const sessionKey = JSON.stringify([scope.siteId, scope.accountId ?? '']);
      if (sessionKey !== this.sessionKey) {
        for (const { explorer } of this.lists.values()) { explorer.dispose(); }
        this.lists.clear(); this.sessionKey = sessionKey;
      }
      const selectedIds = new Set(m.store.selectedGroups.map(group => group.id));
      for (const [key, entry] of this.lists) {
        if (entry.explorer.browseScope?.groupId && !selectedIds.has(entry.explorer.browseScope.groupId)) { entry.explorer.dispose(); this.lists.delete(key); }
      }
      const session = this.roots.get('session')!; session.label = site?.name ?? '添加站点'; session.description = m.store.account?.username ?? '游客'; session.contextValue = 'hoj-connecter.session';
      const problems = this.roots.get('problems')!; problems.label = `${m.contest?.title} 题单`; problems.id = `section.problems.${m.contest?.id ?? ''}`; problems.contextValue = 'hoj-connecter.problemList'; problems.description = m.contest ? contestClock(m.contest, Date.now() + m.serverOffset) : undefined;
      const current = this.roots.get('current')!; current.label = m.current ? `${m.current.displayId} · ${m.current.detail.problem.title}` : '当前题目'; current.contextValue = 'hoj-connecter.current';
      const groups = this.roots.get('groups')!; this.decorate(groups, this.sections.groups, 'hoj-connecter.groups', m.store.selectedGroups.length ? `已选 ${m.store.selectedGroups.length} 个团队` : '勾选可多选');
      const submissions = this.roots.get('submissions')!, submissionView = this.sections.submissions;
      submissions.label = submissionView.submissionFilter.onlyMine ? '我的提交' : '提交记录';
      this.decorate(submissions, submissionView, 'hoj-connecter.submissions', submissionView.submissionFilter.onlyMine && submissionView.submissionFilter.status === undefined ? undefined : submissionView.filterText);
      const teamLists = m.store.selectedGroups.flatMap(group => [this.list('problems', { ...scope, groupId: group.id }, `${group.name} 题单`), this.list('contests', { ...scope, groupId: group.id }, `${group.name} 比赛`)]);
      const actions = [
        ...(m.contest ? [new Node('退出比赛', 'hoj-connecter.leaveContest', undefined, 'arrow-left')] : []),
        ...(m.group || m.contest ? [new Node('返回公共题单', 'hoj-connecter.leaveContext', undefined, 'home')] : [])
      ];
      return [session, groups, ...(m.current ? [current] : []), ...(m.contest ? [problems] : []), this.list('problems', scope, '公共题单'), this.list('contests', scope, '公共比赛'), ...teamLists, this.roots.get('submissions')!, ...actions];
    }
    const children = node.list ? await this.getList(node.list)?.getChildren() ?? [] : node.section ? await this.sections[node.section].getChildren() : node.load ? await node.load() : node.children ?? [];
    children.forEach((child, index) => { this.parents.set(child, node!); child.id ??= `${node!.id}/${index}/${typeof child.label === 'string' ? child.label : ''}`; });
    return children;
  }
  async reveal(name: ViewName): Promise<void> {
    await vscode.commands.executeCommand('workbench.view.extension.hoj-connecter');
    await this.getChildren();
    let node = this.roots.get(name);
    if ((name === 'problems' && !this.model.contest) || name === 'contests') {
      const scope = { siteId: this.model.store.scope.siteId, accountId: this.model.store.scope.accountId, groupId: this.model.store.scope.groupId };
      node = this.list(name, scope, scope.groupId ? `${this.model.group?.name} ${name === 'problems' ? '题单' : '比赛'}` : name === 'problems' ? '公共题单' : '公共比赛');
    }
    try { if (node) { await this.view.reveal(node, { expand: 1, focus: false, select: false }); } }
    catch (error) { this.model.report(error, false); }
  }
  dispose(): void { this.subscriptions.forEach(s => s.dispose()); for (const { explorer } of this.lists.values()) { explorer.dispose(); } this.changed.dispose(); this.view.dispose(); }
}
