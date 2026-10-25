import * as vscode from 'vscode';
import { randomUUID } from 'node:crypto';
import { fence } from './documents';
import { requireTrust, workspaceFolder } from './files';

export type AssistantId = 'codex' | 'claude' | 'copilot';
export interface Assistant { id: AssistantId; name: string; extensionId: string; command: string }
export const assistants: readonly Assistant[] = [
  { id: 'codex', name: 'Codex', extensionId: 'openai.chatgpt', command: 'chatgpt.addFileToThread' },
  { id: 'claude', name: 'Claude', extensionId: 'Anthropic.claude-code', command: 'claude-vscode.insertAtMention' },
  { id: 'copilot', name: 'Copilot', extensionId: 'GitHub.copilot-chat', command: 'workbench.action.chat.open' }
];
export function installedAssistants(): readonly Assistant[] {
  return assistants.filter(a => vscode.extensions.getExtension(a.extensionId));
}
export interface AssistantRequest { statement?: string; result?: string; solutionUri?: string; code?: string; language?: string }
export function assistantMarkdown(request: AssistantRequest): string {
  return [
    '# HOJ-Connecter 求助上下文',
    request.result
      ? '请用中文帮我分析这次未通过的评测或本地样例：定位错误原因，结合题面检查算法、边界条件和复杂度；有代码时请给出修复并解释修改后的解题思路，补充能复现问题的测试用例。'
      : '请用中文帮我理解下面的题目，讲解解题思路、算法选择、边界条件和时间 / 空间复杂度；如果附有代码，请检查并帮助改错，给出验证方法。',
    request.solutionUri ? `代码文件：${vscode.Uri.parse(request.solutionUri).fsPath}${request.result ? '（当前文件可能已修改，请以本次附带的代码为准）' : ''}` : '',
    request.result ? `## 评测 / 错误信息\n\n${request.result}` : '',
    request.code !== undefined ? `## ${request.result ? '本次评测 / 测试代码' : '当前代码（含未保存修改）'}\n\n${fence(request.code, request.language)}` : '',
    request.statement ? `## 完整题面\n\n${request.statement}` : ''
  ].filter(Boolean).join('\n\n');
}

// These extensions expose file-context commands rather than a shared text API.
// Keep each attachment immutable: a later click must not change a previous chat's context.
export async function attachToAssistant(id: AssistantId, request: AssistantRequest): Promise<vscode.Uri> {
  requireTrust();
  const assistant = assistants.find(a => a.id === id)!;
  const extension = vscode.extensions.getExtension(assistant.extensionId);
  if (!extension) { throw new Error(`请先安装并启用 ${assistant.name} 扩展。`); }
  await extension.activate();
  if (!(await vscode.commands.getCommands(true)).includes(assistant.command)) {
    throw new Error(`${assistant.name} 扩展未提供附加文件命令，请更新扩展并重新加载窗口。`);
  }
  const source = request.solutionUri ? vscode.Uri.parse(request.solutionUri) : undefined;
  const folder = (source && vscode.workspace.getWorkspaceFolder(source)) ?? await workspaceFolder();
  const directory = vscode.Uri.joinPath(folder.uri, '.hoj-connecter', 'ai-context');
  const uri = vscode.Uri.joinPath(directory, `${request.result ? 'result' : 'problem'}-${randomUUID()}.md`);
  if (id === 'claude' && /[#"]/.test(vscode.workspace.asRelativePath(uri))) {
    throw new Error('Claude 无法附加路径含 # 或双引号的文件，请使用不含这些字符的工作区路径。');
  }
  await vscode.workspace.fs.createDirectory(directory);
  await vscode.workspace.fs.writeFile(uri, Buffer.from(assistantMarkdown(request), 'utf8'));
  try {
    if (id === 'codex') {
      await vscode.commands.executeCommand(assistant.command, uri);
    } else if (id === 'copilot') {
      await vscode.commands.executeCommand(assistant.command, { query: '', isPartialQuery: true, attachFiles: [uri] });
    } else {
      // Claude's command reads the active editor; it ignores URI/text arguments.
      const document = await vscode.workspace.openTextDocument(uri);
      const editor = await vscode.window.showTextDocument(document, { preview: false });
      editor.selection = new vscode.Selection(0, 0, 0, 0);
      await vscode.commands.executeCommand(assistant.command);
    }
  } catch (error) {
    throw new Error(`附加到 ${assistant.name} 失败；上下文已保存在 ${uri.fsPath}，可手动附加。${error instanceof Error ? error.message : String(error)}`);
  }
  void vscode.window.showInformationMessage(`已将${request.result ? '错误信息和相关上下文' : '题面和相关上下文'}附加到 ${assistant.name} 输入区，请确认后发送。`);
  return uri;
}
