import * as vscode from 'vscode';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { compareOutput, OpenProblem, problemKey } from './domain';
import { Cancelled, exists, Files, requireTrust, within, workspaceFolder } from './files';
import { expandCommand, runProcess } from './process';
import { Runners } from './runners';
import { compilerOutputEncoding, prepareBuildDirectory, prepareRunnerEnvironment } from './toolchains';
import { Store } from './store';

interface Suite { problem: OpenProblem; root: vscode.TestItem }
export class Samples implements vscode.Disposable {
  readonly runners = new Runners();
  readonly controller = vscode.tests.createTestController('hoj-connecter.samples', 'HOJ-Connecter 本地样例');
  readonly lastOutcomes = new Map<string, { passed: number; failed: number; errored: number; skipped: number }>();
  readonly lastMessages = new Map<string, string[]>();
  readonly lastSources = new Map<string, { solutionUri: string; code: string }>();
  private readonly suites = new Map<string, Suite>();
  private readonly running = new Set<string>();
  constructor(private readonly context: vscode.ExtensionContext, private readonly store: Store, private readonly files: Files, private readonly changed: () => void) {
    this.controller.createRunProfile('运行样例', vscode.TestRunProfileKind.Run, (request, token) => this.run(request, token), true);
  }
  restore(problem: OpenProblem): void {
    const binding = this.store.binding(problem);
    if (!binding.sampleDir || !binding.sampleCount) { return; }
    const key = problemKey(problem.scope, problem.displayId);
    const root = this.controller.createTestItem(key, `${problem.displayId} · ${problem.detail.problem.title}`, binding.active ? vscode.Uri.parse(binding.active) : undefined);
    for (let i = 1; i <= binding.sampleCount; i++) { root.children.add(this.controller.createTestItem(`${key}:${i}`, `样例 ${i}`, vscode.Uri.joinPath(vscode.Uri.parse(binding.sampleDir), `${i}.in`))); }
    this.controller.items.add(root); this.suites.set(key, { problem, root });
  }
  async import(problem: OpenProblem, show = true): Promise<boolean> {
    requireTrust(); if (!problem.samples.length) { throw new Error('此题没有公开样例。'); }
    const binding = this.store.binding(problem);
    const folder = binding.sampleDir ? undefined : await workspaceFolder();
    const dir = binding.sampleDir ? vscode.Uri.parse(binding.sampleDir) : vscode.Uri.file(within(folder!.uri.fsPath, '.hoj-connecter', 'samples', problemKey(problem.scope, problem.displayId)));
    const entries = problem.samples.flatMap((sample, index) => [{ uri: vscode.Uri.joinPath(dir, `${index + 1}.in`), content: sample.input }, { uri: vscode.Uri.joinPath(dir, `${index + 1}.out`), content: sample.output }]);
    let modified = false;
    for (const entry of entries) {
      if (await exists(entry.uri) && Buffer.from(await vscode.workspace.fs.readFile(entry.uri)).toString('utf8') !== entry.content) { modified = true; break; }
    }
    if (modified && await vscode.window.showWarningMessage('本地样例已有修改，重新填入将覆盖这些样例文件。', { modal: true }, '覆盖样例') !== '覆盖样例') { return false; }
    await vscode.workspace.fs.createDirectory(dir);
    for (const entry of entries) { await vscode.workspace.fs.writeFile(entry.uri, Buffer.from(entry.content, 'utf8')); }
    await this.store.updateBinding(problem, { sampleDir: dir.toString(), sampleCount: problem.samples.length }); this.restore(problem); this.changed();
    if (show) {
      void vscode.window.showInformationMessage(`已填入 ${problem.samples.length} 组样例。`, '查看样例文件').then(action => {
        if (action) { return vscode.window.showTextDocument(vscode.Uri.joinPath(dir, '1.in'), { preview: false }); }
      });
    } return true;
  }
  async test(problem: OpenProblem): Promise<void> {
    requireTrust(); const binding = this.store.binding(problem);
    if (!binding.sampleDir || !binding.sampleCount) { if (!await this.import(problem, false)) { return; } }
    this.restore(problem);
    const suite = this.suites.get(problemKey(problem.scope, problem.displayId)); if (!suite) { return; }
    await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `${problem.displayId} · 本地样例`, cancellable: true }, async (_, token) => {
      await this.run(new vscode.TestRunRequest([suite.root]), token);
    });
  }
  private async run(request: vscode.TestRunRequest, token: vscode.CancellationToken): Promise<void> {
    requireTrust(); const run = this.controller.createTestRun(request);
    try {
      for (const [key, suite] of this.suites) {
        if (request.exclude?.some(item => item.id === key)) { continue; }
        const children: vscode.TestItem[] = []; suite.root.children.forEach(item => children.push(item));
        const selected = children.filter(item => !request.exclude?.some(x => x.id === item.id) && (!request.include || request.include.some(x => x.id === key || x.id === item.id)));
        if (!selected.length) { continue; }
        selected.forEach(item => run.enqueued(item));
        if (token.isCancellationRequested) { selected.forEach(item => run.skipped(item)); continue; }
        if (this.running.has(key)) { selected.forEach(item => run.errored(item, new vscode.TestMessage('此题已有样例测试正在运行。'))); continue; }
        this.running.add(key);
        const outcomes = { passed: 0, failed: 0, errored: 0, skipped: 0 }; this.lastOutcomes.set(key, outcomes);
        const messages: string[] = []; this.lastMessages.set(key, messages);
        this.lastSources.delete(key);
        let buildDir: string | undefined;
        try {
          const doc = await this.files.document(suite.problem);
          this.lastSources.set(key, { solutionUri: doc.uri.toString(), code: doc.getText() });
          const config = vscode.workspace.getConfiguration('hoj-connecter', doc.uri);
          const { profile, description } = await this.runners.resolve(doc.uri, token);
          messages.push(description); run.appendOutput(description.replace(/\n/g, '\r\n') + '\r\n');
          const env = await prepareRunnerEnvironment(profile);
          await fs.mkdir(this.context.storageUri?.fsPath ?? this.context.globalStorageUri.fsPath, { recursive: true });
          buildDir = await fs.mkdtemp(path.join(this.context.storageUri?.fsPath ?? this.context.globalStorageUri.fsPath, 'sample-'));
          await prepareBuildDirectory(profile, buildDir);
          const outputLimit = config.get('outputLimitKb', 1024) * 1024;
          if (profile.compile) {
            run.appendOutput(`编译：${path.basename(doc.uri.fsPath)}\r\n`);
            const result = await runProcess(expandCommand(profile.compile, doc.uri.fsPath, buildDir), path.dirname(doc.uri.fsPath), '', config.get('compileTimeoutMs', 30000), outputLimit, token, env, await compilerOutputEncoding(profile));
            if (result.cancelled) { selected.forEach(item => run.skipped(item)); outcomes.skipped += selected.length; continue; }
            if (result.code !== 0 || result.timedOut || result.outputExceeded) { throw new Error(`编译失败${result.timedOut ? '（超时）' : result.outputExceeded ? '（输出超限）' : ''}\n${result.stderr}\n${result.stdout}`); }
          }
          const binding = this.store.binding(suite.problem);
          for (const item of selected) {
            if (token.isCancellationRequested) { run.skipped(item); outcomes.skipped++; continue; }
            run.started(item);
            try {
              const index = item.id.split(':').pop()!;
              const dir = vscode.Uri.parse(binding.sampleDir!);
              const inputUri = vscode.Uri.joinPath(dir, `${index}.in`), expectedUri = vscode.Uri.joinPath(dir, `${index}.out`);
              // Read open editors as well as disk so edited sample files take effect immediately.
              const read = async (uri: vscode.Uri) => (await vscode.workspace.openTextDocument(uri)).getText();
              const input = await read(inputUri), expected = await read(expectedUri);
              let cwd = path.dirname(doc.uri.fsPath), outputFile: string | undefined;
              const p = suite.problem.detail.problem;
              if (p.isFileIO) {
                if (!p.ioReadFileName || !p.ioWriteFileName) { throw new Error('文件 IO 题目缺少输入 / 输出文件名。'); }
                cwd = path.join(buildDir, `case-${index}`); await fs.mkdir(cwd, { recursive: true });
                const inputFile = within(cwd, p.ioReadFileName); outputFile = within(cwd, p.ioWriteFileName);
                await fs.mkdir(path.dirname(inputFile), { recursive: true }); await fs.mkdir(path.dirname(outputFile), { recursive: true });
                await fs.writeFile(inputFile, input);
              }
              const result = await runProcess(expandCommand(profile.run, doc.uri.fsPath, buildDir), cwd, p.isFileIO ? '' : input, config.get('sampleTimeoutMs', 5000), outputLimit, token, env);
              run.appendOutput(`${item.label} · ${result.elapsed} ms\r\n${result.stderr.replace(/\n/g, '\r\n')}\r\n`, undefined, item);
              if (result.cancelled) { run.skipped(item); outcomes.skipped++; continue; }
              if (result.timedOut) { run.failed(item, new vscode.TestMessage('TLE · 本地运行超时'), result.elapsed); messages.push(`${item.label}: TLE · ${result.elapsed} ms`); outcomes.failed++; continue; }
              if (result.outputExceeded) { run.failed(item, new vscode.TestMessage('输出超过本地限制'), result.elapsed); messages.push(`${item.label}: 输出超过本地限制`); outcomes.failed++; continue; }
              if (result.code !== 0) { run.failed(item, new vscode.TestMessage(`RE · 退出码 ${result.code}\n${result.stderr}`), result.elapsed); messages.push(`${item.label}: RE · ${result.code}\n${result.stderr}`); outcomes.failed++; continue; }
              if (outputFile && (await fs.stat(outputFile)).size > outputLimit) { throw new Error('输出文件超过本地限制。'); }
              const actual = outputFile ? await fs.readFile(outputFile, 'utf8') : result.stdout;
              if (compareOutput(actual, expected, config.get('sampleComparison', 'trimEnd'))) { run.passed(item, result.elapsed); messages.push(`${item.label}: AC · ${result.elapsed} ms`); outcomes.passed++; }
              else { const message = vscode.TestMessage.diff('WA · 输出与样例不同', expected, actual); message.location = new vscode.Location(expectedUri, new vscode.Position(0, 0)); run.failed(item, message, result.elapsed); messages.push(`${item.label}: WA\n期望输出:\n${expected}\n实际输出:\n${actual}`); outcomes.failed++; }
            } catch (error) { const text = error instanceof Error ? error.message : String(error); run.errored(item, new vscode.TestMessage(text)); messages.push(`${item.label}: ${text}`); outcomes.errored++; }
          }
        } catch (error) {
          const message = error instanceof Cancelled ? '操作已取消' : error instanceof Error ? error.message : String(error);
          messages.push(message);
          selected.forEach(item => error instanceof Cancelled ? run.skipped(item) : run.errored(item, new vscode.TestMessage(message)));
          if (error instanceof Cancelled) { outcomes.skipped += selected.length; } else { outcomes.errored += selected.length; }
        } finally {
          this.running.delete(key);
          // Only remove the exact directory created by mkdtemp under extension storage.
          if (buildDir) { await fs.rm(buildDir, { recursive: true, force: true }).catch(() => undefined); }
        }
      }
    } finally { run.end(); }
  }
  dispose(): void { this.controller.dispose(); }
}
