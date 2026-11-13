# Xeneon Edge Widget - installation automatique (appele par Installer.bat).
# Verifie Node.js (l'installe avec winget si besoin) puis lance scripts/install.js.
param(
    [switch]$Uninstall,
    [switch]$Window
)

$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot

function Get-NodeMajor {
    try {
        $v = & node -v 2>$null
        if ($LASTEXITCODE -ne 0 -or -not $v) { return 0 }
        return [int]($v.Trim().TrimStart('v').Split('.')[0])
    } catch {
        return 0
    }
}

function Update-PathFromRegistry {
    $machine = [Environment]::GetEnvironmentVariable('Path', 'Machine')
    $user = [Environment]::GetEnvironmentVariable('Path', 'User')
    $env:Path = "$machine;$user"
}

if ((Get-NodeMajor) -lt 20) {
    Write-Host 'Node.js 20 ou plus recent est necessaire.'
    if (-not (Get-Command winget -ErrorAction SilentlyContinue)) {
        Write-Host 'winget est introuvable : installez Node.js LTS depuis https://nodejs.org puis relancez Installer.bat.'
        exit 1
    }
    Write-Host 'Installation de Node.js LTS avec winget...'
    winget install --id OpenJS.NodeJS.LTS -e --accept-package-agreements --accept-source-agreements
    Update-PathFromRegistry
    if ((Get-NodeMajor) -lt 20) {
        Write-Host 'Node.js vient d etre installe : fermez cette fenetre puis relancez Installer.bat.'
        exit 1
    }
}

$nodeArgs = @('scripts/install.js')
if ($Uninstall) { $nodeArgs += '--uninstall' }
if ($Window) { $nodeArgs += '--window' }

& node @nodeArgs
exit $LASTEXITCODE
