import * as vscode from 'vscode';
import assert from 'node:assert/strict';
import { App } from '../src/extension';
import { Documents } from '../src/documents';
import { starter } from '../src/process';
import { fixture } from './fixture';

export async function verifySolutions(app: App, mock: Awaited<ReturnType<typeof fixture>>, check: (name: string) => void): Promise<void> {
  const problem = app.current!, binding = app.store.binding(problem), templates = problem.detail.codeTemplate;
  const doc = await vscode.workspace.openTextDocument(vscode.Uri.parse(binding.active!)), original = doc.getText();
  const disk = Buffer.from(await vscode.workspace.fs.readFile(doc.uri)).toString();
  const originalWarning = vscode.window.showWarningMessage;
  const warnings: { message: string; options: vscode.MessageOptions }[] = [];
  let confirm = false, duringWarning: (() => Promise<void>) | undefined;
  vscode.window.showWarningMessage = (async (message: string, options: vscode.MessageOptions, ...items: string[]) => {
    warnings.push({ message, options });
    await duringWarning?.();
    return confirm ? items[0] : undefined;
  }) as typeof vscode.window.showWarningMessage;
  const replace = async (text: string) => {
    const edit = new vscode.WorkspaceEdit();
    edit.replace(doc.uri, new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length)), text);
    assert.equal(await vscode.workspace.applyEdit(edit), true);
  };
  const fileActions = async () => (await app.views.current.getChildren()).find(node => node.label === '题目文件')!.children!;
  try {
    await app.store.updateBinding(problem, { active: undefined }); app.refreshLocal();
    assert.equal((await fileActions()).some(node => ['hoj-connecter.fetchLastAcceptedCode', 'hoj-connecter.resetToTemplate'].includes(node.command?.command ?? '')), false);
    const requests = mock.requests.length;
    await assert.rejects(app.files.resetToTemplate(problem), /先新建或关联/);
    await assert.rejects(app.files.fetchLastAcceptedCode(problem), /先新建或关联/);
    assert.equal(mock.requests.length, requests); assert.equal(warnings.length, 0);
    await app.store.updateBinding(problem, binding); app.refreshLocal();
    assert.ok((await fileActions()).some(node => node.command?.command === 'hoj-connecter.fetchLastAcceptedCode'));
    assert.ok((await fileActions()).some(node => node.command?.command === 'hoj-connecter.resetToTemplate'));
    check('code replacement actions require an existing problem file and never start file creation');

    const dirty = '// unsaved work\n' + original;
    await replace(dirty); assert.ok(doc.isDirty);
    problem.detail.codeTemplate = { JavaScript: '// server template\r\nconsole.log("template");\r\n' };
    await app.files.resetToTemplate(problem);
    await app.files.fetchLastAcceptedCode(problem);
    assert.equal(doc.getText(), dirty); assert.ok(doc.isDirty);
    assert.equal(Buffer.from(await vscode.workspace.fs.readFile(doc.uri)).toString(), disk);
    assert.equal(warnings.length, 2);
    for (const warning of warnings) {
      assert.match(warning.message, /覆盖.*当前代码.*未保存/);
      assert.ok(warning.message.includes('solution with spaces.js')); assert.equal(warning.options.modal, true);
    }
    check('cancelling either overwrite preserves unsaved code and the saved file');

    confirm = true;
    await vscode.commands.executeCommand('hoj-connecter.resetToTemplate');
    assert.equal(doc.getText(), '// server template\nconsole.log("template");\n'); assert.ok(doc.isDirty);
    assert.equal(Buffer.from(await vscode.workspace.fs.readFile(doc.uri)).toString(), disk);
    await vscode.commands.executeCommand('undo'); assert.equal(doc.getText(), dirty);
    problem.detail.codeTemplate = {};
    await app.files.resetToTemplate(problem); assert.equal(doc.getText(), starter('JavaScript'));
    await vscode.commands.executeCommand('undo'); assert.equal(doc.getText(), dirty);
    check('reset uses the current language template or starter and one undo restores unsaved work');

    const unrelated = await vscode.workspace.openTextDocument({ language: 'javascript', content: '// unrelated editor\n' });
    await vscode.window.showTextDocument(unrelated);
    mock.setAcceptedCode({ code: '// last AC\r\nconsole.log(3);\r\n', language: 'JavaScript' });
    await vscode.commands.executeCommand('hoj-connecter.fetchLastAcceptedCode');
    assert.equal(doc.getText(), '// last AC\nconsole.log(3);\n'); assert.ok(doc.isDirty);
    assert.equal(unrelated.getText(), '// unrelated editor\n');
    assert.equal(Buffer.from(await vscode.workspace.fs.readFile(doc.uri)).toString(), disk);
    assert.equal(app.store.binding(problem).language, 'JavaScript');
    await vscode.commands.executeCommand('undo'); assert.equal(doc.getText(), dirty);
    check('last AC replaces only the associated file, preserves disk contents and supports undo');

    const warningCount = warnings.length;
    mock.setAcceptedCode(null); await assert.rejects(app.files.fetchLastAcceptedCode(problem), /没有可获取/);
    mock.setAcceptedCode(null, 403); await assert.rejects(app.files.fetchLastAcceptedCode(problem), /没有访问权限/);
    mock.setAcceptedCode({ code: 'print(3)', language: 'Python3' }); await assert.rejects(app.files.fetchLastAcceptedCode(problem), /不兼容/);
    mock.setAcceptedCode({ code: '' }); await assert.rejects(app.files.fetchLastAcceptedCode(problem), /未返回有效/);
    assert.equal(doc.getText(), dirty); assert.equal(warnings.length, warningCount);
    check('missing AC, access failures, invalid responses and language mismatch leave current code intact');

    duringWarning = () => replace(dirty + '// typed during confirmation\n');
    await assert.rejects(app.files.resetToTemplate(problem), /代码已发生变化/);
    assert.equal(doc.getText(), dirty + '// typed during confirmation\n');
    duringWarning = async () => { app.current = { ...problem }; };
    await assert.rejects(app.files.resetToTemplate(problem), /题目或账号已切换/); app.current = problem;
    const python = vscode.Uri.joinPath(vscode.workspace.workspaceFolders![0].uri, 'Main.py');
    const pythonBefore = Buffer.from(await vscode.workspace.fs.readFile(python)).toString();
    duringWarning = async () => { await app.store.updateBinding(problem, { active: python.toString() }); };
    await assert.rejects(app.files.resetToTemplate(problem), /题目文件或代码已发生变化/);
    assert.equal(Buffer.from(await vscode.workspace.fs.readFile(python)).toString(), pythonBefore);
    assert.equal(doc.getText(), dirty + '// typed during confirmation\n');
    check('code edits, problem switches and file switches during confirmation cancel replacement');
  } finally {
    vscode.window.showWarningMessage = originalWarning;
    app.current = problem; problem.detail.codeTemplate = templates;
    await app.store.updateBinding(problem, binding); mock.setAcceptedCode({ code: 'console.log(3);\n', language: 'JavaScript' });
    await vscode.window.showTextDocument(doc); await replace(original); assert.equal(await doc.save(), true); app.refreshLocal();
  }
  await verifySidebarActions(app, check);
}

