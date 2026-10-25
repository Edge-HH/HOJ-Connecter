import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { constants } from 'node:fs';
import { execFile } from 'node:child_process';
import { RunnerProfile } from './domain';
import { CancelSignal, defaultRunner, runProcess } from './process';

export interface Toolchain { executable: string; version: string; profile: RunnerProfile }
export interface DiscoveryOptions {
  env?: NodeJS.ProcessEnv;
  hints?: string[];
  /** Additional known installation directories; PATH is always searched first. */
  directories?: string[];
  cancellation?: CancelSignal;
  probe?: typeof runProcess;
  /** Windows only: also offer MSVC (cl.exe) via vswhere / vcvarsall. */
  msvc?: { prefer?: boolean; hints?: string[]; onlyIfNoneFound?: boolean };
}
export const runnerLanguages = [
  { extension: 'cpp', label: 'C++ (.cpp / .cc / .cxx)' }, { extension: 'c', label: 'C (.c)' },
  { extension: 'py', label: 'Python 3 (.py)' }, { extension: 'js', label: 'JavaScript (.js)' },
  { extension: 'java', label: 'Java (.java)' }, { extension: 'go', label: 'Go (.go)' }, { extension: 'rs', label: 'Rust (.rs)' }
];
export function runnerExtension(extension: string): string { return ['cc', 'cxx'].includes(extension) ? 'cpp' : extension; }

export function compilerHint(extension: string, file: string): string {
  extension = runnerExtension(extension);
  // A debugger path (launch.json miDebuggerPath) points at the compiler installed beside it.
  if (extension === 'cpp') { return file.replace(/(?:gcc|clang|gdb|lldb)(-\d+(?:\.\d+)*)?(\.exe)?$/i, (match, version: string, exe: string) => `${/^g(?:cc|db)/i.test(match) ? 'g++' : 'clang++'}${version ?? ''}${exe ?? ''}`); }
  if (extension === 'c') { return file.replace(/(?:g\+\+|clang\+\+|gdb|lldb)(-\d+(?:\.\d+)*)?(\.exe)?$/i, (match, version: string, exe: string) => `${/^g(?:\+\+|db)/i.test(match) ? 'gcc' : 'clang'}${version ?? ''}${exe ?? ''}`); }
  return file;
}

function envValue(env: NodeJS.ProcessEnv, name: string): string | undefined {
  return env[Object.keys(env).find(key => key.toUpperCase() === name.toUpperCase()) ?? name];
}
function expandPath(value: string, env: NodeJS.ProcessEnv): string {
  return value.replace(/^"(.*)"$/, '$1').replace(/^~(?=[/\\]|$)/, os.homedir())
    .replace(/%([^%]+)%|\$\{env:([^}]+)\}/g, (match, a: string, b: string) => envValue(env, a ?? b) ?? match);
}
async function childBins(root: string, pattern: RegExp, bin = true): Promise<string[]> {
  try { return (await fs.readdir(root, { withFileTypes: true })).filter(entry => entry.isDirectory() && pattern.test(entry.name)).sort((a, b) => b.name.localeCompare(a.name, undefined, { numeric: true })).map(entry => path.join(root, entry.name, ...(bin ? ['bin'] : []))); }
  catch { return []; }
}

