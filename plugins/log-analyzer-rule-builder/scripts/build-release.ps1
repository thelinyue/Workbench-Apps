param(
    [string]$Version = "1.2.2",
    [string]$OutputDirectory = "plugin-release"
)

$ErrorActionPreference = "Stop"
$repoRoot = Split-Path -Parent $PSScriptRoot
$repoRoot = [IO.Path]::GetFullPath($repoRoot)
$releaseRoot = [IO.Path]::GetFullPath((Join-Path $repoRoot $OutputDirectory))
$packageName = "log-rule-editor-v$Version"
$stagingDirectory = Join-Path $releaseRoot $packageName
$zipPath = Join-Path $releaseRoot "$packageName.zip"

if ($Version -notmatch '^\d+\.\d+\.\d+$') {
    throw "Version must use x.y.z format."
}
if (-not $releaseRoot.StartsWith($repoRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
    throw "Output directory must stay inside the source repository."
}

New-Item -ItemType Directory -Path $releaseRoot -Force | Out-Null
if (Test-Path -LiteralPath $stagingDirectory) {
    Remove-Item -LiteralPath $stagingDirectory -Recurse -Force
}
if (Test-Path -LiteralPath $zipPath) {
    Remove-Item -LiteralPath $zipPath -Force
}
New-Item -ItemType Directory -Path $stagingDirectory | Out-Null

$manifestPath = Join-Path $repoRoot "manifest.json"
$manifest = Get-Content -LiteralPath $manifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
if ($manifest.version -ne $Version) {
    throw "manifest.json version $($manifest.version) does not match build version $Version."
}

Copy-Item -LiteralPath (Join-Path $repoRoot "editor.html") -Destination $stagingDirectory
Copy-Item -LiteralPath $manifestPath -Destination $stagingDirectory
Copy-Item -LiteralPath (Join-Path $repoRoot "README.md") -Destination $stagingDirectory
Copy-Item -LiteralPath (Join-Path $repoRoot "LICENSE") -Destination $stagingDirectory
Compress-Archive -Path (Join-Path $stagingDirectory "*") -DestinationPath $zipPath -CompressionLevel Optimal

$hash = (Get-FileHash -LiteralPath $zipPath -Algorithm SHA256).Hash.ToLowerInvariant()
Write-Host "Rule editor package: $zipPath"
Write-Host "SHA-256: $hash"
