// Executed inside a real VS Code Extension Host, with a local HTTP fixture.
import * as vscode from 'vscode';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { App } from '../src/extension';
import { fixture } from './fixture';
import { problemKey } from '../src/domain';
import { verifyAssistants } from './assistants';
import { verifyNavigation } from './navigation';
import { discoverToolchains } from '../src/toolchains';
import { verifySolutions } from './solutions';
import { verifySubmissionDetails } from './submissions';

export async function run(): Promise<void> {
  const mock = await fixture(); const checks: string[] = [];
  const resultFile = process.env.HOJ_CONNECTER_TEST_RESULT;
  const check = (name: string) => { checks.push(name); console.log(`PASS ${name}`); };
  try {
    const extension = vscode.extensions.getExtension<App>('edge-hh.hoj-connecter'); assert.ok(extension, 'Extension should be discovered');
    const app = await extension.activate(); assert.ok(app.navigation.view); check('extension activates with one hierarchical native navigator and a sidebar detail view');
    const site = { id: 'fixture', name: 'Local test OJ', url: mock.url, apiPath: '/api' };
    app.store.sites = [site]; await app.store.selectSite(site);
    await app.store.upsertAccount('alice', 'token-alice'); app.refresh(true);
    const problems = await app.views.problems.getChildren(); assert.ok(problems.some(n => String(n.label).includes('P1000'))); check('native problem tree loads real HTTP records');
    if (process.env.HOJ_CONNECTER_EXPECT_COLLAPSED === '1') { assert.equal(app.docs.sidebarState.resolved, false, 'Saved collapsed reader should start unresolved'); check('reader starts collapsed from the persisted VS Code layout'); }
    const tabsBefore = vscode.window.tabGroups.all.reduce((n, g) => n + g.tabs.length, 0);
    await app.openProblem('P1000'); assert.equal(app.current?.samples.length, 2); assert.equal(app.docs.active?.kind, 'problem');
    assert.ok(app.docs.sidebarState.resolved, 'Sidebar WebviewView provider must actually resolve');
    assert.ok(app.docs.sidebarState.visible, 'Sidebar must actually be visible');
    assert.match(app.docs.sidebarState.rendered?.heading ?? '', /P1000.*A \+ B/, `Sidebar did not render the statement: ${JSON.stringify(app.docs.sidebarState)}`);
    assert.equal(vscode.window.tabGroups.all.reduce((n, g) => n + g.tabs.length, 0), tabsBefore);
    assert.equal(vscode.workspace.textDocuments.some(d => d.uri.scheme === 'hoj-connecter'), false); check('problem appears in sidebar without opening editor tabs or Markdown documents');
    const firstRender = app.docs.sidebarState.rendered;
    app.refreshLocal(); app.refreshLocal();
    assert.equal(app.docs.sidebarState.rendered, firstRender); check('identical refreshes preserve the running sidebar iframe');
    await vscode.commands.executeCommand('workbench.action.closeAuxiliaryBar');
    await vscode.commands.executeCommand('hoj-connecter.showProblem');
    assert.ok(app.docs.sidebarState.visible); assert.match(app.docs.sidebarState.rendered?.heading ?? '', /P1000/);
    assert.equal(vscode.window.tabGroups.all.reduce((n, g) => n + g.tabs.length, 0), tabsBefore);
    check('Show in Sidebar reopens the hidden sidebar and waits for actual rendered content');
    await vscode.commands.executeCommand('hoj-connecter.restoreSidebar'); assert.ok(app.docs.sidebarState.visible);
    assert.match(app.docs.sidebarState.rendered?.heading ?? '', /P1000/); check('Restore Sidebar recovers the reader location without opening an editor');
    const currentNodes = await app.views.current.getChildren(); assert.ok(currentNodes.find(n => n.label === '题目文件')?.children); assert.ok(currentNodes.find(n => n.label === '样例')?.children); check('file and sample actions live in nested menus');
    const folder = vscode.workspace.workspaceFolders![0].uri;
    const solution = vscode.Uri.joinPath(folder, 'solution with spaces.js');
    await vscode.workspace.fs.writeFile(solution, Buffer.from("let s='';process.stdin.on('data',x=>s+=x);process.stdin.on('end',()=>console.log(s.trim().split(/\\s+/).map(Number).reduce((a,b)=>a+b,0)));\n"));
    await vscode.window.showTextDocument(solution); await vscode.commands.executeCommand('hoj-connecter.bindActiveFile');
    assert.equal(app.store.binding(app.current!).active, solution.toString()); assert.equal(await app.files.language(app.current!), 'JavaScript'); check('active editor associates with problem and recommends allowed JavaScript automatically');
    const python = vscode.Uri.joinPath(folder, 'Main.py'); await vscode.workspace.fs.writeFile(python, Buffer.from('print(3)'));
    await vscode.window.showTextDocument(python); await vscode.commands.executeCommand('hoj-connecter.bindActiveFile'); assert.equal(app.store.binding(app.current!).language, 'Python3');
    await vscode.window.showTextDocument(solution); await vscode.commands.executeCommand('hoj-connecter.bindActiveFile'); assert.equal(app.store.binding(app.current!).language, 'JavaScript'); check('switching the bound file updates automatic language instead of reusing an incompatible choice');
    await verifySolutions(app, mock, check);
    assert.equal(await app.samples.import(app.current!, false), true);
    const sampleBinding = app.store.binding(app.current!); assert.ok(sampleBinding.sampleDir);
    assert.equal(app.samples.controller.items.size, 1);
    const input = vscode.Uri.joinPath(vscode.Uri.parse(sampleBinding.sampleDir!), '1.in'); assert.equal(Buffer.from(await vscode.workspace.fs.readFile(input)).toString(), '1 2\n');
    check('sample files are written and registered in native Test Explorer');
    assert.ok((await vscode.commands.getCommands()).includes('hoj-connecter.configureRunner'));
    assert.ok(currentNodes.find(n => n.label === '样例')?.children?.some(n => n.command?.command === 'hoj-connecter.configureRunner'));
    // No hoj-connecter.runners configuration: find a real Node installation from the host PATH.
    await vscode.commands.executeCommand('hoj-connecter.testSamples');
    assert.deepEqual(app.samples.lastOutcomes.get(problemKey(app.current!.scope, app.current!.displayId)), { passed: 2, failed: 0, errored: 0, skipped: 0 });
    assert.match(app.samples.lastMessages.get(problemKey(app.current!.scope, app.current!.displayId))![0], /自动选择：[\s\S]*node/i);
    check('automatic tool discovery runs samples without manual runner settings; native compiler selection command is available');
    const nativeNode = (await app.samples.runners.resolve(solution)).profile.run[0];
    const originalPicker = vscode.window.showQuickPick, originalDialog = vscode.window.showOpenDialog;
    try {
      for (const browse of [false, true]) {
        await vscode.workspace.getConfiguration('hoj-connecter', solution).update('runners', {}, vscode.ConfigurationTarget.WorkspaceFolder);
        let picked = false, opened = false;
        vscode.window.showQuickPick = (async (items: vscode.QuickPickItem[] | Thenable<vscode.QuickPickItem[]>) => {
          picked = true;
          return (await items).find(item => browse ? item.label.includes('浏览已安装') : item.label.includes('node'));
        }) as unknown as typeof vscode.window.showQuickPick;
        vscode.window.showOpenDialog = async () => { opened = true; return [vscode.Uri.file(nativeNode)]; };
        await vscode.commands.executeCommand('hoj-connecter.configureRunner');
        assert.equal(picked, true); assert.equal(opened, browse);
        assert.equal(path.relative((await app.samples.runners.resolve(solution)).profile.run[0], nativeNode), '');
        assert.equal(path.relative(vscode.workspace.getConfiguration('hoj-connecter', solution).get<Record<string, { run: string[] }>>('runners')!.js.run[0], nativeNode), '');
      }
    } finally { vscode.window.showQuickPick = originalPicker; vscode.window.showOpenDialog = originalDialog; }
    await vscode.workspace.getConfiguration('hoj-connecter', solution).update('runners', {}, vscode.ConfigurationTarget.WorkspaceFolder);
    check('compiler selection command saves both a detected tool and a browsed executable through native pickers');
    if ((await discoverToolchains('java')).length) {
      const javaSolution = vscode.Uri.joinPath(folder, 'Main.java');
      await vscode.workspace.fs.writeFile(javaSolution, Buffer.from('import java.util.*; public class Main { public static void main(String[] args) { Scanner in = new Scanner(System.in); long sum = 0; while (in.hasNextLong()) sum += in.nextLong(); System.out.println(sum); } }'));
      await vscode.window.showTextDocument(javaSolution); await vscode.commands.executeCommand('hoj-connecter.bindActiveFile');
      await vscode.commands.executeCommand('hoj-connecter.testSamples');
      assert.deepEqual(app.samples.lastOutcomes.get(problemKey(app.current!.scope, app.current!.displayId)), { passed: 2, failed: 0, errored: 0, skipped: 0 });
      assert.match(app.samples.lastMessages.get(problemKey(app.current!.scope, app.current!.displayId))![0], /自动选择：[\s\S]*javac/i);
      check('an automatically discovered real JDK compiles and runs every sample through the Testing API');
      await vscode.window.showTextDocument(solution); await vscode.commands.executeCommand('hoj-connecter.bindActiveFile');
    }
    const selectedProfile = { run: [process.execPath, '${file}'] };
    await app.samples.runners.save(solution, 'js', selectedProfile);
    assert.deepEqual((await app.samples.runners.resolve(solution)).profile, selectedProfile);
    assert.deepEqual(vscode.workspace.getConfiguration('hoj-connecter', solution).get<Record<string, unknown>>('runners')?.js, selectedProfile);
    await app.samples.runners.save(solution, 'py', { run: ['custom-python', '${file}'] });
    assert.deepEqual((await app.samples.runners.resolve(solution)).profile, selectedProfile, 'saving another language preserves the selected JavaScript runner');
    await assert.rejects(app.samples.runners.resolve(vscode.Uri.joinPath(folder, 'Main.unsupported')), /选择 \/ 配置本地编译器/);
    check('a selected tool is persisted in resource settings and takes priority over automatic discovery');
    await vscode.workspace.getConfiguration('hoj-connecter').update('runners', { js: { run: [process.execPath, '${file}'] } }, vscode.ConfigurationTarget.Workspace);
    // Electron's executable requires ELECTRON_RUN_AS_NODE when invoked as Node.
    const originalElectronMode = process.env.ELECTRON_RUN_AS_NODE; process.env.ELECTRON_RUN_AS_NODE = '1';
    await vscode.commands.executeCommand('hoj-connecter.testSamples');
    assert.deepEqual(app.samples.lastOutcomes.get(problemKey(app.current!.scope, app.current!.displayId)), { passed: 2, failed: 0, errored: 0, skipped: 0 });
    if (originalElectronMode === undefined) { delete process.env.ELECTRON_RUN_AS_NODE; } else { process.env.ELECTRON_RUN_AS_NODE = originalElectronMode; }
    check('local samples execute through the real Testing API');
    assert.equal(app.docs.active?.kind, 'result'); assert.ok(app.docs.active?.content.includes('通过 **2**'));
    assert.equal(!!app.docs.active?.attachment, false, 'passing local samples have no help buttons');
    assert.equal(vscode.window.activeTextEditor?.document.uri.toString(), solution.toString()); check('local test summary appears in sidebar and preserves the code editor');
    await vscode.commands.executeCommand('hoj-connecter.submit');
    const submitted = [...mock.requests].reverse().find(r => r.path === '/submit-problem-judge');
    assert.ok(submitted); assert.equal(submitted.authorization, 'token-alice'); assert.equal(submitted.body?.pid, 'P1000'); assert.ok(String(submitted.body?.code).includes('process.stdin'));
    assert.ok(mock.requests.filter(r => r.path === '/get-submission-detail').length >= 2);
    const submissions = await app.views.submissions.getChildren(); assert.ok(submissions.some(n => String(n.description).includes('75 分'))); assert.ok(app.docs.active?.content.includes('75 分')); check('submission sends bound code and shows the final 75-point result in sidebar');
    assert.ok(app.docs.active?.content.includes('wrong answer: expected 42, found 41'));
    assert.equal(mock.requests.filter(r => r.path === '/get-all-case-result').length, 1, 'load cases once, after the final verdict');
    await verifyAssistants(app, check);
    await verifySubmissionDetails(app, mock, check);
    for (const status of [0, 5, 7, -2, -1, 1, 3, 8]) {
      mock.setSubmission({ status, errorMessage: status === -2 ? 'error: missing semicolon' : undefined });
      await vscode.commands.executeCommand('hoj-connecter.openSubmission', { id: 42, scope: { ...app.store.scope }, displayId: 'P1000' });
      assert.equal(!!app.docs.active?.attachment, ![0, 5, 7].includes(status));
      if (status === -2) { assert.ok(app.docs.active?.attachment?.submission?.errorMessage?.includes('missing semicolon')); }
    }
    check('real submission loading hides help for AC/pending and includes CE, WA, TLE, RE and partial results');
    mock.setSubmission({});
    const sourceDocument = await vscode.workspace.openTextDocument(solution), originalSource = sourceDocument.getText();
    const replaceSource = async (text: string) => {
      const edit = new vscode.WorkspaceEdit(); edit.replace(solution, new vscode.Range(sourceDocument.positionAt(0), sourceDocument.positionAt(sourceDocument.getText().length)), text);
      assert.equal(await vscode.workspace.applyEdit(edit), true); assert.equal(await sourceDocument.save(), true);
    };
    const localTestElectronMode = process.env.ELECTRON_RUN_AS_NODE;
    try {
      await replaceSource('console.log(0);\n'); process.env.ELECTRON_RUN_AS_NODE = '1';
      await vscode.commands.executeCommand('hoj-connecter.testSamples');
      assert.equal(app.docs.active?.attachment?.code, 'console.log(0);\n');
      assert.equal(app.docs.active?.attachment?.solutionUri, solution.toString());
      assert.ok(app.docs.active?.content.includes('实际输出:')); assert.ok(app.docs.active?.content.includes('WA'));
      check('failed local samples attach output differences and the exact tested code');
    } finally {
      if (localTestElectronMode === undefined) { delete process.env.ELECTRON_RUN_AS_NODE; } else { process.env.ELECTRON_RUN_AS_NODE = localTestElectronMode; }
      await replaceSource(originalSource);
    }
    await vscode.commands.executeCommand('hoj-connecter.openResultAsFile'); assert.equal(vscode.window.activeTextEditor?.document.uri.scheme, 'hoj-connecter'); check('only explicit Open as File creates an editor document');
    await vscode.commands.executeCommand('hoj-connecter.enterGroup', { id: 7, scope: { ...app.store.scope } }); assert.equal(app.store.scope.groupId, 7); assert.equal(app.current, undefined); check('entering a team clears stale selected problems');
    await vscode.commands.executeCommand('hoj-connecter.enterContest', { id: 12, scope: { ...app.store.scope } }); assert.equal(app.store.scope.contestId, 12); assert.ok(app.status.text.includes('剩余')); check('contest context exposes server-adjusted countdown');
    assert.ok(mock.requests.some(r => r.path === '/get-contest-problem' && r.query.get('cid') === '12'));
    assert.ok((await app.views.problems.getChildren()).some(n => (n.value as {displayId?: string})?.displayId === 'A')); check('entering contest eagerly fetches its complete problem list');
    await app.openProblem('A'); assert.equal(app.store.binding(app.current!).active, undefined); check('contest A has isolated file bindings');
    await vscode.commands.executeCommand('hoj-connecter.leaveContest'); assert.equal(app.store.scope.contestId, undefined); assert.equal(app.store.scope.groupId, 7); check('leaving a team contest returns to the team');
    await verifyNavigation(app, mock, check);
    await vscode.commands.executeCommand('hoj-connecter.leaveContext'); assert.equal(app.store.scope.groupId, undefined);
    await vscode.commands.executeCommand('hoj-connecter.switchAccount', { site, account: undefined }); assert.equal(app.store.account, undefined); assert.equal(app.current, undefined); check('account switching clears contest and problem context');
    if (resultFile) { await fs.writeFile(resultFile, JSON.stringify({ ok: true, checks }, null, 2)); }
  } catch (error) {
    if (resultFile) { await fs.mkdir(path.dirname(resultFile), { recursive: true }); await fs.writeFile(resultFile, JSON.stringify({ ok: false, checks, error: error instanceof Error ? error.stack : String(error) }, null, 2)); }
    throw error;
  } finally { await mock.close(); }
}