/** Bounded searches of conventional install locations, never a recursive disk scan. */
export async function installationDirectories(env: NodeJS.ProcessEnv = process.env): Promise<string[]> {
  const home = envValue(env, 'USERPROFILE') ?? envValue(env, 'HOME') ?? os.homedir();
  const dirs = [path.join(home, '.cargo', 'bin'), path.join(home, 'go', 'bin'), path.join(home, '.local', 'bin')];
  for (const name of ['JAVA_HOME', 'JDK_HOME', 'GCC_HOME', 'MINGW_HOME', 'LLVM_HOME', 'GOROOT', 'CARGO_HOME']) {
    const root = envValue(env, name); if (root) { dirs.push(path.join(expandPath(root, env), 'bin')); }
  }
  const pythonHome = envValue(env, 'PYTHON_HOME'); if (pythonHome) { dirs.push(expandPath(pythonHome, env)); }
  if (process.platform === 'win32') {
    const drive = envValue(env, 'SystemDrive') ?? 'C:';
    const programs = envValue(env, 'ProgramFiles') ?? `${drive}\\Program Files`;
    const local = envValue(env, 'LOCALAPPDATA') ?? path.join(home, 'AppData', 'Local');
    const msys = envValue(env, 'MSYS2_ROOT') ?? path.join(drive + '\\', 'msys64');
    dirs.push(...['ucrt64', 'mingw64', 'clang64', 'mingw32'].map(flavor => path.join(msys, flavor, 'bin')),
      ...['MinGW', 'mingw64', 'TDM-GCC-64'].map(name => path.join(drive + '\\', name, 'bin')),
      path.join(programs, 'LLVM', 'bin'), path.join(programs, 'nodejs'), path.join(programs, 'Go', 'bin'),
      ...['gcc', 'llvm', 'mingw', 'nodejs', 'nodejs-lts', 'openjdk'].map(name => path.join(home, 'scoop', 'apps', name, 'current', 'bin')),
      path.join(home, 'scoop', 'apps', 'python', 'current'), path.join(local, 'Programs', 'nodejs'));
    const nested = await Promise.all([
      childBins(path.join(local, 'Programs', 'Python'), /^Python\d+/i, false),
      childBins(path.join(drive + '\\'), /^Python\d+/i, false), childBins(path.join(local, 'Programs'), /^(jdk|java)-/i),
      ...['Java', 'Eclipse Adoptium', 'Microsoft', 'Amazon Corretto', 'Zulu'].map(name => childBins(path.join(programs, name), /^(jdk|jre|java|zulu|amazon-corretto)/i)),
      childBins(path.join(home, '.jdks'), /./)
    ]); dirs.push(...nested.flat());
  } else {
    dirs.push('/usr/local/bin', '/usr/bin', '/opt/homebrew/bin', '/opt/local/bin', '/usr/local/go/bin');
    if (process.platform === 'darwin') {
      dirs.push(...await childBins('/Library/Java/JavaVirtualMachines', /./, false).then(roots => roots.map(root => path.join(root, 'Contents', 'Home', 'bin'))));
    } else { dirs.push(...await childBins('/usr/lib/jvm', /./)); }
  }
  return dirs;
}

