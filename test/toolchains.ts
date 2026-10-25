import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { commandPaths, compilerHint, discoverToolchains, editorToolHints, inspectToolchain, parseJsonc, runnerEnvironment } from '../src/toolchains';
import { expandCommand, ProcessResult, runProcess } from '../src/process';

const suffix = process.platform === 'win32' ? '.exe' : '';
const version = (stdout: string, code = 0): ProcessResult => ({ stdout, stderr: '', code, elapsed: 1, cancelled: false, timedOut: false, outputExceeded: false });

test('discovery prefers hints, skips broken tools, deduplicates PATH and falls back to an installation outside PATH', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hoj-connecter tools '));
  try {
    const broken = path.join(root, 'broken'), installed = path.join(root, 'installed with spaces');
    await Promise.all([fs.mkdir(broken), fs.mkdir(installed)]);
    const gcc = path.join(installed, 'g++' + suffix), clang = path.join(broken, 'clang++' + suffix);
    await Promise.all([fs.writeFile(gcc, '', { mode: 0o755 }), fs.writeFile(clang, '', { mode: 0o755 })]);
    const calls: string[] = [];
    const tools = await discoverToolchains('cc', {
      env: { PATH: [broken, installed, installed].join(path.delimiter) }, directories: [], hints: [gcc, path.join(root, 'removed', 'g++' + suffix)],
      probe: async command => { calls.push(command[0]); return version(command[0] === gcc ? 'g++ (GCC) 14.2.0' : 'broken', command[0] === gcc ? 0 : 1); }
    });
    assert.deepEqual(tools.map(tool => tool.executable), [gcc]); assert.equal(calls.filter(file => file === gcc).length, 1);
    const fallback = await discoverToolchains('cpp', { env: { PATH: broken }, directories: [installed], probe: async command => {
      if (command[0] === clang) { throw new Error('missing compiler DLL'); } return version('g++ (GCC) 14.2.0');
    } });
    assert.equal(fallback[0].executable, gcc);
    assert.equal(fallback[0].profile.compile![0], gcc); assert.deepEqual(fallback[0].profile.run, ['${output}']);
    const cancelled = await discoverToolchains('cpp', { env: { PATH: installed }, directories: [], cancellation: { isCancellationRequested: true, onCancellationRequested: () => ({ dispose() {} }) }, probe: async () => { throw new Error('must not probe after cancellation'); } });
    assert.deepEqual(cancelled, []);
    assert.equal(compilerHint('cpp', path.join(installed, 'gcc' + suffix)), gcc);
    assert.equal(compilerHint('c', path.join(installed, 'clang++' + suffix)), path.join(installed, 'clang' + suffix));
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('editor tasks, launch and IntelliSense files supply compiler hints, default build task first', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hoj-connecter editor '));
  try {
    assert.deepEqual(parseJsonc('{\n // "x": 1,\n "a": "http://x/*y*/", /* c */ "b": [1, 2,],\n}'), { a: 'http://x/*y*/', b: [1, 2] });
    assert.deepEqual(commandPaths('cd $dir && "C:\\My Tools\\bin\\g++.exe" $fileName -o out && $dir$fileNameWithoutExt', 'cpp'), ['C:\\My Tools\\bin\\g++.exe']);
    const nested = path.join(root, 'contest', 'A'); await fs.mkdir(nested, { recursive: true }); await fs.mkdir(path.join(root, '.vscode'));
    const gpp = path.join(root, 'mingw', 'bin', 'g++.exe'), gdb = path.join(root, 'other', 'gdb.exe');
    await fs.writeFile(path.join(root, '.vscode', 'tasks.json'), `{ // generated
      "tasks": [
        { "label": "other", "command": "/usr/bin/clang++", },
        { "label": "build", "command": ${JSON.stringify(gpp)}, "args": ["-g", "\${file}"], "group": { "kind": "build", "isDefault": true } },
      ] }`);
    await fs.writeFile(path.join(root, '.vscode', 'launch.json'), JSON.stringify({ configurations: [{ program: '${fileDirname}/a.exe', miDebuggerPath: gdb }] }));
    await fs.writeFile(path.join(root, '.vscode', 'c_cpp_properties.json'), JSON.stringify({ configurations: [{ compilerPath: '${workspaceFolder}/llvm/bin/clang.exe' }] }));
    const found = await editorToolHints(path.join(nested, 'main.cpp'), 'cpp', root);
    assert.deepEqual(found.hints, [gpp, '/usr/bin/clang++', gdb, `${root}/llvm/bin/clang.exe`]);
    assert.equal(found.msvc, false);
    assert.equal(compilerHint('cpp', gdb), path.join(root, 'other', 'g++.exe'));
    assert.deepEqual((await editorToolHints(path.join(nested, 'main.py'), 'py', root)).hints, []);
    await fs.writeFile(path.join(root, '.vscode', 'tasks.json'), JSON.stringify({ tasks: [{ command: 'g++' }, { command: 'cl.exe', group: { kind: 'build', isDefault: true } }] }));
    assert.equal((await editorToolHints(path.join(nested, 'main.cpp'), 'cpp', root)).msvc, true, 'a default cl.exe build task prefers MSVC');
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('interpreter checks reject Python 2 and store aliases, use py -3, and require a complete JDK', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hoj-connecter interpreters '));
  try {
    const python = path.join(root, 'python' + suffix), launcher = path.join(root, 'py' + suffix);
    const javac = path.join(root, 'javac' + suffix), java = path.join(root, 'java' + suffix);
    await Promise.all([python, launcher, javac].map(file => fs.writeFile(file, '', { mode: 0o755 })));
    assert.equal(await inspectToolchain('py', python, { probe: async () => version('Python 2.7.18') }), undefined);
    const py = await inspectToolchain('py', launcher, { probe: async command => { assert.deepEqual(command.slice(1), ['-3', '--version']); return version('Python 3.13.0'); } });
    assert.deepEqual(py?.profile.run, [launcher, '-3', '${file}']);
    assert.equal(await inspectToolchain('java', javac, { probe: async () => version('javac 21') }), undefined);
    await fs.writeFile(java, '', { mode: 0o755 });
    const commands: string[][] = [];
    const jdk = await inspectToolchain('java', javac, { probe: async command => { commands.push(command); return version(command[0] === java ? 'openjdk version "21"' : 'javac 21'); } });
    assert.equal(jdk?.profile.run[0], java); assert.deepEqual(commands, [[javac, '-version'], [java, '-version']]);
    assert.equal(await inspectToolchain('js', python, { probe: async () => version('Python 3.13.0') }), undefined, 'another language executable must never be used as Node');
    if (process.platform === 'win32') {
      const alias = path.join(root, 'Microsoft', 'WindowsApps', 'python.exe'); await fs.mkdir(path.dirname(alias), { recursive: true }); await fs.writeFile(alias, '');
      assert.equal(await inspectToolchain('py', alias, { probe: async () => { throw new Error('must not launch the store alias'); } }), undefined);
    }
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('a real runtime outside PATH runs sample input from a path containing spaces', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hoj-connecter local runtime '));
  try {
    const executable = path.join(root, 'node' + suffix); await fs.copyFile(process.execPath, executable); await fs.chmod(executable, 0o755);
    const env = { ...process.env }; const pathKey = Object.keys(env).find(key => key.toUpperCase() === 'PATH') ?? 'PATH'; env[pathKey] = '';
    const tools = await discoverToolchains('js', { env, directories: [root] });
    assert.equal(tools.length, 1); assert.equal(tools[0].executable, executable);
    const file = path.join(root, 'sample solution.js'); await fs.writeFile(file, "let s='';process.stdin.on('data',x=>s+=x);process.stdin.on('end',()=>console.log(s.trim().split(/\\s+/).map(Number).reduce((a,b)=>a+b,0)));");
    const result = await runProcess(expandCommand(tools[0].profile.run, file, root), root, '20 22\n', 3000, 4096, undefined, runnerEnvironment(tools[0].profile, env));
    assert.equal(result.code, 0); assert.equal(result.stdout.trim(), '42');
    const prepared = runnerEnvironment({ compile: [path.join(root, 'g++' + suffix)], run: ['${output}'] }, { Path: 'original-path', OTHER: 'preserved' });
    assert.equal(prepared.Path, root + path.delimiter + 'original-path'); assert.equal(prepared.OTHER, 'preserved'); assert.equal(Object.hasOwn(prepared, 'PATH'), false);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
