// Focused regression suite, also runnable against a packaged extension snapshot.
import * as vscode from 'vscode';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import type { App } from '../src/extension';
import { fixture } from './fixture';

export async function run(): Promise<void> {
  const mock = await fixture(), checks: string[] = [];
  const resultFile = process.env.HOJ_CONNECTER_TEST_RESULT;
  const check = (text: string) => { checks.push(text); console.log(`PASS ${text}`); };
  try {
    const app = await vscode.extensions.getExtension<App>('edge-hh.hoj-connecter')!.activate();
    const contributions = vscode.extensions.getExtension('edge-hh.hoj-connecter')!.packageJSON.contributes;
    assert.ok(contributions.viewsContainers.secondarySidebar.some((c: { id: string }) => c.id === 'hoj-connecter-reader'));
    assert.ok(contributions.views['hoj-connecter-reader'].some((v: { id: string }) => v.id === 'hoj-connecter.details'));
    assert.ok(!contributions.views['hoj-connecter'].some((v: { id: string }) => v.id === 'hoj-connecter.details'));
    check('reader has an independent native Secondary Side Bar container, separate from left navigation');
    const site = { id: 'sidebar-test', name: 'Sidebar fixture', url: mock.url, apiPath: '/api' };
    app.store.sites = [site]; await app.store.selectSite(site); app.refresh(true);
    if (process.env.HOJ_CONNECTER_EXPECT_COLLAPSED === '1') { assert.equal(app.docs.sidebarState.resolved, false); check('persisted collapsed reader starts unresolved'); }
    const file = vscode.Uri.joinPath(vscode.workspace.workspaceFolders![0].uri, 'sidebar-editor.js');
    await vscode.workspace.fs.writeFile(file, Buffer.from('console.log(1);'));
    await vscode.window.showTextDocument(file);
    const tabs = () => vscode.window.tabGroups.all.reduce((n, group) => n + group.tabs.length, 0);
    const initialTabs = tabs();
    await app.openProblem('P1000');
    assert.ok(app.docs.sidebarState.resolved && app.docs.sidebarState.visible);
    assert.match(app.docs.sidebarState.rendered?.heading ?? '', /P1000.*A \+ B/);
    assert.equal(tabs(), initialTabs); assert.equal(vscode.window.activeTextEditor?.document.uri.toString(), file.toString());
    check('Open Problem expands the native reader and waits for rendered statement, preserving the editor');
    const firstRender = app.docs.sidebarState.rendered;
    app.refreshLocal(); app.refreshLocal(); assert.equal(app.docs.sidebarState.rendered, firstRender);
    check('unchanged refreshes do not replace the sidebar iframe');
    await vscode.commands.executeCommand('workbench.action.closeAuxiliaryBar');
    await vscode.commands.executeCommand('hoj-connecter.showProblem');
    assert.ok(app.docs.sidebarState.visible); assert.match(app.docs.sidebarState.rendered?.heading ?? '', /P1000/); assert.equal(tabs(), initialTabs);
    check('Show in Sidebar recovers a closed sidebar without creating editor tabs');
    await vscode.commands.executeCommand('vscode.moveViews', { viewIds: ['hoj-connecter.details'], destinationId: 'workbench.view.extension.hoj-connecter' });
    await vscode.commands.executeCommand('hoj-connecter.restoreSidebar');
    assert.ok(app.docs.sidebarState.visible); assert.match(app.docs.sidebarState.rendered?.heading ?? '', /P1000/);
    check('Restore Sidebar recovers the reader from the left navigation');
    await vscode.commands.executeCommand('workbench.action.closeAuxiliaryBar');
    await new Promise(resolve => setTimeout(resolve, 200));
    assert.equal(app.docs.sidebarState.visible, false, 'restored reader must belong to the right Secondary Side Bar');
    await vscode.commands.executeCommand('workbench.action.closeSidebar');
    await vscode.commands.executeCommand('hoj-connecter.showProblem');
    assert.ok(app.docs.sidebarState.visible); assert.equal(tabs(), initialTabs);
    check('right reader can reopen independently when both sidebars are closed');
    await app.docs.show('sidebar-result', '评测结果', '# 提交 #42\n\nAC · 100 分', 'result');
    assert.match(app.docs.sidebarState.rendered?.heading ?? '', /提交 #42/); assert.equal(tabs(), initialTabs);
    check('submission results also render in the sidebar');
    await vscode.commands.executeCommand('hoj-connecter.openDetailAsFile'); assert.equal(vscode.window.activeTextEditor?.document.uri.scheme, 'hoj-connecter');
    check('only explicit Open as File creates an editor document');
    if (resultFile) { await fs.writeFile(resultFile, JSON.stringify({ ok: true, checks }, null, 2)); }
  } catch (error) {
    if (resultFile) { await fs.writeFile(resultFile, JSON.stringify({ ok: false, checks, error: error instanceof Error ? error.stack : String(error) }, null, 2)); }
    throw error;
  } finally { await mock.close(); }
}