/** Include native runtime DLLs from a selected toolchain even when it is absent from PATH. */
export function runnerEnvironment(profile: RunnerProfile, env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const result = { ...env }, key = Object.keys(result).find(name => name.toUpperCase() === 'PATH') ?? 'PATH';
  const dirs = [profile.compile?.[0], profile.run[0]].filter((file): file is string => !!file && path.isAbsolute(file)).map(file => path.dirname(file));
  result[key] = [...new Set(dirs), result[key] ?? ''].filter(Boolean).join(path.delimiter);
  return result;
}
function toolNames(extension: string): string[] {
  return ({ cpp: ['g++', 'clang++'], c: ['gcc', 'clang'], py: process.platform === 'win32' ? ['python', 'python3', 'py', 'pypy3'] : ['python3', 'python', 'pypy3'], js: ['node'], java: ['javac'], go: ['go'], rs: ['rustc'] } as Record<string, string[]>)[runnerExtension(extension)] ?? [];
}
function isToolName(file: string, extension: string): boolean {
  const stem = file.replace(/\.exe$/i, '');
  return toolNames(extension).some(name => stem === name || (['cpp', 'c'].includes(runnerExtension(extension)) && stem.startsWith(name + '-') && /^\d+(\.\d+)*$/.test(stem.slice(name.length + 1))));
}
async function executable(file: string): Promise<boolean> {
  try { if (!(await fs.stat(file)).isFile()) { return false; } await fs.access(file, process.platform === 'win32' ? constants.F_OK : constants.X_OK); return true; }
  catch { return false; }
}
export async function inspectToolchain(extension: string, file: string, options: DiscoveryOptions = {}): Promise<Toolchain | undefined> {
  extension = runnerExtension(extension);
  if (!path.isAbsolute(file) || !await executable(file) || (process.platform === 'win32' && !/\.exe$/i.test(file))) { return; }
  // Windows Store aliases can open a store window instead of running an interpreter.
  if (extension === 'py' && /[\\/]Microsoft[\\/]WindowsApps[\\/]/i.test(file)) { return; }
  const profile = defaultRunner(extension); if (!profile) { return; }
  if (['cpp', 'c'].includes(extension) && !isToolName(path.basename(file), extension)) { return; }
  if (profile.compile) { profile.compile[0] = file; } else { profile.run[0] = file; }
  const launcher = extension === 'py' && /^py(?:\.exe)?$/i.test(path.basename(file));
  if (launcher) { profile.run.splice(1, 0, '-3'); }
  if (extension === 'java') {
    // Resolve distribution symlinks so javac and java come from the same JDK.
    try { file = await fs.realpath(file); } catch { return; } profile.compile![0] = file;
    profile.run[0] = path.join(path.dirname(file), process.platform === 'win32' ? 'java.exe' : 'java');
    if (!await executable(profile.run[0])) { return; }
  }
  const env = runnerEnvironment(profile, options.env), probe = options.probe ?? runProcess;
  try {
    const result = await probe([file, ...(launcher ? ['-3'] : []), extension === 'java' ? '-version' : extension === 'go' ? 'version' : '--version'], path.dirname(file), '', 2500, 16384, options.cancellation, env);
    if (result.code !== 0 || result.timedOut || result.cancelled || result.outputExceeded) { return; }
    const output = `${result.stdout}\n${result.stderr}`.trim();
    const banners: Record<string, RegExp> = { cpp: /g\+\+|GCC|clang|Free Software Foundation/i, c: /gcc|clang|Free Software Foundation/i, py: /(?:Python|PyPy) 3\./i, js: /^v\d+\./, java: /javac \d/i, go: /go version go\d/i, rs: /rustc \d/i };
    if (!banners[extension]?.test(output)) { return; }
    if (extension === 'java') {
      const java = await probe([profile.run[0], '-version'], path.dirname(file), '', 2500, 16384, options.cancellation, env);
      if (java.code !== 0 || java.timedOut || java.cancelled || java.outputExceeded) { return; }
    }
    return { executable: file, version: output.split(/\r?\n/).find(line => line.trim())!.trim(), profile };
  } catch { return; }
}

export async function discoverToolchains(extension: string, options: DiscoveryOptions = {}): Promise<Toolchain[]> {
  extension = runnerExtension(extension); if (!toolNames(extension).length) { return []; }
  const env = options.env ?? process.env;
  const dirs = [...(envValue(env, 'PATH') ?? '').split(path.delimiter), ...(options.directories ?? await installationDirectories(env))]
    .map(dir => expandPath(dir.trim(), env)).filter(dir => path.isAbsolute(dir));
  const files: string[] = [];
  for (const hint of options.hints ?? []) {
    const expanded = compilerHint(extension, expandPath(hint, env));
    if (path.isAbsolute(expanded)) {
      if (extension === 'py' && await fs.stat(expanded).then(stat => stat.isDirectory(), () => false)) {
        files.push(path.join(expanded, process.platform === 'win32' ? 'python.exe' : 'bin/python3'));
      } else { files.push(expanded); }
    }
  }
  // Read each directory once; prefer normal tool names over version-suffixed binaries.
  const listings = await Promise.all([...new Set(dirs)].map(async dir => {
    try {
      const entries = await fs.readdir(dir);
      const names = toolNames(extension).map(name => name + (process.platform === 'win32' ? '.exe' : ''));
      return entries.filter(name => isToolName(name, extension) && (process.platform !== 'win32' || /\.exe$/i.test(name)))
        .sort((a, b) => { const rank = (name: string) => { const i = names.indexOf(name); return i < 0 ? names.length : i; }; return rank(a) - rank(b) || b.localeCompare(a, undefined, { numeric: true }); }).map(name => path.join(dir, name));
    } catch { return []; }
  })); files.push(...listings.flat());
  const unique: string[] = [], seen = new Set<string>();
  for (const file of files) {
    try {
      const canonical = await fs.realpath(file), key = process.platform === 'win32' ? canonical.toLowerCase() : canonical;
      if (!seen.has(key)) { seen.add(key); unique.push(file); }
    } catch { /* Stale settings or a removed installation. */ }
  }
  const found: Toolchain[] = [];
  // Bound the number of concurrent version checks and respect cancellation between batches.
  for (let i = 0; i < unique.length; i += 4) {
    if (options.cancellation?.isCancellationRequested) { break; }
    const batch = await Promise.all(unique.slice(i, i + 4).map(file => inspectToolchain(extension, file, options)));
    found.push(...batch.filter((tool): tool is Toolchain => !!tool));
  }
  if (options.msvc && process.platform === 'win32' && ['cpp', 'c'].includes(extension) && !options.cancellation?.isCancellationRequested
    && (options.msvc.prefer || !options.msvc.onlyIfNoneFound || !found.length)) {
    const msvc = await msvcToolchains(extension, options);
    return options.msvc.prefer ? [...msvc, ...found] : [...found, ...msvc];
  }
  return found;
}

