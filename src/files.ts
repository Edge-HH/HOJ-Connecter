import * as vscode from 'vscode';
import * as path from 'node:path';
import { Binding, OpenProblem, safeSegment, sameScope } from './domain';
import { extensionForLanguage, starter } from './process';
import { Store } from './store';
import { codeFamily, languageFamily, LanguageSuggestion, suggestLanguage } from './language';

export function requireTrust(): void { if (!vscode.workspace.isTrusted) { throw new Error('请先信任此工作区，再创建、提交或运行代码。'); } }
export async function workspaceFolder(): Promise<vscode.WorkspaceFolder> {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders?.length) { throw new Error('请先在 VS Code 中打开一个本地文件夹，用于存放题目代码和样例。'); }
  if (folders.length === 1) { return folders[0]; }
  const folder = await vscode.window.showWorkspaceFolderPick({ placeHolder: '选择题目文件与样例所在的工作区' });
  if (!folder) { throw new Cancelled(); } return folder;
}
export class Cancelled extends Error {}
export function within(root: string, ...segments: string[]): string {
  const absolute = path.resolve(root, ...segments), relative = path.relative(root, absolute);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) { throw new Error('文件路径必须位于所选工作区目录内。'); }
  return absolute;
}
export async function exists(uri: vscode.Uri): Promise<boolean> {
  try { await vscode.workspace.fs.stat(uri); return true; }
  catch (error) { if (error instanceof vscode.FileSystemError && error.code === 'FileNotFound') { return false; } throw error; }
}
export class Files {
  constructor(private readonly store: Store, private readonly changed: () => void, private readonly current?: () => OpenProblem | undefined) {}
  private async associate(problem: OpenProblem, uri: vscode.Uri): Promise<void> {
    const previous = this.store.binding(problem);
    await this.store.bindFile(problem, uri);
    const family = codeFamily({ fileName: uri.fsPath });
    if (!previous.language || previous.languageMode === 'auto' || (family && family !== languageFamily(previous.language))) {
      const suggestion = this.suggestion(problem);
      await this.store.updateBinding(problem, { language: suggestion?.compatible ? suggestion.language : undefined, languageMode: 'auto' });
    }
  }
  private hint(problem: OpenProblem) {
    const active = this.store.binding(problem).active;
    const doc = active ? vscode.workspace.textDocuments.find(d => d.uri.toString() === active) : vscode.window.activeTextEditor?.document;
    return active ? { fileName: vscode.Uri.parse(active).fsPath, languageId: doc?.languageId, source: doc?.getText() } : doc?.uri.scheme === 'file' ? { fileName: doc.uri.fsPath, languageId: doc.languageId, source: doc.getText() } : undefined;
  }
  suggestion(problem: OpenProblem): LanguageSuggestion | undefined { return suggestLanguage(problem.detail.languages, vscode.workspace.getConfiguration('hoj-connecter').get('defaultLanguage', 'C++'), this.hint(problem)); }
  async language(problem: OpenProblem, force = false): Promise<string> {
    const binding = this.store.binding(problem), available = problem.detail.languages;
    if (!available.length) { throw new Error('此题当前没有可用的提交语言。'); }
    const family = codeFamily(this.hint(problem)), suggestion = this.suggestion(problem);
    if (!force && binding.language && binding.languageMode !== 'auto' && available.includes(binding.language) && (!family || languageFamily(binding.language) === family)) { return binding.language; }
    if (!force && suggestion?.compatible) { await this.store.updateBinding(problem, { language: suggestion.language, languageMode: 'auto' }); this.changed(); return suggestion.language; }
    if (!force && family && !suggestion) { throw new Error(`当前代码文件的语言不在此题允许的语言中（${available.join(' / ')}），请切换代码文件。`); }
    const sorted = [...available].sort((a, b) => Number(b === suggestion?.language) - Number(a === suggestion?.language));
    const chosen = await vscode.window.showQuickPick([
      ...(suggestion?.compatible ? [{ label: `$(sparkle) 自动推荐：${suggestion.language}`, description: suggestion.reason, language: suggestion.language, auto: true }] : []),
      ...sorted.map(label => ({ label, description: label === suggestion?.language ? suggestion.reason : undefined, language: label, auto: false }))
    ], { title: `${problem.displayId} · 提交语言`, placeHolder: '自动匹配代码文件；手动选择会记住当前题目的设置' });
    if (!chosen) { throw new Cancelled(); }
    await this.store.updateBinding(problem, { language: chosen.language, languageMode: chosen.auto ? 'auto' : 'manual' }); this.changed(); return chosen.language;
  }
  async create(problem: OpenProblem): Promise<void> {
    requireTrust(); const folder = await workspaceFolder(), language = await this.language(problem);
    const site = this.store.sites.find(s => s.id === problem.scope.siteId)!;
    const directory = vscode.workspace.getConfiguration('hoj-connecter', folder.uri).get('solutionDirectory', '.hoj-connecter/solutions');
    const ext = extensionForLanguage(language);
    const base = within(folder.uri.fsPath, directory, `${safeSegment(site.name)}-${safeSegment(site.id).slice(0, 8)}`, problem.scope.groupId ? `group-${problem.scope.groupId}` : 'public', problem.scope.contestId ? `contest-${problem.scope.contestId}` : 'practice', safeSegment(problem.displayId));
    const uri = await vscode.window.showSaveDialog({ title: `新建 ${problem.displayId} 的题目文件`, defaultUri: vscode.Uri.file(path.join(base, `Main.${ext}`)), saveLabel: '新建并关联' });
    if (!uri) { return; }
    if (uri.scheme !== 'file') { throw new Error('请选择本地文件。'); }
    if (await exists(uri)) {
      const action = await vscode.window.showWarningMessage('文件已存在。是否直接关联并打开？', { modal: true }, '关联已有文件');
      if (action !== '关联已有文件') { return; }
    } else {
      await vscode.workspace.fs.createDirectory(vscode.Uri.file(path.dirname(uri.fsPath)));
      const edit = new vscode.WorkspaceEdit();
      edit.createFile(uri, { overwrite: false });
      edit.insert(uri, new vscode.Position(0, 0), (problem.detail.codeTemplate?.[language] ?? starter(language)).replace(/\r\n?/g, '\n'));
      if (!await vscode.workspace.applyEdit(edit)) { throw new Error('无法创建题目文件。'); }
    }
    await this.associate(problem, uri); await vscode.window.showTextDocument(uri, { preview: false }); this.changed();
  }
  async bindActive(problem: OpenProblem): Promise<void> {
    requireTrust(); const doc = vscode.window.activeTextEditor?.document;
    if (!doc || doc.uri.scheme !== 'file' || doc.isUntitled) { throw new Error('请先打开并保存要关联的本地代码文件。'); }
    await this.associate(problem, doc.uri); this.changed();
    vscode.window.showInformationMessage(`${problem.displayId} 已关联 ${path.basename(doc.uri.fsPath)}`);
  }
  async switch(problem: OpenProblem): Promise<void> {
    requireTrust(); const binding = this.store.binding(problem);
    const picked = await vscode.window.showQuickPick([
      ...binding.files.map(file => ({ label: path.basename(vscode.Uri.parse(file).fsPath), description: vscode.Uri.parse(file).fsPath, file })),
      { label: '$(folder-opened) 选择其他文件…', description: '', file: '' }
    ], { title: `切换 ${problem.displayId} 的题目文件`, matchOnDescription: true });
    if (!picked) { return; }
    let uri: vscode.Uri | undefined = picked.file ? vscode.Uri.parse(picked.file) : undefined;
    if (!uri) { uri = (await vscode.window.showOpenDialog({ canSelectMany: false, openLabel: '关联为题目文件', canSelectFiles: true, canSelectFolders: false }))?.[0]; }
    if (uri) { if (uri.scheme !== 'file') { throw new Error('请选择本地代码文件。'); } await this.associate(problem, uri); await vscode.window.showTextDocument(uri, { preview: false }); this.changed(); }
  }
  private checkReplacement(problem: OpenProblem, doc?: vscode.TextDocument, version?: number): string {
    requireTrust();
    if (!sameScope(problem.scope, this.store.scope) || (this.current && this.current() !== problem)) { throw new Error('当前题目或账号已切换，请重新操作。'); }
    const active = this.store.binding(problem).active;
    if (!active) { throw new Error('请先新建或关联题目文件，再获取通过代码或重置模板。'); }
    if (vscode.Uri.parse(active).scheme !== 'file') { throw new Error('题目文件必须是本地文件。'); }
    if (doc && (doc.isClosed || doc.uri.toString() !== active || doc.version !== version)) { throw new Error('题目文件或代码已发生变化，操作已取消，请重新操作。'); }
    return active;
  }
  private async replaceCode(problem: OpenProblem, doc: vscode.TextDocument, version: number, code: string, action: string, language?: string): Promise<void> {
    this.checkReplacement(problem, doc, version);
    const confirmed = await vscode.window.showWarningMessage(`${problem.displayId} · ${action}会覆盖题目文件“${path.basename(doc.uri.fsPath)}”中的当前代码（包括未保存的修改）。可在编辑器中撤销。`, { modal: true, detail: doc.uri.fsPath }, '覆盖当前代码');
    if (confirmed !== '覆盖当前代码') { return; }
    this.checkReplacement(problem, doc, version);
    const editor = await vscode.window.showTextDocument(doc, { preview: false });
    this.checkReplacement(problem, doc, version);
    const range = new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length));
    if (!await editor.edit(edit => edit.replace(range, code.replace(/\r\n?/g, '\n')), { undoStopBefore: true, undoStopAfter: true })) { throw new Error('无法更新题目文件，操作已取消。'); }
    if (language) { await this.store.updateBinding(problem, { language, languageMode: 'manual' }); }
    this.changed();
    void vscode.window.showInformationMessage(`${problem.displayId} · 已${action}，请检查并保存代码。`);
  }
  async resetToTemplate(problem: OpenProblem): Promise<void> {
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.parse(this.checkReplacement(problem))), version = doc.version;
    const language = await this.language(problem);
    const code = problem.detail.codeTemplate?.[language] ?? starter(language);
    if (!code.trim()) { throw new Error(`此题没有可用的 ${language} 模板，当前文件未修改。`); }
    await this.replaceCode(problem, doc, version, code, '重置为模板');
  }
  async fetchLastAcceptedCode(problem: OpenProblem): Promise<void> {
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.parse(this.checkReplacement(problem))), version = doc.version;
    const client = this.store.client(problem.scope);
    const accepted = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `${problem.displayId} · 获取最后一次通过的代码` }, () => client.lastAcceptedCode(problem));
    const family = codeFamily({ fileName: doc.uri.fsPath, languageId: doc.languageId });
    if (accepted.language && (!problem.detail.languages.includes(accepted.language) || (family && family !== languageFamily(accepted.language)))) {
      throw new Error(`最后一次通过的代码使用 ${accepted.language}，与当前文件或题目允许的语言不兼容。请新建或关联对应语言的题目文件后重试。`);
    }
    await this.replaceCode(problem, doc, version, accepted.code, '获取最后一次通过的代码', accepted.language);
  }
  async document(problem: OpenProblem): Promise<vscode.TextDocument> {
    requireTrust(); let binding = this.store.binding(problem);
    if (!binding.active) {
      const action = await vscode.window.showQuickPick(['使用当前打开的文件', '新建题目文件', '选择已有文件'], { title: `${problem.displayId} 尚未关联代码文件` });
      if (action === '使用当前打开的文件') { await this.bindActive(problem); }
      else if (action === '新建题目文件') { await this.create(problem); }
      else if (action === '选择已有文件') { await this.switch(problem); }
      else { throw new Cancelled(); }
      binding = this.store.binding(problem);
    }
    if (!binding.active) { throw new Cancelled(); }
    const uri = vscode.Uri.parse(binding.active);
    if (uri.scheme !== 'file') { throw new Error('题目文件必须是本地文件。'); }
    const doc = await vscode.workspace.openTextDocument(uri);
    if (!await doc.save()) { throw new Error('保存代码文件失败，操作已取消。'); } return doc;
  }
  async open(problem: OpenProblem): Promise<void> {
    const binding: Binding = this.store.binding(problem);
    if (binding.active) { await vscode.window.showTextDocument(vscode.Uri.parse(binding.active), { preview: false }); }
    else { await this.create(problem); }
  }
}