async function verifySidebarActions(app: App, check: (name: string) => void): Promise<void> {
  let hasFile = false, loggedIn = true, receive!: (message: unknown) => Promise<void>;
  const actions: string[] = [], errors: unknown[] = [];
  const webview = {
    html: '', cspSource: 'vscode-webview:', options: {}, asWebviewUri: (uri: vscode.Uri) => uri,
    onDidReceiveMessage: (handler: typeof receive) => { receive = handler; return new vscode.Disposable(() => {}); }
  };
  const context = { extensionUri: vscode.extensions.getExtension('edge-hh.hoj-connecter')!.extensionUri } as vscode.ExtensionContext;
  const docs = new Documents(context, async action => { actions.push(action); }, error => errors.push(error), () => ({ hasFile, loggedIn, assistants: [] }));
  docs.resolveWebviewView({ webview, onDidChangeVisibility: () => new vscode.Disposable(() => {}), onDidDispose: () => new vscode.Disposable(() => {}) } as unknown as vscode.WebviewView);
  const send = (action: string) => receive({ type: 'action', entryId: docs.active!.id, action });
  try {
    await docs.show('problem', '题面', '# Problem', 'problem', false);
    assert.ok(!webview.html.includes('data-action="hoj-connecter.resetToTemplate"'));
    assert.ok(!webview.html.includes('data-action="hoj-connecter.fetchLastAcceptedCode"'));
    await send('hoj-connecter.resetToTemplate'); await send('hoj-connecter.fetchLastAcceptedCode'); assert.deepEqual(actions, []);
    hasFile = true; docs.refresh();
    assert.ok(webview.html.includes('data-action="hoj-connecter.resetToTemplate"'));
    assert.ok(webview.html.includes('data-action="hoj-connecter.fetchLastAcceptedCode"'));
    await send('hoj-connecter.resetToTemplate'); await send('hoj-connecter.fetchLastAcceptedCode');
    assert.deepEqual(actions.splice(0), ['hoj-connecter.resetToTemplate', 'hoj-connecter.fetchLastAcceptedCode']);
    loggedIn = false; docs.refresh();
    assert.match(webview.html, /data-action="hoj-connecter.fetchLastAcceptedCode" disabled/);
    await send('hoj-connecter.fetchLastAcceptedCode'); assert.deepEqual(actions, []);
    // Keep the fake view hidden while activating the result entry.
    await docs.show('result', '结果', '# Result', 'result', false);
    await receive({ type: 'tab', entryId: docs.active!.id, kind: 'result' });
    await send('hoj-connecter.resetToTemplate'); assert.deepEqual(actions, []);
    assert.deepEqual(errors, []);
    check('sidebar renders replacement buttons only for associated problems and guards stale or logged-out actions');
  } finally { docs.dispose(); app.refreshLocal(); }
}