/** Parse VS Code style JSON files, which allow comments and trailing commas. */
export function parseJsonc(text: string): unknown {
  const tokens = /"(?:\\.|[^"\\])*"|\/\/[^\n]*|\/\*[\s\S]*?(?:\*\/|$)|,(?=\s*(?:(?:\/\/[^\n]*|\/\*[\s\S]*?\*\/)\s*)*[}\]])/g;
  return JSON.parse(text.replace(/^\uFEFF/, '').replace(tokens, token => token.startsWith('"') ? token : ''));
}
function toolRole(file: string, extension: string): 'msvc' | 'tool' | undefined {
  const name = path.basename(file), stem = name.replace(/\.exe$/i, '');
  if (['cpp', 'c'].includes(extension)) {
    if (/^cl$/i.test(stem)) { return 'msvc'; }
    return /^(?:g\+\+|gcc|clang\+\+|clang|gdb|lldb)(?:-\d+(?:\.\d+)*)?$/i.test(stem) ? 'tool' : undefined;
  }
  return isToolName(name, extension) ? 'tool' : undefined;
}
/** Program paths in a shell-like command line (tasks.json, Code Runner) that name a tool for this language. */
export function commandPaths(command: string, extension: string): string[] {
  extension = runnerExtension(extension); command = command.trim();
  // A bare program path (tasks.json "command", compilerPath) may contain unquoted spaces.
  if (toolRole(command, extension)) { return [command]; }
  return [...command.matchAll(/"([^"]*)"|'([^']*)'|[^\s"'&|;]+/g)].map(match => match[1] ?? match[2] ?? match[0]).filter(token => toolRole(token, extension));
}
function strings(value: unknown, out: string[] = []): string[] {
  if (typeof value === 'string') { out.push(value); }
  else if (Array.isArray(value)) { value.forEach(item => strings(item, out)); }
  else if (value && typeof value === 'object') { Object.values(value).forEach(item => strings(item, out)); }
  return out;
}
function isDefaultBuild(task: unknown): boolean {
  const group = (task as { group?: { kind?: unknown; isDefault?: unknown } } | undefined)?.group;
  return !!group && typeof group === 'object' && group.kind === 'build' && group.isDefault === true;
}
/**
 * Tools the editor already uses for this language: .vscode/tasks.json (default build task first),
 * launch.json and c_cpp_properties.json, from the file's folder up to the workspace root.
 * `msvc` is true when the first compiler mentioned is cl.exe.
 */
