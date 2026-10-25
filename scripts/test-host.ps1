param([string]$VSCodeExecutable = "$env:LOCALAPPDATA\Programs\Microsoft VS Code\Code.exe", [string]$TestSuite = 'host.test.js', [switch]$AssistantFixtures, [string]$ReuseWorkspace, [string]$ExtensionPath)
$ErrorActionPreference = 'Stop'
$taskRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$taskExtensionRoot = if ($ExtensionPath) { (Resolve-Path -LiteralPath $ExtensionPath).Path } else { $taskRoot }
$taskHostDir = Join-Path $taskRoot '.test-host'
New-Item -ItemType Directory -Force -Path $taskHostDir | Out-Null
$taskWorkspace = if ($ReuseWorkspace) { (Resolve-Path -LiteralPath $ReuseWorkspace).Path } else { Join-Path $taskHostDir ('workspace-' + [guid]::NewGuid().ToString('N')) }
if (-not $taskWorkspace.StartsWith($taskHostDir + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw 'Integration tests can only reuse a workspace under this project .test-host directory.' }
New-Item -ItemType Directory -Force -Path $taskWorkspace | Out-Null
$taskResult = Join-Path $taskWorkspace 'result.json'
if (Test-Path -LiteralPath $taskResult) { Remove-Item -LiteralPath $taskResult }
$taskStdout = Join-Path $taskWorkspace 'host-stdout.log'
$taskStderr = Join-Path $taskWorkspace 'host-stderr.log'
$taskPreviousResult = $env:HOJ_CONNECTER_TEST_RESULT
$taskPreviousElectron = $env:ELECTRON_RUN_AS_NODE
$taskPreviousAssistants = $env:HOJ_CONNECTER_TEST_ASSISTANTS
try {
  $env:HOJ_CONNECTER_TEST_RESULT = $taskResult
  $env:HOJ_CONNECTER_TEST_ASSISTANTS = if ($AssistantFixtures) { '1' } else { '0' }
  Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
  $taskArgs = @('--new-window', '--disable-extensions', '--disable-workspace-trust', '--skip-welcome', '--skip-release-notes', '--disable-updates', ('--user-data-dir="' + (Join-Path $taskWorkspace 'profile') + '"'), ('--extensions-dir="' + (Join-Path $taskWorkspace 'extensions') + '"'), ('--extensionDevelopmentPath="' + $taskExtensionRoot + '"'), ('--extensionTestsPath="' + (Join-Path $taskRoot ('dist-tests\' + $TestSuite)) + '"'), ('"' + $taskWorkspace + '"'))
  if ($AssistantFixtures) {
    foreach ($taskAssistant in @(
      @{ publisher = 'openai'; name = 'chatgpt'; command = 'chatgpt.addFileToThread' },
      @{ publisher = 'Anthropic'; name = 'claude-code'; command = 'claude-vscode.insertAtMention' }
    )) {
      $taskFixture = Join-Path $taskWorkspace ('fixture-' + $taskAssistant.name)
      New-Item -ItemType Directory -Force -Path $taskFixture | Out-Null
      @{
        name = $taskAssistant.name; publisher = $taskAssistant.publisher; version = '0.0.0';
        engines = @{ vscode = '^1.95.0' }; main = './extension.js';
        contributes = @{ commands = @(@{ command = $taskAssistant.command; title = 'HOJ-Connecter test fixture' }) }
      } | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath (Join-Path $taskFixture 'package.json') -Encoding ascii
      @'
const vscode = require('vscode');
exports.activate = context => {
  const calls = [];
  const command = require('./package.json').contributes.commands[0].command;
  context.subscriptions.push(vscode.commands.registerCommand(command, async uri => {
    const editor = vscode.window.activeTextEditor;
    if (command === 'claude-vscode.insertAtMention') {
      if (uri !== undefined) throw Error('Claude command ignores arguments; use active editor');
      uri = editor.document.uri;
    }
    if (!(uri instanceof vscode.Uri) || uri.scheme !== 'file') throw Error('Expected a real file URI');
    calls.push({ uri: uri.toString(), content: Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8'), selectionEmpty: editor?.selection.isEmpty });
  }));
  return { calls };
};
'@ | Set-Content -LiteralPath (Join-Path $taskFixture 'extension.js') -Encoding ascii
      $taskArgs += '--extensionDevelopmentPath="' + $taskFixture + '"'
    }
  }
  $taskProcess = Start-Process -FilePath $VSCodeExecutable -ArgumentList $taskArgs -PassThru -WindowStyle Hidden -RedirectStandardOutput $taskStdout -RedirectStandardError $taskStderr
  if (-not $taskProcess.WaitForExit(120000)) { Stop-Process -Id $taskProcess.Id -Force; throw 'VS Code integration tests timed out; see .test-host logs.' }
  if (Test-Path -LiteralPath $taskResult) {
    Get-Content -LiteralPath $taskResult
    $taskData = Get-Content -LiteralPath $taskResult -Raw | ConvertFrom-Json
    if (-not $taskData.ok) { throw $taskData.error }
  } else { Get-Content -LiteralPath $taskStderr; Get-Content -LiteralPath $taskStdout; throw 'VS Code did not write an integration test result.' }
} finally {
  $env:HOJ_CONNECTER_TEST_RESULT = $taskPreviousResult
  $env:ELECTRON_RUN_AS_NODE = $taskPreviousElectron
  $env:HOJ_CONNECTER_TEST_ASSISTANTS = $taskPreviousAssistants
}
