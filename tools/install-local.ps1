[CmdletBinding()]
param(
    # 本地仓库路径（默认：本脚本所在仓库的根目录），
    # 或 Git 地址 / GitHub 简写（cglyvip/dsh-phone-bridge），此时先浅克隆再安装。
    [string]$Source = (Split-Path -Parent $PSScriptRoot),
    [string]$ProfileRoot = '',
    [string]$Ref = ''
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

function Get-JsonObject {
    param([object]$Parent, [string]$Name)

    $property = $Parent.PSObject.Properties[$Name]
    if ($null -eq $property) {
        $Parent | Add-Member -MemberType NoteProperty -Name $Name -Value ([pscustomobject]@{})
        return $Parent.PSObject.Properties[$Name].Value
    }
    if ($property.Value -isnot [pscustomobject]) {
        throw "Profile field '$Name' must be a JSON object."
    }
    return $property.Value
}

function Read-JsonFile {
    # 必须显式按 UTF-8 读取：Windows PowerShell 5.1 的 Get-Content 默认用系统 ANSI 编码
    # （中文系统是 gb2312），而 package.json 是无 BOM 的 UTF-8，中文描述会变成乱码，
    # ConvertFrom-Json 随即报「无效的 JSON 基元」。
    param([string]$Path)
    $text = [System.IO.File]::ReadAllText($Path, [System.Text.Encoding]::UTF8)
    return $text | ConvertFrom-Json
}

function Assert-ChildPath {
    param([string]$Path, [string]$Root)

    $absolutePath = [System.IO.Path]::GetFullPath($Path)
    $absoluteRoot = [System.IO.Path]::GetFullPath($Root).TrimEnd('\') + '\'
    if (-not $absolutePath.StartsWith($absoluteRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "Path is outside the intended directory: $absolutePath"
    }
    return $absolutePath
}

function Assert-NoReparsePoint {
    param([string]$Path)

    if (Test-Path -LiteralPath $Path) {
        $pathItem = Get-Item -LiteralPath $Path -Force
        if (($pathItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
            throw "Refusing to follow a junction or symbolic link: $Path"
        }
    }
}

function Assert-TreeNoReparsePoint {
    param([string]$Path)

    Assert-NoReparsePoint -Path $Path
    $directories = [System.Collections.Generic.Stack[string]]::new()
    $directories.Push($Path)
    while ($directories.Count -gt 0) {
        $directoryPath = $directories.Pop()
        foreach ($childItem in (Get-ChildItem -LiteralPath $directoryPath -Force)) {
            if (($childItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
                throw "Refusing to move or copy a tree containing a junction or symbolic link: $($childItem.FullName)"
            }
            if ($childItem.PSIsContainer) {
                $directories.Push($childItem.FullName)
            }
        }
    }
}

$nodeCommand = (Get-Command node.exe -ErrorAction Stop).Source
$npmCommand = (Get-Command npm.cmd -ErrorAction Stop).Source
# 优先用系统自带的 bsdtar（System32\tar.exe）。PATH 里如果有 Git 的 GNU tar，
# 它会把 `C:\...` 当成 `主机:路径` 解析，报「Cannot connect to C: resolve failed」。
$systemTar = Join-Path $env:SystemRoot 'System32\tar.exe'
$tarCommand = if (Test-Path -LiteralPath $systemTar) {
    $systemTar
} else {
    (Get-Command tar.exe -ErrorAction Stop).Source
}
$nodeVersion = & $nodeCommand -p 'process.versions.node'
if ($LASTEXITCODE -ne 0 -or [int]$nodeVersion.Split('.')[0] -lt 20) {
    throw 'Install Node.js 20 or later before installing this plugin.'
}

# ── 来源解析：本地目录 / Git 地址 / GitHub 简写 都支持 ──────────────────────
# 用户想「直接从 GitHub 安装」时不必先 clone：
#   .\install-local.ps1 -Source cglyvip/dsh-phone-bridge
#   .\install-local.ps1 -Source https://github.com/cglyvip/dsh-phone-bridge.git -Ref main
$gitCommand = $null
$temporaryClone = $null
$isRemoteSource = $false
# 必须先看本地目录是否存在：相对路径如 doc/sub 也符合 GitHub 简写格式，
# 若先按正则判断，本地相对路径会被误当成远端仓库去克隆。
if (Test-Path -LiteralPath $Source -PathType Container) {
    $isRemoteSource = $false
} elseif ($Source -match '^(https?://|git@|ssh://)' -or $Source -match '^[\w.-]+/[\w.-]+$') {
    $isRemoteSource = $true
} else {
    throw "Source does not exist: $Source（本地路径不存在，也不是 Git 地址）"
}

if ($isRemoteSource) {
    $gitCommand = (Get-Command git.exe -ErrorAction SilentlyContinue).Source
    if ($null -eq $gitCommand) {
        $gitCommand = (Get-Command git -ErrorAction SilentlyContinue).Source
    }
    if ([string]::IsNullOrWhiteSpace($gitCommand)) {
        throw '从 GitHub 安装需要先安装 Git（https://git-scm.com/download/win），或改用 -Source <本地仓库路径>。'
    }
    $cloneUrl = if ($Source -match '^[\w.-]+/[\w.-]+$') {
        'https://github.com/' + $Source + '.git'
    } else {
        $Source
    }
    $temporaryClone = Join-Path ([System.IO.Path]::GetTempPath()) ('dsh-phone-bridge-src-' + [guid]::NewGuid().ToString('N'))
    Write-Output ('Cloning ' + $cloneUrl + ' ...')
    $cloneArgs = @('clone', '--depth', '1')
    if (-not [string]::IsNullOrWhiteSpace($Ref)) {
        $cloneArgs += @('--branch', $Ref)
    }
    $cloneArgs += @($cloneUrl, $temporaryClone)
    & $gitCommand @cloneArgs
    if ($LASTEXITCODE -ne 0) {
        # git 通常已自行清理失败目录，这里再兜底一次，避免依赖 git 的行为
        if (Test-Path -LiteralPath $temporaryClone) {
            try {
                Remove-Item -LiteralPath $temporaryClone -Recurse -Force -ErrorAction SilentlyContinue
            } catch {
                # 清理失败不覆盖原始错误
            }
        }
        throw 'git clone failed. Check the network and the repository address.'
    }
    $Source = $temporaryClone
}

try {
$sourceRoot = (Resolve-Path -LiteralPath $Source -ErrorAction Stop).Path
$sourceManifestPath = Join-Path $sourceRoot 'package.json'
$sourceManifest = Read-JsonFile -Path $sourceManifestPath
if ($sourceManifest.name -ne 'dsh-phone-bridge') {
    throw 'Source must point to the dsh-phone-bridge repository root.'
}

if ([string]::IsNullOrWhiteSpace($ProfileRoot)) {
    $installationHome = if ([string]::IsNullOrWhiteSpace($env:DSH_HOME)) {
        Join-Path $env:USERPROFILE '.dsh'
    } else {
        $env:DSH_HOME
    }
    $ProfileRoot = Join-Path $installationHome 'profiles\desktop'
}

$profileDirectory = (Resolve-Path -LiteralPath $ProfileRoot -ErrorAction Stop).Path
Assert-NoReparsePoint -Path $profileDirectory
$profileManifestPath = Join-Path $profileDirectory 'package.json'
if (-not (Test-Path -LiteralPath $profileManifestPath -PathType Leaf)) {
    throw 'Desktop profile package.json is missing. Start DSH once, exit it completely, then retry with its actual profile path.'
}
$profileManifest = Read-JsonFile -Path $profileManifestPath
if ($profileManifest -isnot [pscustomobject]) {
    throw 'Desktop profile package.json must contain a JSON object.'
}
$null = Get-JsonObject -Parent $profileManifest -Name 'dependencies'
$profileSettings = Get-JsonObject -Parent (Get-JsonObject -Parent $profileManifest -Name 'dsh') -Name 'profile'
$bundleProperty = $profileSettings.PSObject.Properties['bundles']
if ($null -ne $bundleProperty -and $bundleProperty.Value -isnot [array]) {
    throw 'Desktop profile dsh.profile.bundles must be a JSON array.'
}

$backupSuffix = '.before-phone-bridge-' + (Get-Date -Format 'yyyyMMdd-HHmmss-fff') + '.bak'
Copy-Item -LiteralPath $profileManifestPath -Destination ($profileManifestPath + $backupSuffix)
$profileLockPath = Join-Path $profileDirectory 'package-lock.json'
if (Test-Path -LiteralPath $profileLockPath -PathType Leaf) {
    Copy-Item -LiteralPath $profileLockPath -Destination ($profileLockPath + $backupSuffix)
}

$installId = (Get-Date -Format 'yyyyMMdd-HHmmss-fff') + '-' + [guid]::NewGuid().ToString('N')
$archiveRoot = Join-Path $profileDirectory '.dsh-local-packages'
Assert-NoReparsePoint -Path $archiveRoot
$archiveDirectory = Assert-ChildPath -Path (Join-Path $archiveRoot $installId) -Root $profileDirectory
$null = New-Item -ItemType Directory -Path $archiveDirectory -Force
$packOutput = & $npmCommand pack $sourceRoot --pack-destination $archiveDirectory --ignore-scripts --json
if ($LASTEXITCODE -ne 0) {
    throw 'npm pack failed. Installation stopped; profile backups are retained.'
}
$packMetadata = @((($packOutput -join "`n") | ConvertFrom-Json))
if ($packMetadata.Count -ne 1 -or $packMetadata[0].name -ne 'dsh-phone-bridge') {
    throw 'npm pack did not return exactly one dsh-phone-bridge package.'
}
$archivePath = Assert-ChildPath -Path (Join-Path $archiveDirectory $packMetadata[0].filename) -Root $archiveDirectory
if (-not (Test-Path -LiteralPath $archivePath -PathType Leaf)) {
    throw 'The packed plugin archive is missing.'
}

$stagingDirectory = Join-Path ([System.IO.Path]::GetTempPath()) ('dsh-phone-bridge-install-' + $installId)
$null = New-Item -ItemType Directory -Path $stagingDirectory
& $tarCommand -xf $archivePath -C $stagingDirectory
if ($LASTEXITCODE -ne 0) {
    throw 'Could not extract the packed plugin. Existing installed plugins were not changed.'
}
$stagedPackage = Assert-ChildPath -Path (Join-Path $stagingDirectory 'package') -Root $stagingDirectory
Assert-TreeNoReparsePoint -Path $stagedPackage
& $npmCommand install --prefix $stagedPackage --omit=dev --ignore-scripts --no-audit --no-fund
if ($LASTEXITCODE -ne 0) {
    throw 'Installing isolated plugin dependencies failed. Existing installed plugins were not changed.'
}

# npm 会在包自己的 node_modules 里放一个指向包自身的链接
# （node_modules\dsh-phone-bridge -> ..），好让包能按自己的名字 import 自己。
# 它对安装结果没用，却会让下面的 reparse point 检查直接失败，
# 后面递归拷贝时还可能顺着链接无限展开。只在它确实是链接时删掉链接本身
# （用 Directory.Delete 而不是 Remove-Item -Recurse：后者会顺着链接删掉目标里的内容）。
$selfLink = Join-Path $stagedPackage 'node_modules\dsh-phone-bridge'
if (Test-Path -LiteralPath $selfLink) {
    $selfLinkItem = Get-Item -LiteralPath $selfLink -Force
    if (($selfLinkItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
        [System.IO.Directory]::Delete($selfLink, $false)
    }
}

Assert-TreeNoReparsePoint -Path $stagedPackage
$stagedManifest = Read-JsonFile -Path (Join-Path $stagedPackage 'package.json')
if ($stagedManifest.name -ne 'dsh-phone-bridge' -or $stagedManifest.version -ne $sourceManifest.version) {
    throw 'Staged plugin does not match the selected source.'
}

$nodeModulesDirectory = Assert-ChildPath -Path (Join-Path $profileDirectory 'node_modules') -Root $profileDirectory
Assert-NoReparsePoint -Path $nodeModulesDirectory
$null = New-Item -ItemType Directory -Path $nodeModulesDirectory -Force
$pluginTarget = Assert-ChildPath -Path (Join-Path $nodeModulesDirectory 'dsh-phone-bridge') -Root $nodeModulesDirectory
if ([System.IO.Path]::GetFileName($pluginTarget) -ne 'dsh-phone-bridge') {
    throw 'Plugin target must be the dsh-phone-bridge directory.'
}
Assert-NoReparsePoint -Path $pluginTarget
if (Test-Path -LiteralPath $pluginTarget) {
    Assert-TreeNoReparsePoint -Path $pluginTarget
    $backupRoot = Assert-ChildPath -Path (Join-Path $profileDirectory '.dsh-plugin-backups') -Root $profileDirectory
    Assert-NoReparsePoint -Path $backupRoot
    $null = New-Item -ItemType Directory -Path $backupRoot -Force
    $pluginBackup = Assert-ChildPath -Path (Join-Path $backupRoot ('dsh-phone-bridge-' + $installId)) -Root $backupRoot
    if (Test-Path -LiteralPath $pluginBackup) {
        throw 'The selected plugin backup directory already exists.'
    }
    Move-Item -LiteralPath $pluginTarget -Destination $pluginBackup
    Write-Output ('Previous plugin backup: ' + $pluginBackup)
}
Copy-Item -LiteralPath $stagedPackage -Destination $pluginTarget -Recurse

$profileManifest = Read-JsonFile -Path $profileManifestPath
$dependencies = Get-JsonObject -Parent $profileManifest -Name 'dependencies'
$dependencyPath = 'file:' + $archivePath.Replace('\', '/')
if ($null -eq $dependencies.PSObject.Properties['dsh-phone-bridge']) {
    $dependencies | Add-Member -MemberType NoteProperty -Name 'dsh-phone-bridge' -Value $dependencyPath
} else {
    $dependencies.PSObject.Properties['dsh-phone-bridge'].Value = $dependencyPath
}
$profileSettings = Get-JsonObject -Parent (Get-JsonObject -Parent $profileManifest -Name 'dsh') -Name 'profile'
$bundleProperty = $profileSettings.PSObject.Properties['bundles']
if ($null -eq $bundleProperty) {
    $bundles = @()
} else {
    $bundles = @($bundleProperty.Value)
}
if ($bundles -notcontains 'dsh-phone-bridge') {
    $bundles = @($bundles) + @('dsh-phone-bridge')
    if ($null -eq $bundleProperty) {
        $profileSettings | Add-Member -MemberType NoteProperty -Name 'bundles' -Value $bundles
    } else {
        $bundleProperty.Value = $bundles
    }
}
$profileJson = $profileManifest | ConvertTo-Json -Depth 100
[System.IO.File]::WriteAllText($profileManifestPath, $profileJson + "`n", [System.Text.UTF8Encoding]::new($false))

$installedManifestPath = Join-Path $profileDirectory 'node_modules\dsh-phone-bridge\package.json'
$installedManifest = Read-JsonFile -Path $installedManifestPath
if ($installedManifest.name -ne 'dsh-phone-bridge' -or $installedManifest.version -ne $sourceManifest.version) {
    throw 'Installed plugin version does not match the selected source.'
}

Write-Output ('Installed dsh-phone-bridge ' + $installedManifest.version)
Write-Output ('Desktop profile: ' + $profileDirectory)
Write-Output ('Profile backup: ' + $profileManifestPath + $backupSuffix)
Write-Output ('Isolated installation files: ' + $stagingDirectory)
Write-Output 'Exit DSH completely from its system tray, then start it again.'
Write-Output 'On this computer, open http://127.0.0.1:9000/api/health and http://127.0.0.1:9000/pair.'
}
finally {
    # 远程来源的临时克隆用完即删；本地来源不动用户仓库
    if ($null -ne $temporaryClone -and (Test-Path -LiteralPath $temporaryClone)) {
        try {
            Remove-Item -LiteralPath $temporaryClone -Recurse -Force -ErrorAction SilentlyContinue
        } catch {
            # 清理失败不影响安装结果
        }
    }
}
