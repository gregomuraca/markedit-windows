param([string]$OutputDirectory = '..', [string]$WorkDirectory = 'work')
$ErrorActionPreference = 'Stop'
$project = Split-Path $PSScriptRoot -Parent
$version = (Get-Content (Join-Path $project 'package.json') -Raw | ConvertFrom-Json).version
$output = [System.IO.Path]::GetFullPath($OutputDirectory)
$staging = Join-Path ([System.IO.Path]::GetFullPath($WorkDirectory)) ("release-" + [guid]::NewGuid().ToString('N'))
$portable = Join-Path $staging "MarkEdit-$version-Windows-x64"
$source = Join-Path $staging 'MarkEdit-Rust'
New-Item -ItemType Directory -Force $portable,$source,$output | Out-Null
Copy-Item (Join-Path $project 'src-tauri/target/release/markedit-rust.exe') (Join-Path $portable 'MarkEdit.exe')
foreach ($name in @('README.md','DEVELOPMENT.md','LICENSE','THIRD-PARTY-NOTICES.txt','Example.md')) {
    Copy-Item (Join-Path $project $name) (Join-Path $portable $name)
}
Copy-Item -LiteralPath (Join-Path $project 'Screenshots') -Destination (Join-Path $portable 'Screenshots') -Recurse
New-Item -ItemType Directory -Force (Join-Path $portable 'desktop') | Out-Null
Copy-Item (Join-Path $project 'desktop/icon.png') (Join-Path $portable 'desktop/icon.png')
# Capture source only; .gitignore excludes dependencies, profiles, binaries and build output.
$files = git -C $project ls-files --cached --others --exclude-standard
if ($LASTEXITCODE -ne 0) { throw 'Could not enumerate source files' }
foreach ($name in $files | Sort-Object -Unique) {
    $destination = Join-Path $source $name
    New-Item -ItemType Directory -Force (Split-Path $destination -Parent) | Out-Null
    Copy-Item -LiteralPath (Join-Path $project $name) -Destination $destination
}
Compress-Archive -LiteralPath $portable -DestinationPath (Join-Path $output "MarkEdit-Rust-$version-Windows-x64.zip") -Force
Compress-Archive -LiteralPath $source -DestinationPath (Join-Path $output "MarkEdit-Rust-$version-source.zip") -Force
$release = Join-Path $project "release/MarkEdit-$version-Windows-x64"
New-Item -ItemType Directory -Force $release | Out-Null
Copy-Item (Join-Path $portable '*') $release -Force
Get-FileHash (Join-Path $release 'MarkEdit.exe') -Algorithm SHA256 | Format-List Hash
Get-Item (Join-Path $output "MarkEdit-Rust-$version-*.zip") | Select-Object Name,Length
