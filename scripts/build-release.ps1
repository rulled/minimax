$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $PSScriptRoot
$manifestPath = Join-Path $repoRoot "manifest.json"

if (-not (Test-Path $manifestPath)) {
  throw "manifest.json not found in $repoRoot"
}

$manifest = Get-Content $manifestPath -Raw | ConvertFrom-Json
$version = $manifest.version
$distDir = Join-Path $repoRoot "dist"
$archiveName = "minimax-v$version.zip"
$archivePath = Join-Path $distDir $archiveName
$stagingDir = Join-Path $distDir "package"

$includeFiles = @(
  "background.js",
  "content_script.js",
  "manifest.json",
  "parser.js",
  "popup.html",
  "popup.js",
  "README.md"
)

$includeDirectories = @(
  "icons"
)

New-Item -ItemType Directory -Path $distDir -Force | Out-Null

if (Test-Path $stagingDir) {
  Remove-Item $stagingDir -Recurse -Force
}

New-Item -ItemType Directory -Path $stagingDir -Force | Out-Null

foreach ($file in $includeFiles) {
  $source = Join-Path $repoRoot $file
  if (-not (Test-Path $source)) {
    throw "Missing required release file: $file"
  }

  $destination = Join-Path $stagingDir $file
  $destinationDir = Split-Path -Parent $destination
  if (-not (Test-Path $destinationDir)) {
    New-Item -ItemType Directory -Path $destinationDir -Force | Out-Null
  }

  Copy-Item $source $destination -Force
}

foreach ($directory in $includeDirectories) {
  $source = Join-Path $repoRoot $directory
  if (-not (Test-Path $source)) {
    throw "Missing required release directory: $directory"
  }

  Copy-Item $source (Join-Path $stagingDir $directory) -Recurse -Force
}

if (Test-Path $archivePath) {
  Remove-Item $archivePath -Force
}

Compress-Archive -Path (Join-Path $stagingDir "*") -DestinationPath $archivePath -CompressionLevel Optimal
Remove-Item $stagingDir -Recurse -Force

Write-Output "Created $archivePath"
