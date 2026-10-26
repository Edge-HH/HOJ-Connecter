import * as vscode from 'vscode';
import TurndownService from 'turndown';
import { Contest, isPending, JudgeCase, OpenProblem, scoreText, Site, Submission, verdict } from './domain';
import { randomUUID } from 'node:crypto';
import { escapeHtml, renderMarkdown } from './markdown';
import type { Assistant } from './assistants';

const turndown = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced' });
const readerContainer = 'workbench.view.extension.hoj-connecter-reader';
const readerLayoutVersion = 'hoj-connecter.reader.secondarySidebar.v1';
turndown.remove(['script', 'style', 'iframe', 'form', 'object']);
export function prose(value: string | undefined, site: Site): string {
  if (!value) { return ''; }
  let content = /<(?:p|div|span|table|h[1-6]|pre|img|br)\b/i.test(value) ? turndown.turndown(value) : value;
  content = content.replace(/\]\((\/[^)]*)\)/g, (_, href: string) => `](${new URL(href, `${site.url}/`).toString()})`);
  // Do not allow a statement from a remote OJ to inject command links or active HTML.
  return content.replace(/\]\(\s*(?:command|javascript|data|vscode):[^)]*\)/gi, '](#)').replace(/<(?:script|iframe|object)\b[\s\S]*?<\/(?:script|iframe|object)>/gi, '');
}
export function fence(value: string, language = ''): string {
  const longest = Math.max(2, ...[...value.matchAll(/`+/g)].map(m => m[0].length));
  const mark = '`'.repeat(longest + 1); return `${mark}${language}\n${value}\n${mark}`;
}
export function problemMarkdown(open: OpenProblem, site: Site): string {
  const p = open.detail.problem;
  const blocks = [`# ${open.displayId} · ${p.title}`, `站点：${site.name} · 时间限制：${p.timeLimit ?? '?'} ms · 内存限制：${p.memoryLimit ?? '?'} MB`,
    `提交语言：${open.detail.languages.join(' / ')}`, p.isFileIO ? `**文件 IO**：输入 ${p.ioReadFileName}，输出 ${p.ioWriteFileName}` : '',
    '## 题目描述', prose(p.description, site), '## 输入格式', prose(p.input, site), '## 输出格式', prose(p.output, site)];
  open.samples.forEach((s, i) => blocks.push(`## 样例 ${i + 1}`, '输入', fence(s.input, 'text'), '输出', fence(s.output, 'text')));
  if (p.hint) { blocks.push('## 提示', prose(p.hint, site)); }
  if (p.source) { blocks.push(`来源：${p.source}`); }
  return blocks.filter(Boolean).join('\n\n');
}
export function contestMarkdown(c: Contest, site: Site): string {
  return [`# ${c.title}`, `比赛编号：${c.id} · ${c.type === 1 ? 'OI' : 'ACM'}`, `开始：${new Date(c.startTime).toLocaleString()}`, `结束：${new Date(c.endTime).toLocaleString()}`, '时间使用本机时区，侧栏与状态栏显示实时倒计时。', prose(c.description, site)].join('\n\n');
}
export function submissionMarkdown(s: Submission): string {
  const error = s.errorMessage?.trim();
  const message = error && !/^The error message does not support viewing\.?$/i.test(error) ? s.errorMessage : undefined;
  return [`# 提交 #${s.submitId}`, `**${verdict(s.status)}** ${scoreText(s)}`, `语言：${s.language ?? '未知'} · 耗时：${s.time ?? '?'} ms · 内存：${s.memory ?? '?'} KB`, s.submitTime ? `提交时间：${new Date(s.submitTime).toLocaleString()}` : '', message ? `## 编译 / 运行信息\n\n${fence(message, 'text')}` : '', submissionCasesMarkdown(s), s.code ? `## 提交代码\n\n${fence(s.code)}` : ''].filter(Boolean).join('\n\n');
}
function caseVerdict(status: number | null | undefined): string { return status == null ? '未知' : status === -4 ? '跳过' : verdict(status); }
function caseListMarkdown(cases: JudgeCase[]): string {
  const rows = cases.map((c, i) => `| #${i + 1} | ${caseVerdict(c.status)} | ${c.score ?? '—'} | ${c.time ?? '—'} | ${c.memory ?? '—'} |`);
  const details = cases.flatMap((c, i) => {
    const fields = [['评测输出 / 错误提示', c.userOutput], ['错误信息', c.errorMessage], ['标准错误', c.stderr], ['输入数据 / 文件名', c.inputData], ['预期输出 / 文件名', c.outputData]];
    const blocks = fields.filter((field): field is [string, string] => typeof field[1] === 'string' && field[1].length > 0)
      .map(([label, value]) => `${label}\n\n${fence(value, 'text')}`);
    return blocks.length ? [`#### 测试点 #${i + 1} · ${caseVerdict(c.status)}\n\n${blocks.join('\n\n')}`] : [];
  });
  const missingErrors = cases.some(c => c.status != null && ![0, -4].includes(c.status) && !c.userOutput && !c.errorMessage && !c.stderr);
  return [`| 测试点 | 结果 | 得分 | 耗时 (ms) | 内存 (KB) |\n| --- | --- | --- | --- | --- |\n${rows.join('\n')}`, ...details,
    missingErrors ? '部分未通过的测试点未返回具体错误提示，可查看上表的判定结果。' : ''].filter(Boolean).join('\n\n');
}
function submissionCasesMarkdown(s: Submission): string {
  const heading = '## 测试点详情';
  if (isPending(s.status)) { return `${heading}\n\n评测尚未完成，完成后加载测试点详情。`; }
  if (s.caseResultError) { return `${heading}\n\n测试点详情获取失败，可重新打开本次提交重试。\n\n${fence(s.caseResultError, 'text')}`; }
  const result = s.caseResult;
  if (result == null) {
    return `${heading}\n\n${result === null ? '服务器未开放本次提交的测试点详情，可能受题目设置或比赛权限限制。' : '未获取到测试点详情，请重新打开本次提交。'}`;
  }
  const cases = result.judgeCaseList ?? [], groups = result.subTaskJudgeCaseVoList ?? [];
  const all = [...cases, ...groups.flatMap(g => g.subtaskDetailList ?? [])];
  if (!all.length && !groups.length) { return `${heading}\n\n${s.status === -2 ? '编译失败，未运行测试点。' : '服务器未返回测试点结果。'}`; }
  return [heading, all.length ? `共 **${all.length}** 个测试点 · 通过 **${all.filter(c => c.status === 0).length}**` : '', cases.length ? caseListMarkdown(cases) : '',
    ...groups.map((g, i) => [`### 子任务 #${g.groupNum ?? i + 1}`, `**${caseVerdict(g.status)}** · 得分：${g.score ?? '—'} · 通过：${g.ac ?? '—'}/${g.total ?? g.subtaskDetailList?.length ?? '—'} · 耗时：${g.time ?? '—'} ms · 内存：${g.memory ?? '—'} KB`,
      g.subtaskDetailList?.length ? caseListMarkdown(g.subtaskDetailList) : '服务器未返回该子任务的测试点记录。'].join('\n\n'))].filter(Boolean).join('\n\n');
}
export type DetailKind = 'problem' | 'result' | 'contest' | 'rank';
export interface DetailAttachment { site: Site; problem?: OpenProblem; submission?: Submission; solutionUri?: string; code?: string }
/** Extra footer buttons and a clickable list (e.g. contest problems) owned by one entry. */
export interface DetailExtras {
  buttons?: { action: string; label: string; title?: string }[];
  items?: { arg: string; label: string; description?: string; state?: 'ac' | 'failed' | 'pending' }[];
  itemsTitle?: string; itemAction?: string;
}
interface Detail { id: string; title: string; content: string; kind: DetailKind; attachment?: DetailAttachment; extras?: DetailExtras }
export class Documents implements vscode.TextDocumentContentProvider, vscode.WebviewViewProvider, vscode.Disposable {
  private readonly contents = new Map<string, string>();
  private readonly changed = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this.changed.event;
  private readonly sidebarChanged = new vscode.EventEmitter<void>();
  private view?: vscode.WebviewView;
  private rendered?: { entryId: string; heading: string; version: number };
  private renderVersion = 0;
  private renderSignature?: string;
  private disposed = false;
  private placement?: Promise<void>;
  get sidebarState() { return { resolved: !!this.view, visible: this.view?.visible ?? false, rendered: this.rendered }; }
  private readonly entries = new Map<DetailKind, Detail>();
  private readonly subscriptions: vscode.Disposable[] = [];
  active?: Detail;
  constructor(private readonly context: vscode.ExtensionContext, private readonly action: (command: string, ...args: unknown[]) => Promise<unknown>, private readonly report: (error: unknown) => void, private readonly state: () => { hasFile: boolean; loggedIn: boolean; assistants: readonly Assistant[] }) {}
  provideTextDocumentContent(uri: vscode.Uri): string { return this.contents.get(uri.toString()) ?? '内容已失效，请重新打开。'; }
  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    this.renderSignature = undefined; this.rendered = undefined;
    view.webview.options = { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'media')] };
    this.subscriptions.push(view.webview.onDidReceiveMessage(async message => {
      if (message?.type === 'ready' && message.entryId === (this.active?.id ?? '') && message.version === this.renderVersion) {
        this.rendered = { entryId: message.entryId, heading: String(message.heading ?? ''), version: message.version }; this.sidebarChanged.fire(); return;
      }
      if (!message || typeof message !== 'object' || message.entryId !== this.active?.id) { return; }
      try {
        if (message.type === 'tab' && ['problem', 'result', 'contest', 'rank'].includes(message.kind)) {
          const entry = this.entries.get(message.kind); if (entry) { this.active = entry; this.render(); } return;
        }
        const extras = this.active?.extras;
        if (message.type === 'item') {
          if (extras?.itemAction && extras.items?.some(item => item.arg === message.arg)) { await this.action(extras.itemAction, message.arg); } return;
        }
        if (message.type !== 'action') { return; }
        if (message.action === 'open-file') { await this.openAsFile(); }
        else if (extras?.buttons?.some(button => button.action === message.action)) { await this.action(message.action); }
        else if (['hoj-connecter.attachToCodex', 'hoj-connecter.attachToClaude', 'hoj-connecter.attachToCopilot'].includes(message.action) && this.active?.attachment) { await this.action(message.action); }
        else if (['hoj-connecter.fetchLastAcceptedCode', 'hoj-connecter.resetToTemplate'].includes(message.action)) {
          const state = this.state();
          if (this.active?.kind === 'problem' && state.hasFile && (message.action !== 'hoj-connecter.fetchLastAcceptedCode' || state.loggedIn)) { await this.action(message.action); }
        }
        else if (this.active?.kind === 'rank' && ['hoj-connecter.rankPrevious', 'hoj-connecter.rankNext', 'hoj-connecter.rankSearch', 'hoj-connecter.rankMe', 'hoj-connecter.rankRefresh'].includes(message.action)) { await this.action(message.action); }
        else if (['hoj-connecter.newSolution', 'hoj-connecter.bindActiveFile', 'hoj-connecter.openSolution', 'hoj-connecter.login', 'hoj-connecter.submit', 'hoj-connecter.testSamples', 'hoj-connecter.showTests'].includes(message.action)) { await this.action(message.action); }
      } catch (error) { this.report(error); }
    }), view.onDidChangeVisibility(() => this.sidebarChanged.fire()), view.onDidDispose(() => {
      if (this.view === view) { this.view = undefined; this.rendered = undefined; this.renderSignature = undefined; this.sidebarChanged.fire(); }
    }));
    this.render(); this.sidebarChanged.fire();
  }
  async show(id: string, title: string, content: string, kind: DetailKind = 'problem', reveal = true, attachment?: DetailAttachment, extras?: DetailExtras): Promise<void> {
    if (kind === 'problem' && this.entries.get('problem')?.id !== id) { this.entries.delete('result'); }
    const entry = { id, title, content, kind, attachment, extras }; this.entries.set(kind, entry);
    if (reveal || !this.active || (this.active.kind === kind && this.active.id === id)) { this.active = entry; }
    this.render();
    void vscode.commands.executeCommand('setContext', 'hoj-connecter.hasDetail', true);
    if (reveal) { await this.reveal(); }
  }
  private waitForSidebar(predicate: () => boolean, message: string): Promise<void> {
    if (predicate()) { return Promise.resolve(); }
    return new Promise((resolve, reject) => {
      const finish = () => {
        if (this.disposed || predicate()) { clearTimeout(timer); listener.dispose(); this.disposed ? reject(new Error('题面侧栏已关闭。')) : resolve(); }
      };
      const listener = this.sidebarChanged.event(finish);
      const timer = setTimeout(() => { listener.dispose(); reject(new Error(message)); }, 12000);
      finish();
    });
  }
  /** Native focus commands return before a collapsed WebviewView is resolved. */
  async reveal(): Promise<void> {
    // Existing installations may still store this view under the old OJ navigator.
    // Migrate once; later user layout customizations remain available until Restore.
    if (!this.context.globalState.get<boolean>(readerLayoutVersion)) {
      await (this.placement ??= this.resetPlacement().then(() => this.context.globalState.update(readerLayoutVersion, true)).finally(() => { this.placement = undefined; }));
    }
    await vscode.commands.executeCommand(readerContainer);
    await vscode.commands.executeCommand('hoj-connecter.details.focus', { preserveFocus: true });
    await this.waitForSidebar(() => !!this.view, '题面侧栏未能创建，请执行“HOJ-Connecter: 恢复题面侧栏”后重试。');
    this.view!.show(true);
    await this.waitForSidebar(() => !!this.view?.visible && this.rendered?.version === this.renderVersion, '题面侧栏未完成显示，请执行“HOJ-Connecter: 恢复题面侧栏”后重试。');
  }
  private async resetPlacement(): Promise<void> {
    await vscode.commands.executeCommand(`${readerContainer}.resetViewContainerLocation`);
    await vscode.commands.executeCommand('hoj-connecter.details.resetViewLocation');
  }
  async restore(): Promise<void> {
    await this.resetPlacement();
    this.renderSignature = undefined; this.render(); await this.reveal();
  }
  clear(): void { this.active = undefined; this.entries.clear(); this.render(); void vscode.commands.executeCommand('setContext', 'hoj-connecter.hasDetail', false); }
  refresh(force = false): void { if (force || this.active?.kind === 'problem') { this.render(); } }
  async openAsFile(kind?: DetailKind): Promise<void> {
    const entry = kind ? this.entries.get(kind) : this.active;
    if (!entry) { return; }
    const { id, title, content } = entry;
    const uri = vscode.Uri.from({ scheme: 'hoj-connecter', path: `/${encodeURIComponent(id)}/${title.replace(/[\\/]/g, '_')}.md` });
    this.contents.set(uri.toString(), content); this.changed.fire(uri);
    if (this.contents.size > 150) { this.contents.delete(this.contents.keys().next().value!); }
    const document = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(document, { viewColumn: vscode.ViewColumn.Active, preview: false });
  }
  private render(): void {
    const state = this.state();
    for (const name of ['Codex', 'Claude', 'Copilot']) {
      void vscode.commands.executeCommand('setContext', `hoj-connecter.canAttachTo${name}`, !!this.active?.attachment && state.assistants.some(a => a.name === name));
    }
    if (!this.view) { return; }
    const signature = JSON.stringify([this.active?.id, this.active?.content, !!this.active?.attachment, this.active?.extras, [...this.entries].map(([kind, entry]) => [kind, entry.id]), state]);
    // Reassigning identical HTML cancels an iframe that may still be starting.
    if (signature === this.renderSignature) { return; }
    this.renderSignature = signature; this.rendered = undefined;
    const version = ++this.renderVersion;
    const webview = this.view.webview, nonce = randomUUID().replace(/-/g, '');
    const css = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', 'details.css'));
    const katexCss = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', 'katex', 'katex.min.css'));
    const tabs = [...this.entries.values()].map(e => `<button class="tab ${this.active?.kind === e.kind ? 'selected' : ''}" data-tab="${e.kind}" aria-pressed="${this.active?.kind === e.kind}">${{ problem: '题面', result: '结果', contest: '比赛', rank: '排行' }[e.kind]}</button>`).join('');
    const actions = this.active?.kind === 'problem' ? state.hasFile ? `<button data-action="hoj-connecter.openSolution">打开代码</button><button data-action="${state.loggedIn ? 'hoj-connecter.submit' : 'hoj-connecter.login'}">${state.loggedIn ? '提交' : '登录'}</button><button data-action="hoj-connecter.testSamples">测试样例</button><button data-action="hoj-connecter.fetchLastAcceptedCode" ${state.loggedIn ? '' : 'disabled'} title="${state.loggedIn ? '获取当前账号的通过代码，将覆盖当前代码' : '请先登录'}">获取最后一次通过的代码</button><button data-action="hoj-connecter.resetToTemplate" title="使用当前语言的模板覆盖当前代码">重置为模板</button>` : '<button data-action="hoj-connecter.newSolution">新建代码</button><button data-action="hoj-connecter.bindActiveFile">关联当前文件</button>' : this.active?.kind === 'rank' ? '<button data-action="hoj-connecter.rankPrevious">‹ 上一页</button><button data-action="hoj-connecter.rankNext">下一页 ›</button><button data-action="hoj-connecter.rankSearch">搜索用户</button><button data-action="hoj-connecter.rankMe" title="按当前账号用户名搜索">定位到我</button><button data-action="hoj-connecter.rankRefresh">刷新</button>' : this.active?.id.startsWith('samples-') ? '<button data-action="hoj-connecter.showTests">测试面板</button>' : '';
    const extras = this.active?.extras;
    const extraButtons = (extras?.buttons ?? []).map(b => `<button data-action="${escapeHtml(b.action)}"${b.title ? ` title="${escapeHtml(b.title)}"` : ''}>${escapeHtml(b.label)}</button>`).join('');
    const items = extras?.items || extras?.itemsTitle ? `<section class="items"><h2>${escapeHtml(extras.itemsTitle ?? '')}</h2>${(extras.items ?? []).map(i => `<button class="item ${i.state ?? ''}" data-item="${escapeHtml(i.arg)}"><span>${escapeHtml(i.label)}</span>${i.description ? `<small>${escapeHtml(i.description)}</small>` : ''}</button>`).join('')}</section>` : '';
    const body = this.active ? renderMarkdown(this.active.content) : '';
    const assistantActions = this.active?.attachment ? state.assistants.map(a => `<button data-action="hoj-connecter.attachTo${a.name}" title="附加${this.active!.kind === 'result' ? '错误信息、代码和题面' : '题面和相关代码'}到 ${a.name} 输入区">附加到 ${a.name}</button>`).join('') : '';
    webview.html = `<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src https: http: data:; font-src ${webview.cspSource}; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';"><link rel="stylesheet" href="${css}"><link rel="stylesheet" href="${katexCss}"><title>${escapeHtml(this.active?.title ?? '题面与结果')}</title></head><body data-entry-id="${escapeHtml(this.active?.id ?? '')}"><header><nav aria-label="内容切换">${tabs}</nav>${this.active ? '<button class="file" data-action="open-file" title="在编辑区以 Markdown 文件打开">以文件打开 ↗</button>' : ''}</header><main>${this.active ? (/<\/h1>/.test(body) ? body.replace(/<\/h1>/, m => m + items) : items + body) : '<p class="empty">在左侧 OJ 导航中选择一道题，题面和评测结果将在右侧显示。</p>'}</main>${this.active ? `<footer>${actions}${extraButtons}${assistantActions}</footer>` : ''}<script nonce="${nonce}">const vscode=acquireVsCodeApi();const entryId=document.body.dataset.entryId;vscode.postMessage({type:'ready',entryId,version:${version},heading:document.querySelector('main h1')?.textContent||''});const state=vscode.getState();if(state?.entryId===entryId)requestAnimationFrame(()=>window.scrollTo(0,state.scrollY||0));document.addEventListener('click',e=>{const b=e.target.closest('button');if(!b)return;if(b.dataset.tab)vscode.postMessage({type:'tab',kind:b.dataset.tab,entryId});else if(b.dataset.action)vscode.postMessage({type:'action',action:b.dataset.action,entryId});else if(b.dataset.item!==undefined)vscode.postMessage({type:'item',arg:b.dataset.item,entryId});});window.addEventListener('scroll',()=>vscode.setState({entryId,scrollY:window.scrollY}),{passive:true});</script></body></html>`;
  }
  dispose(): void { this.disposed = true; this.sidebarChanged.fire(); this.subscriptions.forEach(s => s.dispose()); this.sidebarChanged.dispose(); this.changed.dispose(); this.contents.clear(); this.entries.clear(); }
}
