import * as vscode from 'vscode';
import assert from 'node:assert/strict';
import type { App } from '../src/extension';
import { Node } from '../src/explorer';
import { Store } from '../src/store';
import type { fixture } from './fixture';

export async function verifyNavigation(app: App, mock: Awaited<ReturnType<typeof fixture>>, check: (name: string) => void): Promise<void> {
  const roots = () => app.navigation.getChildren();
  const root = async (label: string) => { const node = (await roots()).find(node => node.label === label); assert.ok(node, `Missing root: ${label}`); assert.equal(app.navigation.getParent(node), undefined); return node; };
  const children = async (label: string) => app.navigation.getChildren(await root(label));
  const click = async (node: Node) => { assert.ok(node.command); await vscode.commands.executeCommand(node.command.command, ...node.command.arguments!); };
  const checkbox = async (id: number) => { const node = (await children('选择团队')).find(node => (node.value as { group?: { id: number } })?.group?.id === id); assert.ok(node); assert.equal(node.command, undefined); return node; };
  const publicRoots = async () => { await root('公共题单'); await root('公共比赛'); };
  const site = app.store.site, account = app.store.account!, scope = { siteId: site.id, accountId: account.id };

  assert.equal((await checkbox(7)).checkboxState, vscode.TreeItemCheckboxState.Checked);
  const secondTeam = await checkbox(8);
  assert.equal(secondTeam.checkboxState, vscode.TreeItemCheckboxState.Unchecked);
  await app.navigation.setCheckedGroups([[secondTeam, vscode.TreeItemCheckboxState.Checked]]);
  assert.deepEqual(app.store.selectedGroups.map(group => group.id), [7, 8]);
  for (const label of ['训练营 题单', '训练营 比赛', '提高组 题单', '提高组 比赛']) { await root(label); }
  await publicRoots(); check('team checkboxes select multiple teams with separate top-level problem and contest lists');

  for (const [label, endpoint, gid] of [['公共题单', '/get-problem-list', undefined], ['公共比赛', '/get-contest-list', undefined], ['训练营 题单', '/group/get-problem-list', '7'], ['训练营 比赛', '/group/get-contest-list', '7'], ['提高组 题单', '/group/get-problem-list', '8'], ['提高组 比赛', '/group/get-contest-list', '8']] as const) {
    const count = mock.requests.length;
    await children(label);
    const request = mock.requests.slice(count).find(request => request.path === endpoint); assert.ok(request, `${label} must request ${endpoint}`);
    assert.equal(request.query.get('gid'), gid ?? null); assert.equal(request.query.has('cid'), false);
  }
  check('each public and team root requests its own scope while a team is active');

  const teamOne = await root('训练营 题单'), teamTwo = await root('提高组 题单'), publicList = await root('公共题单');
  const teamOneView = app.navigation.getList(teamOne.list!)!, teamTwoView = app.navigation.getList(teamTwo.list!)!;
  const firstPage = (await children('训练营 题单')).filter(node => (node.value as { displayId?: string })?.displayId).length;
  assert.match(String((await root('训练营 题单')).contextValue), /\bhoj-connecter\.paged\.next\b/);
  await click((await children('训练营 题单')).find(node => node.label === '加载更多')!);
  assert.equal(teamOneView.page, 2); assert.equal(teamOneView.start, 1); assert.equal(teamTwoView.page, 1); assert.equal(app.navigation.getList(publicList.list!)!.page, 1);
  const appended = await children('训练营 题单');
  assert.ok(appended.filter(node => (node.value as { displayId?: string })?.displayId).length > firstPage, 'load more keeps the first page and appends the next');
  assert.match(String((await root('训练营 题单')).description), /第 1-2\/\d+ 页/);
  await vscode.commands.executeCommand('hoj-connecter.previousPage', await root('训练营 题单'));
  assert.equal(teamOneView.start, 1); assert.equal(teamOneView.page, 1);
  await vscode.commands.executeCommand('hoj-connecter.page', { list: teamOne.list, page: 2 });
  assert.equal(teamOneView.start, 2); assert.equal(teamOneView.page, 2);
  assert.ok((await children('训练营 题单')).some(node => node.label === '上一页'));
  assert.ok(mock.requests.some(request => request.path === '/group/get-problem-list' && request.query.get('gid') === '7' && request.query.get('currentPage') === '2'));
  teamOneView.keyword = 'not-found'; teamOneView.refresh(true);
  assert.equal((await children('训练营 题单')).some(node => (node.value as { displayId?: string })?.displayId), false);
  assert.ok((await children('提高组 题单')).some(node => (node.value as { displayId?: string })?.displayId === 'P1000'));
  assert.equal(teamTwoView.keyword, ''); assert.equal(app.navigation.getList(publicList.list!)!.keyword, '');
  teamOneView.keyword = ''; teamOneView.refresh();
  check('team pagination and problem filters are independent of other team and public lists');

  const oldTeamOneProblem = (await children('训练营 题单')).find(node => (node.value as { displayId?: string })?.displayId === 'P1000')!;
  await click(oldTeamOneProblem);
  const teamOneProblem = app.current!;
  await app.store.bindFile(teamOneProblem, vscode.Uri.joinPath(vscode.workspace.workspaceFolders![0].uri, 'solution with spaces.js'));
  await click((await children('提高组 题单')).find(node => (node.value as { displayId?: string })?.displayId === 'P1000')!);
  assert.equal(app.current?.scope.groupId, 8); assert.equal(app.store.scope.groupId, 8);
  assert.equal(app.store.binding(app.current!).active, undefined); assert.ok(app.store.binding(teamOneProblem).active);
  assert.equal(mock.requests.filter(request => request.path === '/get-problem-detail').at(-1)!.query.get('gid'), '8');
  check('clicking another team problem changes the active scope and isolates file bindings');

  await click((await children('提高组 比赛')).find(node => (node.value as { id?: number })?.id === 13)!);
  assert.equal(app.contest?.id, 13); assert.equal(app.group?.id, 8);
  await publicRoots(); await root('提高赛 题单'); await root('训练营 题单'); await root('提高组 比赛');
  await children('公共题单'); await children('公共比赛');
  assert.equal(mock.requests.filter(request => request.path === '/get-problem-list').at(-1)!.query.has('gid'), false);
  assert.equal(mock.requests.filter(request => request.path === '/get-contest-list').at(-1)!.query.has('gid'), false);
  await click((await children('公共比赛')).find(node => (node.value as { id?: number })?.id === 14)!);
  assert.equal(app.contest?.id, 14); assert.equal(app.group, undefined);
  assert.deepEqual(app.store.selectedGroups.map(group => group.id), [7, 8]);
  await publicRoots(); await root('公开赛 题单'); await root('训练营 比赛');
  await click((await children('公共题单')).find(node => (node.value as { displayId?: string })?.displayId === 'P1000')!);
  assert.equal(app.store.scope.groupId, undefined); assert.equal(app.store.scope.contestId, undefined);
  assert.equal(app.current?.scope.groupId, undefined); assert.equal(app.contest, undefined);
  assert.equal(app.store.binding(app.current!).active?.endsWith('solution%20with%20spaces.js'), true);
  check('public and selected team roots stay available during contests and open the correct public problem or contest');

  await app.navigation.setCheckedGroups([[await checkbox(7), vscode.TreeItemCheckboxState.Unchecked]]);
  assert.equal((await roots()).some(node => node.label === '训练营 比赛' || node.label === '训练营 题单'), false);
  await root('提高组 题单'); await publicRoots();
  await assert.rejects(app.openProblem('P1000', (oldTeamOneProblem.value as { scope: typeof app.store.scope }).scope), /过期/);
  await click((await children('提高组 比赛')).find(node => (node.value as { id?: number })?.id === 13)!);
  await app.navigation.setCheckedGroups([[await checkbox(8), vscode.TreeItemCheckboxState.Unchecked]]);
  assert.equal(app.store.selectedGroups.length, 0); assert.equal(app.contest, undefined); assert.equal(app.current, undefined);
  await publicRoots(); check('unchecking teams removes only their roots, rejects stale problems and clears a removed active team');

  await app.navigation.setCheckedGroups([[await checkbox(7), vscode.TreeItemCheckboxState.Checked], [await checkbox(8), vscode.TreeItemCheckboxState.Checked]]);
  const staleCheckbox = await checkbox(7);
  await vscode.commands.executeCommand('hoj-connecter.switchAccount', { site, account: undefined });
  assert.equal(app.store.selectedGroups.length, 0); await publicRoots();
  await assert.rejects(app.navigation.setCheckedGroups([[staleCheckbox, vscode.TreeItemCheckboxState.Unchecked]]), /账号/);
  await vscode.commands.executeCommand('hoj-connecter.switchAccount', { site, account });
  assert.deepEqual(app.store.selectedGroups.map(group => group.id), [7, 8]);
  const otherSite = { ...site, id: 'fixture-other' }; app.store.sites.push(otherSite);
  await vscode.commands.executeCommand('hoj-connecter.switchSite', otherSite);
  assert.equal(app.store.selectedGroups.length, 0); await publicRoots();
  await vscode.commands.executeCommand('hoj-connecter.switchAccount', { site, account });
  assert.deepEqual(app.store.selectedGroups.map(group => group.id), [7, 8]);
  check('selected teams restore per site and account and stale checkbox events cannot change another account');

  const saved = new Map<string, unknown>([['sites', [site]], ['accounts', [account]], ['scope', scope]]);
  const context = { globalState: { get: (key: string, fallback?: unknown) => saved.get(key) ?? fallback, update: async (key: string, value: unknown) => { saved.set(key, structuredClone(value)); } } } as unknown as vscode.ExtensionContext;
  const store = new Store(context); await store.selectGroups(app.store.selectedGroups);
  assert.deepEqual(new Store(context).selectedGroups, app.store.selectedGroups);
  await store.selectAccount(); assert.equal(store.selectedGroups.length, 0);
  await store.selectAccount(account); assert.equal(store.selectedGroups.length, 2);
  check('team selections persist across Store reconstruction and remain separate from the active problem scope');
}
