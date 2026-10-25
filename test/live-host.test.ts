// Opt-in, read-only authenticated integration. Credentials are supplied in memory
// through the environment and never written to source, test reports or logs.
import * as vscode from 'vscode';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import type { App } from '../src/extension';
export async function run(): Promise<void> {
  const checks: string[] = []; let app: App | undefined;
  try {
    const username = process.env.HOJ_CONNECTER_LIVE_USERNAME, password = process.env.HOJ_CONNECTER_LIVE_PASSWORD;
    const url = process.env.HOJ_CONNECTER_SITE, contestId = Number(process.env.HOJ_CONNECTER_LIVE_CONTEST);
    assert.ok(username && password, 'Provide HOJ_CONNECTER_LIVE_USERNAME and HOJ_CONNECTER_LIVE_PASSWORD');
    assert.ok(url && Number.isInteger(contestId) && contestId > 0, 'Provide HOJ_CONNECTER_SITE and HOJ_CONNECTER_LIVE_CONTEST');
    app = await vscode.extensions.getExtension<App>('edge-hh.hoj-connecter')!.activate();
    const site = { id: 'live-test', name: 'live check', url, apiPath: '/api' };
    app.store.sites = [site]; await app.store.selectSite(site);
    const result = await app.store.client().login(username, password);
    await app.store.upsertAccount(result.data.username ?? username, result.token);
    app.refresh(true);
    await vscode.commands.executeCommand('hoj-connecter.enterContest', { id: contestId, scope: { ...app.store.scope } });
    assert.equal(app.store.scope.contestId, contestId);
    const nodes = await app.views.problems.getChildren();
    const ids = nodes.map(n => (n.value as { displayId?: string })?.displayId).filter(Boolean);
    assert.ok(ids.length, 'contest has no problems'); checks.push(`authenticated contest lists ${ids.length} display IDs without manual entry`);
    const first = nodes.find(n => (n.value as { displayId?: string })?.displayId === ids[0]); assert.ok(first?.command);
    const editorTabs = vscode.window.tabGroups.all.reduce((n, g) => n + g.tabs.length, 0);
    await vscode.commands.executeCommand(first.command.command, ...first.command.arguments!);
    assert.ok(app.current?.detail.problem.title); assert.equal(app.docs.active?.kind, 'problem');
    assert.equal(vscode.window.tabGroups.all.reduce((n, g) => n + g.tabs.length, 0), editorTabs);
    checks.push('clicking the first problem shows the live statement in sidebar without opening any editor tabs');
    if (process.env.HOJ_CONNECTER_TEST_RESULT) { await fs.writeFile(process.env.HOJ_CONNECTER_TEST_RESULT, JSON.stringify({ ok: true, checks }, null, 2)); }
  } catch (error) {
    if (process.env.HOJ_CONNECTER_TEST_RESULT) { await fs.writeFile(process.env.HOJ_CONNECTER_TEST_RESULT, JSON.stringify({ ok: false, checks, error: error instanceof Error ? error.stack : String(error) }, null, 2)); }
    throw error;
  } finally {
    // Remove the short-lived real account from this isolated test profile.
    if (app?.store.account) { await app.store.removeAccount(app.store.account); }
  }
}
