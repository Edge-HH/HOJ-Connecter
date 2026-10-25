import * as vscode from 'vscode';
import * as path from 'node:path';
import { RunnerProfile } from './domain';
import { Cancelled, requireTrust, workspaceFolder } from './files';
import { commandPaths, discoverToolchains, DiscoveryOptions, editorToolHints, inspectToolchain, runnerExtension, runnerLanguages, Toolchain } from './toolchains';

export function validRunner(value: unknown): value is RunnerProfile {
  const command = (v: unknown) => Array.isArray(v) && v.length > 0 && v.every(arg => typeof arg === 'string') && !!v[0].trim();
  if (!value || typeof value !== 'object') { return false; }
  const profile = value as RunnerProfile;
  return command(profile.run) && (profile.compile === undefined || command(profile.compile)) && (profile.msvc === undefined || (typeof profile.msvc === 'string' && !!profile.msvc.trim()));
}
export class Runners {
  /** Prefer the compiler the editor already builds and debugs this file with, then explicit settings. */
  private async options(uri: vscode.Uri, extension: string, cancellation?: vscode.CancellationToken, onlyIfNoneFound = false): Promise<DiscoveryOptions> {
    const family = runnerExtension(extension), hints: unknown[] = [], msvcHints: unknown[] = [];
    const folder = vscode.workspace.getWorkspaceFolder(uri)?.uri.fsPath;
    const editor = uri.scheme === 'file' ? await editorToolHints(uri.fsPath, family, folder) : { hints: [], msvc: false };
    hints.push(...editor.hints);
    const codeRunner = vscode.workspace.getConfiguration('code-runner', uri).get<Record<string, unknown>>('executorMap', {})[({ cpp: 'cpp', c: 'c', py: 'python', js: 'javascript', java: 'java', go: 'go', rs: 'rust' } as Record<string, string>)[family]];
    if (typeof codeRunner === 'string') { hints.push(...commandPaths(codeRunner, family)); }
    let preferMsvc = editor.msvc;
    if (['cpp', 'c'].includes(family)) {
      const runner = vscode.workspace.getConfiguration('C_Cpp_Runner', uri);
      hints.push(vscode.workspace.getConfiguration('C_Cpp', uri).get('default.compilerPath'), runner.get(family === 'cpp' ? 'cppCompilerPath' : 'cCompilerPath'));
      msvcHints.push(runner.get('msvcBatchPath')); preferMsvc ||= runner.get('useMsvc') === true;
    } else if (family === 'py') { hints.push(vscode.workspace.getConfiguration('python', uri).get('defaultInterpreterPath')); }
    const strings = (values: unknown[]) => values.filter((hint): hint is string => typeof hint === 'string' && !!hint).map(hint => folder ? hint.replace(/\$\{(?:workspaceFolder|workspaceRoot)\}/g, folder) : hint);
    return { hints: strings(hints), cancellation, msvc: { prefer: preferMsvc, hints: strings(msvcHints), onlyIfNoneFound } };
  }
  async resolve(uri: vscode.Uri, token?: vscode.CancellationToken): Promise<{ profile: RunnerProfile; description: string }> {
    requireTrust();
    const extension = path.extname(uri.fsPath).slice(1).toLowerCase();
    const configured = vscode.workspace.getConfiguration('hoj-connecter', uri).get<Record<string, unknown>>('runners', {})[extension];
    if (configured !== undefined) {
      if (!validRunner(configured)) { throw new Error(`.${extension} 的 hoj-connecter.runners 配置无效，请检查 compile / run 参数数组。`); }
      return { profile: configured, description: `自定义运行器：${configured.compile?.[0] ?? configured.run[0]}` };
    }
    const found = await discoverToolchains(extension, await this.options(uri, extension, token, true));
    if (token?.isCancellationRequested) { throw new Cancelled(); }
    if (!found.length) { throw new Error(`未找到可用的 .${extension} 本地编译器 / 解释器（已检查当前文件夹的 tasks.json / launch.json / c_cpp_properties.json、相关设置、PATH 与常见安装目录）。请执行“HOJ-Connecter: 选择 / 配置本地编译器”选择已安装的程序；也可配置 hoj-connecter.runners。`); }
    return { profile: found[0].profile, description: `自动选择：${found[0].executable}\n${found[0].version}` };
  }
  /** Save only the chosen extension; keep other custom runners and multi-root folders intact. */
  async save(uri: vscode.Uri, extension: string, profile: RunnerProfile): Promise<void> {
    requireTrust();
    if (!validRunner(profile)) { throw new Error('本地运行器配置无效。'); }
    const config = vscode.workspace.getConfiguration('hoj-connecter', uri);
    const target = vscode.workspace.workspaceFile && vscode.workspace.getWorkspaceFolder(uri) ? vscode.ConfigurationTarget.WorkspaceFolder : vscode.ConfigurationTarget.Workspace;
    const stored = config.inspect<Record<string, RunnerProfile>>('runners');
    const local = target === vscode.ConfigurationTarget.WorkspaceFolder ? stored?.workspaceFolderValue : stored?.workspaceValue;
    await config.update('runners', { ...local, [extension]: profile }, target);
  }
  async configure(resource?: vscode.Uri): Promise<void> {
    requireTrust();
    let uri = resource?.scheme === 'file' ? resource : vscode.window.activeTextEditor?.document.uri;
    let extension = uri?.scheme === 'file' ? path.extname(uri.fsPath).slice(1).toLowerCase() : '';
    if (!runnerLanguages.some(language => language.extension === runnerExtension(extension))) {
      const language = await vscode.window.showQuickPick(runnerLanguages.map(item => ({ ...item })), { title: '选择本地测试语言', placeHolder: '为哪种代码文件配置编译器 / 解释器？' });
      if (!language) { return; } extension = language.extension;
    }
    if (!uri || uri.scheme !== 'file' || !vscode.workspace.getWorkspaceFolder(uri)) { uri = (await workspaceFolder()).uri; }
    const resourceUri = uri, fileExtension = extension;
    const found = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: '检测本地编译器 / 解释器', cancellable: true }, async (_, token) => {
      const tools = await discoverToolchains(fileExtension, await this.options(resourceUri, fileExtension, token));
      if (token.isCancellationRequested) { throw new Cancelled(); } return tools;
    });
    const choices: (vscode.QuickPickItem & { tool?: Toolchain; browse?: boolean })[] = [
      ...found.map((tool, index) => ({ label: `${index === 0 ? '$(star-full) ' : ''}${path.basename(tool.executable)}${tool.profile.msvc ? ' (MSVC)' : ''}`, description: index === 0 ? '自动推荐' : undefined, detail: `${tool.executable} · ${tool.version}`, tool })),
      { label: '$(folder-opened) 浏览已安装的编译器 / 解释器…', detail: found.length ? '选择其他安装位置' : '常见目录与 PATH 中未找到可用程序', browse: true }
    ];
    const choice = await vscode.window.showQuickPick(choices, { title: `.${extension} · 选择本地编译器 / 解释器`, matchOnDetail: true, placeHolder: '选择后保存到当前工作区的 hoj-connecter.runners，供样例测试使用' });
    if (!choice) { return; }
    let tool = choice.tool;
    if (choice.browse) {
      const files = await vscode.window.showOpenDialog({ title: '选择可执行程序（C/C++ 使用 GCC 或 Clang）', canSelectFiles: true, canSelectFolders: false, canSelectMany: false, openLabel: '使用此程序', ...(process.platform === 'win32' ? { filters: { '可执行程序': ['exe'] } } : {}) });
      if (!files?.length) { return; }
      tool = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: '验证本地工具', cancellable: true }, async (_, token) => {
        const selected = await inspectToolchain(fileExtension, files[0].fsPath, await this.options(resourceUri, fileExtension, token));
        if (token.isCancellationRequested) { throw new Cancelled(); } return selected;
      });
      if (!tool) { throw new Error(`所选程序不能用于 .${extension} 本地测试。C/C++ 请选择 g++ / gcc 或 clang++ / clang（已安装的 Visual Studio MSVC 会自动出现在列表中）；Python 需为 3.x；Java 需选择同目录带 java 的 javac。其他工具链可配置 hoj-connecter.runners。`); }
    }
    if (!tool) { return; }
    await this.save(resourceUri, extension, tool.profile);
    void vscode.window.showInformationMessage(`已为 .${extension} 配置 ${tool.executable}。现在可以一键测试样例。`);
  }
}
