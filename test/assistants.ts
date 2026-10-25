import * as vscode from 'vscode';
import assert from 'node:assert/strict';
import { App } from '../src/extension';
import { assistants, installedAssistants } from '../src/assistants';
import { DetailAttachment, Documents } from '../src/documents';

interface FixtureCall { uri: string; content: string; selectionEmpty: boolean }

export async function verifyAssistants(app: App, check: (name: string) => void): Promise<void> {
  const installed = installedAssistants();
  assert.deepEqual(installed.map(a => a.id), process.env.HOJ_CONNECTER_TEST_ASSISTANTS === '1' ? ['codex', 'claude'] : []);
  const activeResult = app.docs.active!;
  assert.ok(activeResult.attachment?.submission, 'partial result has an attachment');
  assert.equal(activeResult.attachment.problem?.displayId, 'P1000');

  // Exercise the real Webview message handler and HTML without a second visible view.
  let receive!: (message: unknown) => Promise<void>;
  const actions: string[] = [], errors: unknown[] = [];
  let visibleAssistants = [...assistants];
  const webview = {
    html: '', cspSource: 'vscode-webview:', options: {}, asWebviewUri: (uri: vscode.Uri) => uri,
    onDidReceiveMessage: (handler: typeof receive) => { receive = handler; return new vscode.Disposable(() => {}); }
  };
  const extension = vscode.extensions.getExtension('edge-hh.hoj-connecter')!;
  const docs = new Documents({ extensionUri: extension.extensionUri } as vscode.ExtensionContext,
    async command => { actions.push(command); }, error => { errors.push(error); },
    () => ({ hasFile: true, loggedIn: true, assistants: visibleAssistants }));
  docs.resolveWebviewView({ webview, onDidChangeVisibility: () => new vscode.Disposable(() => {}), onDidDispose: () => new vscode.Disposable(() => {}) } as unknown as vscode.WebviewView);
  const attachment = activeResult.attachment;
  await docs.show('statement', '题面', '# A + B', 'problem', false, attachment);
  for (const assistant of assistants) { assert.ok(webview.html.includes(`附加到 ${assistant.name}</button>`)); }
  visibleAssistants = [assistants[0]]; docs.refresh(true);
  assert.ok(webview.html.includes('附加到 Codex</button>')); assert.ok(!webview.html.includes('附加到 Claude</button>'));
  visibleAssistants = []; docs.refresh(true); assert.ok(!webview.html.includes('附加到 Codex</button>'));
  visibleAssistants = [...assistants];
  for (const content of ['AC · 通过', '正在等待评测…']) {
    await docs.show('no-help', '结果', content, 'result', false);
    // Switch by the same message channel used in the sidebar.
    await receive({ type: 'tab', kind: 'result', entryId: docs.active!.id });
    assert.ok(!webview.html.includes('附加到 Codex</button>'));
    await receive({ type: 'action', action: 'hoj-connecter.attachToCodex', entryId: 'no-help' });
    assert.deepEqual(actions, []);
  }
  await docs.show('failed', '结果', 'WA · 答案错误', 'result', false, attachment);
  await receive({ type: 'tab', kind: 'result', entryId: docs.active!.id });
  assert.ok(webview.html.includes('附加到 Claude</button>'));
  await receive({ type: 'action', action: 'hoj-connecter.attachToCodex', entryId: 'outdated' });
  await receive({ type: 'action', action: 'workbench.action.quit', entryId: 'failed' });
  assert.deepEqual(actions, []);
  await receive({ type: 'action', action: 'hoj-connecter.attachToCodex', entryId: 'failed' });
  assert.deepEqual(actions, ['hoj-connecter.attachToCodex']); assert.deepEqual(errors, []);
  docs.dispose(); check('assistant buttons follow installed extensions and attachable pages; stale and unknown Webview actions are ignored');

  if (!installed.length) { return; }
  const fixtures = await Promise.all(installed.map(async a => {
    const extension = vscode.extensions.getExtension<{ calls: FixtureCall[] }>(a.extensionId)!;
    return { assistant: a, api: await extension.activate() };
  }));
  const problem = app.current!, solutionUri = app.store.binding(problem).active!;
  const solution = await vscode.workspace.openTextDocument(vscode.Uri.parse(solutionUri));
  const edit = new vscode.WorkspaceEdit(); edit.insert(solution.uri, new vscode.Position(0, 0), '// unsaved assistant context\n');
  assert.equal(await vscode.workspace.applyEdit(edit), true); assert.equal(solution.isDirty, true);
  await vscode.commands.executeCommand('hoj-connecter.showProblem');
  for (const { assistant, api } of fixtures) {
    await vscode.commands.executeCommand(`hoj-connecter.attachTo${assistant.name}`);
    const call = api.calls.at(-1)!; assert.ok(call, 'fixture received a command');
    assert.ok(call.content.includes('计算两个整数之和。')); assert.ok(call.content.includes('100 -20'));
    assert.ok(call.content.includes('// unsaved assistant context')); assert.ok(call.content.includes('解题思路'));
    assert.ok(call.content.includes(solution.uri.fsPath));
    assert.equal(vscode.Uri.parse(call.uri).scheme, 'file');
    assert.ok(vscode.workspace.getWorkspaceFolder(vscode.Uri.parse(call.uri)));
    if (assistant.id === 'claude') { assert.equal(call.selectionEmpty, true); }
  }
  check('both extension commands receive a readable statement attachment including samples and unsaved bound code');

  const context: DetailAttachment = { ...attachment!, submission: { submitId: 99, status: -2, errorMessage: 'error: missing semicolon', code: 'submitted_broken_code();' }, solutionUri };
  await app.docs.show('failed-with-error', '编译错误', 'CE · 编译错误', 'result', true, context);
  for (const { assistant, api } of fixtures) {
    const previous = api.calls.at(-1)!;
    await vscode.commands.executeCommand(`hoj-connecter.attachTo${assistant.name}`);
    const call = api.calls.at(-1)!;
    assert.ok(call.content.includes('missing semicolon')); assert.ok(call.content.includes('submitted_broken_code();'));
    assert.ok(call.content.includes('计算两个整数之和。')); assert.ok(!call.content.includes('// unsaved assistant context'));
    assert.notEqual(call.uri, previous.uri);
    assert.equal(Buffer.from(await vscode.workspace.fs.readFile(vscode.Uri.parse(previous.uri))).toString(), previous.content);
  }
  check('error attachments preserve submitted code and complete statement; later attachments keep earlier snapshots intact');

  await app.docs.show('partial-again', activeResult.title, activeResult.content, 'result', true, activeResult.attachment);
  for (const { assistant, api } of fixtures) {
    await vscode.commands.executeCommand(`hoj-connecter.attachTo${assistant.name}`);
    const content = api.calls.at(-1)!.content;
    assert.ok(content.includes('wrong answer: expected 42, found 41'));
    assert.ok(content.includes('测试点详情')); assert.ok(content.includes('| #3 | WA'));
    assert.ok(!content.includes('The error message does not support viewing'));
  }
  check('assistant attachments include per-case diagnostics from the final remote submission');
}