export async function editorToolHints(file: string, extension: string, root?: string): Promise<{ hints: string[]; msvc: boolean }> {
  extension = runnerExtension(extension);
  const candidates: string[] = [], stop = root && path.resolve(root);
  let dir = await fs.stat(file).then(stat => stat.isDirectory() ? file : path.dirname(file), () => path.dirname(file));
  for (let depth = 0; depth < 8; depth++) {
    const folder = dir;
    const read = async (name: string) => { try { return parseJsonc(await fs.readFile(path.join(folder, '.vscode', name), 'utf8')); } catch { return undefined; } };
    const [tasks, launch, cpp] = await Promise.all(['tasks.json', 'launch.json', 'c_cpp_properties.json'].map(read));
    const list = Array.isArray((tasks as { tasks?: unknown } | undefined)?.tasks) ? (tasks as { tasks: unknown[] }).tasks : [];
    const values = [...list.filter(isDefaultBuild), ...list.filter(task => !isDefaultBuild(task)), tasks, launch, cpp].flatMap(value => strings(value));
    candidates.push(...values.map(value => value.replace(/\$\{(?:workspaceFolder|workspaceRoot)\}/g, folder)).flatMap(value => commandPaths(value, extension)));
    const parent = path.dirname(dir), inside = stop ? path.relative(stop, dir) : undefined;
    if (parent === dir || (inside === undefined ? depth >= 3 : !inside || inside.startsWith('..'))) { break; }
    dir = parent;
  }
  const hints = [...new Set(candidates)];
  return { hints: hints.filter(hint => toolRole(hint, extension) === 'tool'), msvc: !!hints[0] && toolRole(hints[0], extension) === 'msvc' };
}

