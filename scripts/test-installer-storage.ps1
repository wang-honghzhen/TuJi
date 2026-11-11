$ErrorActionPreference = 'Stop'
$projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$testRoot = Join-Path $projectRoot ('.cache\installer-storage-' + [guid]::NewGuid().ToString('N'))
[IO.Directory]::CreateDirectory($testRoot) | Out-Null
$settingsRoot = Join-Path ([IO.Path]::GetTempPath()) ('tuji-installer-settings-' + [guid]::NewGuid().ToString('N'))
$compiler = Get-ChildItem -LiteralPath (Join-Path $env:LOCALAPPDATA 'electron-builder\Cache') -Recurse -Filter makensis.exe -File |
  Where-Object { Test-Path -LiteralPath (Join-Path $_.DirectoryName 'Include\MUI2.nsh') } | Select-Object -First 1
if (-not $compiler) { throw 'Run npm run package:win once to prepare the NSIS compiler.' }
$template = @'
Unicode true
RequestExecutionLevel user
Name "Tuji storage test"
OutFile "@ROOT@\storage-test.exe"
InstallDir "@ROOT@\program"
!include MUI2.nsh
!define TUJI_STORAGE_DIRECTORY "@SETTINGS@"
!define TUJI_LEGACY_DATA_DIRECTORY "@ROOT@\legacy"
!macro setInstallModePerUser
  SetShellVarContext current
!macroend
!include "@PROJECT@\desktop\installer.nsh"
!insertmacro customPageAfterChangeDir
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_LANGUAGE "SimpChinese"
Function .onInit
  !insertmacro customInit
FunctionEnd
Section
  !insertmacro customInstall
SectionEnd
'@
$source = $template.Replace('@ROOT@', $testRoot).Replace('@PROJECT@', $projectRoot).Replace('@SETTINGS@', $settingsRoot)
$scriptFile = Join-Path $testRoot 'storage-test.nsi'
[IO.File]::WriteAllText($scriptFile, $source, [Text.UTF8Encoding]::new($true))
& $compiler.FullName '/V2' $scriptFile
if ($LASTEXITCODE -ne 0) { throw 'NSIS test harness compilation failed' }
$executable = Join-Path $testRoot 'storage-test.exe'
$settings = Join-Path $settingsRoot 'data-directory.txt'
$selected = Join-Path $testRoot '中文 数据目录'
$legacy = Join-Path $testRoot 'legacy'
[IO.Directory]::CreateDirectory($legacy) | Out-Null
[IO.File]::WriteAllText((Join-Path $legacy 'keep.txt'), 'existing notes')
function Invoke-StorageInstaller([string]$Arguments, [int]$ExpectedCode) {
  $info = [Diagnostics.ProcessStartInfo]::new($executable, $Arguments)
  $info.UseShellExecute = $false
  $info.CreateNoWindow = $true
  $info.WindowStyle = [Diagnostics.ProcessWindowStyle]::Hidden
  $run = [Diagnostics.Process]::Start($info)
  $run.WaitForExit()
  if ($run.ExitCode -ne $ExpectedCode) { throw "Unexpected installer exit code: $($run.ExitCode)" }
  Write-Output "Installer case passed (exit $ExpectedCode)."
}
Invoke-StorageInstaller ('/S /DATA_DIR="' + $selected + '"') 0
if ([IO.File]::ReadAllText($settings, [Text.Encoding]::Unicode) -ne $selected) { throw 'Custom data path was not saved correctly' }
if (-not (Test-Path -LiteralPath $selected -PathType Container)) { throw 'Custom data folder was not created' }
Invoke-StorageInstaller '/S' 0
if ([IO.File]::ReadAllText($settings, [Text.Encoding]::Unicode) -ne $selected) { throw 'Upgrade changed the stored data path' }
[IO.Directory]::CreateDirectory((Join-Path $testRoot 'program')) | Out-Null
$alias = Join-Path $testRoot 'program-link'
New-Item -ItemType Junction -Path $alias -Target (Join-Path $testRoot 'program') | Out-Null
foreach ($invalid in @((Join-Path $testRoot 'program\data'), $testRoot, 'relative-path', [IO.Path]::GetPathRoot($testRoot), (Join-Path $alias 'data'))) {
  Invoke-StorageInstaller ('/S /DATA_DIR="' + $invalid + '"') 2
  if ([IO.File]::ReadAllText($settings, [Text.Encoding]::Unicode) -ne $selected) { throw 'Failed installation changed the saved data location' }
}
if ([IO.File]::ReadAllText((Join-Path $legacy 'keep.txt')) -ne 'existing notes') { throw 'Existing user data was modified' }
Write-Output 'PASS: compiled installer saves Unicode paths, preserves upgrade settings, rejects invalid locations and leaves old data intact.'
[IO.File]::WriteAllText((Join-Path $testRoot 'result.txt'), 'PASS')
Write-Output "Installer test fixture: $testRoot"
