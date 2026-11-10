$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem
$projectRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$package = Get-Content -LiteralPath (Join-Path $projectRoot 'package.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$version = $package.version
if ($version -notmatch '^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$') { throw 'Invalid package version' }
$releaseDirectory = Join-Path $projectRoot 'release'
[System.IO.Directory]::CreateDirectory($releaseDirectory) | Out-Null
$destination = Join-Path $releaseDirectory "Tuji-$version-source.zip"
$temporary = Join-Path $releaseDirectory ('.source-' + [guid]::NewGuid().ToString('N') + '.zip')
# Explicit inputs keep notes, attachments, credentials and installed dependencies out.
$inputs = @(
  'desktop', 'public', 'scripts', 'src', '.gitignore', 'README.md',
  'api-config.example.json', 'package.json', 'package-lock.json',
  'index.html', 'postcss.config.js', 'tailwind.config.js', 'tsconfig.json',
  'tsconfig.node.json', 'vite.config.ts', 'electron-builder.config.cjs'
)
$archive = [System.IO.Compression.ZipFile]::Open($temporary, [System.IO.Compression.ZipArchiveMode]::Create)
$count = 0
try {
  foreach ($entry in $inputs) {
    $inputPath = Join-Path $projectRoot $entry
    if (-not (Test-Path -LiteralPath $inputPath)) { throw "Missing source input: $entry" }
    $items = @(Get-Item -LiteralPath $inputPath)
    if ($items[0].PSIsContainer) { $items = @(Get-ChildItem -LiteralPath $inputPath -Recurse -Force) }
    foreach ($item in $items) {
      if ($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) { throw "Source links are not allowed: $($item.Name)" }
      if ($item.PSIsContainer) { continue }
      $relative = $item.FullName.Substring($projectRoot.Length + 1).Replace('\', '/')
      if ($relative -match '(^|/)(node_modules|\.git|\.local|\.cache|\.backups|release|dist|dist-ai)(/|$)' -or
          $item.Name -match '^(\.env(?:\..*)?|api-config\.json|credential\.bin.*)$' -or
          $item.Name -match '\.(sqlite|sqlite3|db)(?:-.*)?$') { throw "Private/generated input rejected: $relative" }
      [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile(
        $archive, $item.FullName, "Tuji-$version-source/$relative", [System.IO.Compression.CompressionLevel]::Optimal) | Out-Null
      $count++
    }
  }
} finally { $archive.Dispose() }
Move-Item -LiteralPath $temporary -Destination $destination -Force
Write-Output "Source archive: $destination ($count files)"
