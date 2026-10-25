import * as vscode from 'vscode';
import { randomUUID } from 'node:crypto';
import { Account, Binding, Group, OpenProblem, problemKey, Scope, Site } from './domain';
import { HojClient, passwordKey, tokenKey } from './api';

export class Store {
  sites: Site[]; accounts: Account[]; scope: Scope;
  private readonly groupSelections: Record<string, Group[]>;
  constructor(private readonly context: vscode.ExtensionContext) {
    this.sites = context.globalState.get<Site[]>('sites') ?? [{ id: 'tulingsd', name: '图灵 · tulingsd.cn', url: 'http://tulingsd.cn', apiPath: '/api' }];
    this.accounts = context.globalState.get<Account[]>('accounts', []);
    const saved = context.globalState.get<Scope>('scope');
    const site = this.sites.find(s => s.id === saved?.siteId) ?? this.sites[0];
    this.scope = { siteId: site?.id ?? '', accountId: this.accounts.find(a => a.id === saved?.accountId && a.siteId === site?.id)?.id };
    this.groupSelections = context.globalState.get<Record<string, Group[]>>('selectedGroups', {});
  }
  private get groupSelectionKey(): string { return JSON.stringify([this.scope.siteId, this.scope.accountId ?? '']); }
  get selectedGroups(): readonly Group[] { return this.groupSelections[this.groupSelectionKey] ?? []; }
  async selectGroups(groups: readonly Group[]): Promise<void> {
    this.groupSelections[this.groupSelectionKey] = [...new Map(groups.map(group => [group.id, group])).values()];
    await this.context.globalState.update('selectedGroups', this.groupSelections);
  }
  get site(): Site { const s = this.sites.find(s => s.id === this.scope.siteId); if (!s) { throw new Error('请先添加一个 OJ 站点。'); } return s; }
  get account(): Account | undefined { return this.accounts.find(a => a.siteId === this.scope.siteId && a.id === this.scope.accountId); }
  client(scope: Scope = this.scope): HojClient {
    const site = this.sites.find(s => s.id === scope.siteId); if (!site) { throw new Error('当前站点已被移除。'); }
    return new HojClient(site, this.context.secrets, this.accounts.find(a => a.siteId === scope.siteId && a.id === scope.accountId), vscode.workspace.getConfiguration('hoj-connecter').get('requestTimeoutMs', 20000));
  }
  async save(): Promise<void> { await this.context.globalState.update('sites', this.sites); await this.context.globalState.update('accounts', this.accounts); await this.context.globalState.update('scope', this.scope); }
  async selectSite(site: Site): Promise<void> { this.scope = { siteId: site.id }; await this.save(); }
  async selectAccount(account?: Account): Promise<void> { this.scope = { siteId: this.scope.siteId, accountId: account?.id }; await this.save(); }
  /** A password is kept (in SecretStorage) only for username/password logins, to renew expired sessions. */
  async upsertAccount(username: string, token: string, nickname?: string, password?: string): Promise<Account> {
    let account = this.accounts.find(a => a.siteId === this.site.id && a.username === username);
    if (!account) { account = { id: randomUUID(), siteId: this.site.id, username, nickname }; this.accounts.push(account); }
    account.nickname = nickname;
    await this.context.secrets.store(tokenKey(account.siteId, account.id), token);
    if (password !== undefined) { await this.context.secrets.store(passwordKey(account.siteId, account.id), password); }
    await this.selectAccount(account); return account;
  }
  async removeAccount(account: Account): Promise<void> {
    await this.context.secrets.delete(tokenKey(account.siteId, account.id)); await this.context.secrets.delete(passwordKey(account.siteId, account.id)); this.accounts = this.accounts.filter(a => a.id !== account.id);
    if (this.scope.accountId === account.id) { await this.selectAccount(); } else { await this.save(); }
  }
  binding(problem: OpenProblem): Binding { return this.context.workspaceState.get<Binding>(`binding.${problemKey(problem.scope, problem.displayId)}`, { files: [] }); }
  async updateBinding(problem: OpenProblem, update: Partial<Binding>): Promise<Binding> {
    const binding = { ...this.binding(problem), ...update }; await this.context.workspaceState.update(`binding.${problemKey(problem.scope, problem.displayId)}`, binding); return binding;
  }
  async bindFile(problem: OpenProblem, uri: vscode.Uri): Promise<void> {
    const binding = this.binding(problem); const file = uri.toString();
    await this.updateBinding(problem, { active: file, files: [...new Set([...binding.files, file])] });
  }
}
