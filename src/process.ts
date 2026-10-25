import { spawn, ChildProcess } from 'node:child_process';
import * as path from 'node:path';
import { RunnerProfile } from './domain';
import { languageFamily } from './language';

export interface CancelSignal { readonly isCancellationRequested: boolean; onCancellationRequested(listener: () => void): { dispose(): void } }
export interface ProcessResult { stdout: string; stderr: string; code: number | null; elapsed: number; timedOut: boolean; cancelled: boolean; outputExceeded: boolean }

function killTree(child: ChildProcess): void {
  if (!child.pid || child.exitCode !== null) { return; }
  if (process.platform === 'win32') {
    const killer = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    killer.on('error', () => child.kill());
  } else {
    try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
  }
}
/** `encoding` decodes the output of tools that print in the console code page (MSVC). */
export async function runProcess(command: string[], cwd: string, input: string, timeout: number, outputLimit: number, cancellation?: CancelSignal, env?: NodeJS.ProcessEnv, encoding = 'utf-8'): Promise<ProcessResult> {
  if (!command.length || !command[0]) { throw new Error('运行器缺少可执行程序。'); }
  if (cancellation?.isCancellationRequested) { return { stdout: '', stderr: '', code: null, elapsed: 0, timedOut: false, cancelled: true, outputExceeded: false }; }
  return new Promise((resolve, reject) => {
    const start = Date.now(); const stdout: Buffer[] = [], stderr: Buffer[] = [];
    let size = 0, timedOut = false, cancelled = false, outputExceeded = false;
    let child: ChildProcess;
    try { child = spawn(command[0], command.slice(1), { cwd, env, shell: false, windowsHide: true, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'] }); }
    catch (error) { reject(error); return; }
    const timer = setTimeout(() => { timedOut = true; killTree(child); }, timeout);
    const listener = cancellation?.onCancellationRequested(() => { cancelled = true; killTree(child); });
    const collect = (target: Buffer[]) => (chunk: Buffer) => {
      const remaining = Math.max(0, outputLimit - size); size += chunk.length;
      if (remaining) { target.push(chunk.subarray(0, remaining)); }
      if (size > outputLimit && !outputExceeded) { outputExceeded = true; killTree(child); }
    };
    child.stdout!.on('data', collect(stdout)); child.stderr!.on('data', collect(stderr));
    child.stdin!.on('error', () => { /* The program may close stdin before consuming all input. */ });
    child.on('error', error => { clearTimeout(timer); listener?.dispose(); reject(new Error(`无法启动 ${command[0]}：${error.message}。请使用“HOJ-Connecter: 选择 / 配置本地编译器”，或检查 hoj-connecter.runners。`)); });
    child.on('close', code => { clearTimeout(timer); listener?.dispose(); const decoder = new TextDecoder(encoding); resolve({ stdout: decoder.decode(Buffer.concat(stdout)), stderr: decoder.decode(Buffer.concat(stderr)), code, elapsed: Date.now() - start, timedOut, cancelled, outputExceeded }); });
    child.stdin!.end(input);
  });
}

export function defaultRunner(extension: string): RunnerProfile | undefined {
  const python = process.platform === 'win32' ? 'python' : 'python3';
  const profiles: Record<string, RunnerProfile> = {
    cpp: { compile: ['g++', '${file}', '-std=c++17', '-O2', '-o', '${output}'], run: ['${output}'] },
    cc: { compile: ['g++', '${file}', '-std=c++17', '-O2', '-o', '${output}'], run: ['${output}'] },
    cxx: { compile: ['g++', '${file}', '-std=c++17', '-O2', '-o', '${output}'], run: ['${output}'] },
    c: { compile: ['gcc', '${file}', '-std=c17', '-O2', '-o', '${output}'], run: ['${output}'] },
    py: { run: [python, '${file}'] },
    js: { run: ['node', '${file}'] },
    java: { compile: ['javac', '-encoding', 'UTF-8', '-d', '${buildDir}', '${file}'], run: ['java', '-cp', '${buildDir}', '${stem}'] },
    go: { compile: ['go', 'build', '-o', '${output}', '${file}'], run: ['${output}'] },
    rs: { compile: ['rustc', '${file}', '-O', '-o', '${output}'], run: ['${output}'] }
  }; return profiles[extension.toLowerCase()];
}
export function expandCommand(command: string[], file: string, buildDir: string): string[] {
  const values: Record<string, string> = { file, dir: path.dirname(file), output: path.join(buildDir, process.platform === 'win32' ? 'solution.exe' : 'solution'), buildDir, stem: path.parse(file).name };
  return command.map(arg => arg.replace(/\$\{(file|dir|output|buildDir|stem)\}/g, (_, key: string) => values[key]));
}
export function extensionForLanguage(language: string): string {
  const extensions: Record<string, string> = { cpp: 'cpp', c: 'c', python: 'py', javascript: 'js', typescript: 'ts', java: 'java', rust: 'rs', go: 'go', csharp: 'cs', ruby: 'rb', php: 'php', kotlin: 'kt', swift: 'swift', pascal: 'pas', haskell: 'hs' };
  return extensions[languageFamily(language) ?? ''] ?? 'txt';
}
export function starter(language: string): string {
  switch (extensionForLanguage(language)) {
    case 'cpp': return '#include <iostream>\n#include <vector>\n#include <algorithm>\nusing namespace std;\n\nint main() {\n    ios::sync_with_stdio(false);\n    cin.tie(nullptr);\n    \n    return 0;\n}\n';
    case 'c': return '#include <stdio.h>\n\nint main(void) {\n    \n    return 0;\n}\n';
    case 'py': return 'import sys\n\ndef solve():\n    data = sys.stdin.read().split()\n    \n\nif __name__ == "__main__":\n    solve()\n';
    case 'js': return "const fs = require('fs');\nconst input = fs.readFileSync(0, 'utf8').trim().split(/\\s+/);\n\n";
    case 'java': return 'import java.io.*;\nimport java.util.*;\n\npublic class Main {\n    public static void main(String[] args) throws Exception {\n        Scanner in = new Scanner(System.in);\n        \n    }\n}\n';
    case 'go': return 'package main\n\nimport (\n    "bufio"\n    "fmt"\n    "os"\n)\n\nfunc main() {\n    in := bufio.NewReader(os.Stdin)\n    out := bufio.NewWriter(os.Stdout)\n    defer out.Flush()\n    var n int\n    fmt.Fscan(in, &n)\n    fmt.Fprintln(out, n)\n}\n';
    case 'rs': return 'use std::io::{self, Read};\n\nfn main() {\n    let mut input = String::new();\n    io::stdin().read_to_string(&mut input).unwrap();\n    \n}\n';
    default: return '';
  }
}
