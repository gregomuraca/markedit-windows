param(
 [string]$Version='latest',
 [string]$InstallDirectory=(Join-Path $env:LOCALAPPDATA 'Programs\MarkEdit'),
 [switch]$NoLaunch,
 [switch]$NoShortcut
)
$ErrorActionPreference='Stop'
if([Environment]::OSVersion.Platform -ne 'Win32NT'){throw 'MarkEdit requires Windows x64.'}
if(-not [Environment]::Is64BitOperatingSystem){throw 'MarkEdit requires 64-bit Windows.'}
[Net.ServicePointManager]::SecurityProtocol=[Net.SecurityProtocolType]::Tls12
$taskRepository='gregomuraca/markedit-windows'
$taskHeaders=@{'User-Agent'='MarkEdit-installer';Accept='application/vnd.github+json'}
if($Version -eq 'latest'){
 $taskRelease=Invoke-RestMethod "https://api.github.com/repos/$taskRepository/releases/latest" -Headers $taskHeaders
 $Version=$taskRelease.tag_name -replace '^v',''
}
if($Version -notmatch '^\d+\.\d+\.\d+$'){throw 'Choose a release version such as 0.3.3.'}
$taskAsset="MarkEdit-Rust-$Version-Windows-x64.zip"
$taskBase="https://github.com/$taskRepository/releases/download/v$Version"
$taskWork=Join-Path ([IO.Path]::GetTempPath()) ('markedit-install-'+[Guid]::NewGuid().ToString('N'))
$taskDestination=[IO.Path]::GetFullPath($InstallDirectory)
New-Item -ItemType Directory -Path $taskWork -Force | Out-Null
try {
 $taskZip=Join-Path $taskWork $taskAsset
 Write-Output "Downloading MarkEdit $Version..."
 Invoke-WebRequest "$taskBase/$taskAsset" -OutFile $taskZip -UseBasicParsing
 $taskManifest=(Invoke-WebRequest "$taskBase/SHA256SUMS.txt" -UseBasicParsing).Content
 $taskPattern='(?m)^([a-fA-F0-9]{64})\s+\*?'+[Regex]::Escape($taskAsset)+'\s*$'
 $taskMatch=[Regex]::Match($taskManifest,$taskPattern)
 if(-not $taskMatch.Success){throw 'The release checksum manifest does not contain this ZIP.'}
 if((Get-FileHash -LiteralPath $taskZip -Algorithm SHA256).Hash -ne $taskMatch.Groups[1].Value){throw 'The downloaded ZIP checksum did not match. Nothing was installed.'}
 $taskExtracted=Join-Path $taskWork 'extracted'
 Expand-Archive -LiteralPath $taskZip -DestinationPath $taskExtracted
 $taskAppFolder="MarkEdit-$Version-Windows-x64"
 $taskExtractedApp=Join-Path $taskExtracted $taskAppFolder
 if(-not(Test-Path -LiteralPath (Join-Path $taskExtractedApp 'MarkEdit.exe'))){throw 'The release ZIP is missing MarkEdit.exe.'}
 New-Item -ItemType Directory -Path $taskDestination -Force | Out-Null
 $taskInstalledApp=Join-Path $taskDestination $taskAppFolder
 New-Item -ItemType Directory -Path $taskInstalledApp -Force | Out-Null
 Copy-Item -Path (Join-Path $taskExtractedApp '*') -Destination $taskInstalledApp -Recurse -Force
 $taskExecutable=Join-Path $taskInstalledApp 'MarkEdit.exe'
 if((Get-FileHash -LiteralPath $taskExecutable).Hash -ne (Get-FileHash -LiteralPath (Join-Path $taskExtractedApp 'MarkEdit.exe')).Hash){throw 'Installed executable verification failed.'}
 if(-not $NoShortcut){
  $taskMenu=Join-Path ([Environment]::GetFolderPath('Programs')) 'MarkEdit.lnk'
  $taskShell=New-Object -ComObject WScript.Shell
  $taskShortcut=$taskShell.CreateShortcut($taskMenu)
  $taskShortcut.TargetPath=$taskExecutable
  $taskShortcut.WorkingDirectory=$taskInstalledApp
  $taskShortcut.Description='MarkEdit for Windows'
  $taskShortcut.Save()
 }
 Write-Output "Installed MarkEdit ${Version}: $taskExecutable"
 if(-not $NoLaunch){Start-Process -FilePath $taskExecutable -WindowStyle Normal}
} finally {
 # Remove only the fresh temporary directory created by this run.
 $taskResolved=[IO.Path]::GetFullPath($taskWork)
 $taskTempRoot=[IO.Path]::GetFullPath([IO.Path]::GetTempPath())
 if($taskResolved.StartsWith($taskTempRoot,[StringComparison]::OrdinalIgnoreCase) -and (Split-Path $taskResolved -Leaf) -match '^markedit-install-[a-f0-9]{32}$'){
  Remove-Item -LiteralPath $taskResolved -Recurse -Force
 }
}
