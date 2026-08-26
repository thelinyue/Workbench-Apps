param(
    [string]$Version = "1.0.0",
    [string]$OutputDirectory = "plugin-release"
)

$ErrorActionPreference = "Stop"
$pluginRoot = Split-Path -Parent $PSScriptRoot
$releaseRoot = Join-Path $pluginRoot $OutputDirectory
$stage = Join-Path $releaseRoot "lvm-uncache-tool-v$Version"
$zipPath = Join-Path $releaseRoot "lvm-uncache-tool-v$Version.zip"

if (Test-Path -LiteralPath $releaseRoot) {
    Remove-Item -LiteralPath $releaseRoot -Recurse -Force
}
New-Item -ItemType Directory -Path $stage -Force | Out-Null

$files = @("manifest.json", "index.html", "app.js", "style.css", "README.md", "LICENSE")
foreach ($file in $files) {
    $source = Join-Path $pluginRoot $file
    if (-not (Test-Path -LiteralPath $source -PathType Leaf)) {
        throw "Release file is missing: $source"
    }
    Copy-Item -LiteralPath $source -Destination (Join-Path $stage $file)
}

$manifest = Get-Content -LiteralPath (Join-Path $stage "manifest.json") -Raw | ConvertFrom-Json
if ($manifest.version -ne $Version) {
    throw "manifest.json version $($manifest.version) does not match release version $Version."
}

Compress-Archive -Path (Join-Path $stage "*") -DestinationPath $zipPath -CompressionLevel Optimal
$hash = (Get-FileHash -LiteralPath $zipPath -Algorithm SHA256).Hash.ToLowerInvariant()
$size = (Get-Item -LiteralPath $zipPath).Length
Write-Output "ZIP: $zipPath"
Write-Output "SHA-256: $hash"
Write-Output "Size: $size bytes"
if ($size -ge 1MB) { throw "Release ZIP is larger than 1 MB: $size bytes" }
