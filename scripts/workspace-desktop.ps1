param(
  [string]$Node = '',
  [switch]$CreateShortcut
)
$ErrorActionPreference = 'Stop'
try {
  $project = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
  if (-not $Node) { $Node = (Get-Command node.exe -ErrorAction Stop).Source }
  if ($CreateShortcut) {
    $desktop = [Environment]::GetFolderPath([Environment+SpecialFolder]::DesktopDirectory)
    $shortcutFile = Join-Path $desktop '图记（工作区测试）.lnk'
    $shell = New-Object -ComObject WScript.Shell
    $link = $shell.CreateShortcut($shortcutFile)
    $launcher = Join-Path $PSScriptRoot 'workspace-desktop.ps1'
    if ((Test-Path -LiteralPath $shortcutFile) -and -not $link.Arguments.Contains($launcher)) {
      throw '桌面已有同名但属于其他程序的快捷方式。'
    }
    $link.TargetPath = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
    $link.Arguments = '-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "'+$launcher+'" -Node "'+$Node+'"'
    $link.WorkingDirectory = $project
    $link.IconLocation = (Join-Path $project 'desktop\assets\app-icon.ico')+',0'
    $link.Description = '打开实时工作区代码，使用安装版的存储目录'
    $link.WindowStyle = 7
    $link.Save()
    Write-Output $shortcutFile
    return
  }
  # Use the Node executable selected when the shortcut was created. Windows
  # Explorer may have a different PATH from the developer's terminal.
  $result = & $Node --disable-warning=ExperimentalWarning (Join-Path $PSScriptRoot 'workspace-desktop.mjs') 2>&1
  if ($LASTEXITCODE -ne 0) { throw ($result -join [Environment]::NewLine) }
} catch {
  if ($CreateShortcut) { throw }
  Add-Type -AssemblyName System.Windows.Forms
  [void][Windows.Forms.MessageBox]::Show($_.Exception.Message,'图记工作区启动失败')
  exit 1
}