const msvcEnvironments = new Map<string, Promise<NodeJS.ProcessEnv>>(), msvcEncodings = new Map<string, string>();
function codepageEncoding(codepage: number): string {
  const label = ({ 936: 'gbk', 54936: 'gb18030', 950: 'big5', 932: 'shift_jis', 949: 'euc-kr', 866: 'ibm866' } as Record<number, string>)[codepage] ?? (codepage >= 1250 && codepage <= 1258 ? `windows-${codepage}` : 'utf-8');
  try { new TextDecoder(label); return label; } catch { return 'utf-8'; }
}
/** The environment a Developer Command Prompt would have; cached because vcvarsall takes seconds. */
export function msvcEnvironment(vcvarsall: string, env: NodeJS.ProcessEnv = process.env): Promise<NodeJS.ProcessEnv> {
  const key = path.resolve(vcvarsall).toLowerCase(), arch = process.arch === 'arm64' ? 'arm64' : process.arch === 'ia32' ? 'x86' : 'x64';
  let cached = msvcEnvironments.get(key);
  if (!cached) {
    cached = new Promise((resolve, reject) => {
      execFile(envValue(env, 'ComSpec') ?? 'cmd.exe', ['/d', '/s', '/c', `"chcp & chcp 65001 >nul && "${vcvarsall}" ${arch} >nul && set"`],
        { env, windowsHide: true, windowsVerbatimArguments: true, timeout: 60000, maxBuffer: 4 << 20 }, (error, stdout) => {
          // The first line is the console code page cl.exe will print diagnostics in.
          const result: NodeJS.ProcessEnv = {}, lines = stdout.split(/\r?\n/), codepage = /(\d+)\s*$/.exec(lines[0] ?? '');
          if (codepage) { msvcEncodings.set(key, codepageEncoding(Number(codepage[1]))); }
          for (const line of lines.slice(1)) { const at = line.indexOf('='); if (at > 0) { result[line.slice(0, at)] = line.slice(at + 1); } }
          if (!error && envValue(result, 'INCLUDE') && envValue(result, 'LIB')) { resolve(result); }
          else { reject(new Error(`无法初始化 MSVC 编译环境：${vcvarsall}`)); }
        });
    });
    cached.catch(() => msvcEnvironments.delete(key)); msvcEnvironments.set(key, cached);
  }
  return cached;
}
/** cl.exe prints diagnostics in the console code page, not UTF-8. */
export async function compilerOutputEncoding(profile: RunnerProfile, env: NodeJS.ProcessEnv = process.env): Promise<string> {
  if (!profile.msvc) { return 'utf-8'; }
  await msvcEnvironment(profile.msvc, env); return msvcEncodings.get(path.resolve(profile.msvc).toLowerCase()) ?? 'utf-8';
}
/** MSVC has no <bits/stdc++.h>, which most contest solutions include; MSVC profiles add `${buildDir}\include`. */
export async function prepareBuildDirectory(profile: RunnerProfile, buildDir: string): Promise<void> {
  if (!profile.msvc) { return; }
  const headers = ['algorithm', 'array', 'bitset', 'cassert', 'cctype', 'cfloat', 'chrono', 'climits', 'cmath', 'complex', 'cstdint', 'cstdio', 'cstdlib', 'cstring', 'ctime',
    'deque', 'fstream', 'functional', 'iomanip', 'iostream', 'iterator', 'limits', 'list', 'map', 'memory', 'numeric', 'optional', 'queue', 'random', 'regex', 'set',
    'sstream', 'stack', 'string', 'string_view', 'tuple', 'type_traits', 'unordered_map', 'unordered_set', 'utility', 'valarray', 'variant', 'vector'];
  await fs.mkdir(path.join(buildDir, 'include', 'bits'), { recursive: true });
  await fs.writeFile(path.join(buildDir, 'include', 'bits', 'stdc++.h'), `#pragma once\n${headers.map(name => `#include <${name}>`).join('\n')}\n`);
}
/** Runner environment including the vcvarsall variables of MSVC profiles. */
export async function prepareRunnerEnvironment(profile: RunnerProfile, env: NodeJS.ProcessEnv = process.env): Promise<NodeJS.ProcessEnv> {
  return runnerEnvironment(profile, profile.msvc ? await msvcEnvironment(profile.msvc, env) : env);
}
async function vcvarsCandidates(options: DiscoveryOptions, env: NodeJS.ProcessEnv): Promise<string[]> {
  const files = (options.msvc?.hints ?? []).map(hint => expandPath(hint, env)).filter(hint => path.isAbsolute(hint) && /^vcvarsall\.bat$/i.test(path.basename(hint)));
  const vswhere = path.join(envValue(env, 'ProgramFiles(x86)') ?? 'C:\\Program Files (x86)', 'Microsoft Visual Studio', 'Installer', 'vswhere.exe');
  if (await executable(vswhere)) {
    try {
      const result = await (options.probe ?? runProcess)([vswhere, '-products', '*', '-requires', 'Microsoft.VisualStudio.Component.VC.Tools.x86.x64', '-property', 'installationPath', '-sort', '-utf8'], path.dirname(vswhere), '', 10000, 65536, options.cancellation, env);
      if (result.code === 0) { files.push(...result.stdout.split(/\r?\n/).map(line => line.trim()).filter(Boolean).map(root => path.join(root, 'VC', 'Auxiliary', 'Build', 'vcvarsall.bat'))); }
    } catch { /* No usable Visual Studio installer. */ }
  }
  const existing: string[] = [], seen = new Set<string>();
  for (const file of files) {
    const key = path.resolve(file).toLowerCase();
    if (!seen.has(key) && await fs.stat(file).then(stat => stat.isFile(), () => false)) { seen.add(key); existing.push(file); }
  }
  return existing;
}
async function msvcToolchains(extension: string, options: DiscoveryOptions): Promise<Toolchain[]> {
  const env = options.env ?? process.env, found: Toolchain[] = [];
  for (const vcvarsall of await vcvarsCandidates(options, env)) {
    if (options.cancellation?.isCancellationRequested) { break; }
    try {
      const msvcEnv = await msvcEnvironment(vcvarsall, env);
      let cl: string | undefined;
      for (const dir of (envValue(msvcEnv, 'PATH') ?? '').split(path.delimiter).filter(dir => path.isAbsolute(dir))) {
        if (await executable(path.join(dir, 'cl.exe'))) { cl = path.join(dir, 'cl.exe'); break; }
      }
      if (!cl) { continue; }
      const result = await (options.probe ?? runProcess)([cl], path.dirname(cl), '', 10000, 16384, options.cancellation, msvcEnv);
      const banner = `${result.stderr}\n${result.stdout}`.split(/\r?\n/).find(line => /Microsoft \(R\) C\/C\+\+/i.test(line));
      if (result.timedOut || result.cancelled || !banner) { continue; }
      found.push({ executable: cl, version: banner.trim(), profile: {
        msvc: vcvarsall,
        compile: [cl, '/nologo', '/utf-8', '/EHsc', '/O2', extension === 'c' ? '/std:c17' : '/std:c++17', '/I${buildDir}\\include', '/Fe${output}', '/Fo${buildDir}\\', '${file}'],
        run: ['${output}']
      } });
    } catch { /* A broken Visual Studio installation. */ }
  }
  return found;
}
