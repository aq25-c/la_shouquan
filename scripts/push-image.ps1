<#
.SYNOPSIS
    构建并推送 license-server 镜像到镜像仓库（Docker Hub / GHCR / 阿里云 ACR / 腾讯云 TCR / Harbor）。

.DESCRIPTION
    必须在装有 Docker 的机器上、在仓库根目录（含 Dockerfile）执行。
    脚本会依次：检查环境 -> 登录 -> 构建（自动本地+远程双标签）-> 推送 -> 打印 digest 与线上部署提示。

.PARAMETER Registry
    仓库域名，例如 registry.cn-hangzhou.aliyuncs.com / ghcr.io / docker.io / harbor.example.com

.PARAMETER Repo
    命名空间/仓库名，例如 myns/license-server

.PARAMETER Tag
    镜像标签，建议语义化版本（默认 1.0.0）。生产不要用 latest。

.PARAMETER Platform
    目标架构，例如 linux/amd64 或 linux/amd64,linux/arm64。
    指定后走 buildx 并直接 --push（跨架构时无法 --load）。
    留空则用当前机器架构构建。

.PARAMETER PushLatest
    额外推送一个 latest 标签。

.PARAMETER SkipLogin
    跳过 docker login（已登录过时用）。

.PARAMETER SkipBuild
    只推送已有镜像，不重新构建。

.PARAMETER DryRun
    只打印将要执行的命令，不做任何实际操作（可在没有 Docker 的机器上校验参数）。

.EXAMPLE
    .\scripts\push-image.ps1 -Registry registry.cn-hangzhou.aliyuncs.com -Repo myns/license-server -Tag 1.0.0

.EXAMPLE
    .\scripts\push-image.ps1 -Registry ghcr.io -Repo myorg/license-server -Tag 1.0.0 -Platform linux/amd64,linux/arm64 -PushLatest

.EXAMPLE
    .\scripts\push-image.ps1 -Registry ghcr.io -Repo myorg/license-server -DryRun
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$Registry,
    [Parameter(Mandatory = $true)][string]$Repo,
    [string]$Tag = "1.0.0",
    [string]$Platform = "",
    [switch]$PushLatest,
    [switch]$SkipLogin,
    [switch]$SkipBuild,
    [switch]$DryRun
)

$ErrorActionPreference = "Stop"

function Invoke-Docker {
    param([Parameter(Mandatory = $true)][string[]]$Arguments)

    $cmdLine = "docker " + ($Arguments -join " ")
    if ($DryRun) {
        Write-Host ("[dry-run] " + $cmdLine) -ForegroundColor Yellow
        return
    }
    Write-Host ("`$ " + $cmdLine) -ForegroundColor DarkGray
    & docker @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw ("docker 命令失败（exit " + $LASTEXITCODE + "）：" + $cmdLine)
    }
}

# ---------- 参数归一化 ----------
$Registry = $Registry.Trim().TrimEnd("/")
$Repo = $Repo.Trim().Trim("/")
$Tag = $Tag.Trim()

if ($Registry -eq "" -or $Repo -eq "") { throw "Registry 与 Repo 不能为空" }
if ($Tag -eq "") { throw "Tag 不能为空" }

$localTag = "license-server:" + $Tag
$remoteTag = $Registry + "/" + $Repo + ":" + $Tag
$remoteLatest = $Registry + "/" + $Repo + ":latest"

# ---------- 环境检查 ----------
$root = (Get-Location).Path
if (-not (Test-Path (Join-Path $root "Dockerfile"))) {
    throw ("当前目录没有 Dockerfile，请在仓库根目录执行（当前：" + $root + "）")
}
if (-not (Test-Path (Join-Path $root "src\server.ts"))) {
    throw ("当前目录缺少 src\server.ts，确认是完整的仓库根目录（当前：" + $root + "）")
}
if (-not $DryRun) {
    $dockerCmd = Get-Command docker -ErrorAction SilentlyContinue
    if (-not $dockerCmd) {
        throw "未找到 docker 命令。镜像必须在装有 Docker 的机器上构建推送（本机没有 Docker，可先用 -DryRun 校验参数）。"
    }
}

Write-Host ""
Write-Host "==============================================" -ForegroundColor Cyan
Write-Host " 构建并推送镜像" -ForegroundColor Cyan
Write-Host "==============================================" -ForegroundColor Cyan
Write-Host (" 工作目录 : " + $root)
Write-Host (" 本地标签 : " + $localTag)
Write-Host (" 远程镜像 : " + $remoteTag)
if ($Platform -ne "") { Write-Host (" 目标架构 : " + $Platform) }
if ($PushLatest) { Write-Host (" 额外标签 : " + $remoteLatest) }
if ($DryRun) { Write-Host " 模式     : DRY-RUN（不会执行任何 docker 命令）" -ForegroundColor Yellow }
Write-Host ""

# ---------- 登录 ----------
if ($SkipLogin) {
    Write-Host "跳过登录（-SkipLogin）" -ForegroundColor DarkGray
} else {
    Write-Host "--> 登录仓库（若已登录可加 -SkipLogin）" -ForegroundColor Green
    Invoke-Docker -Arguments @("login", $Registry)
}

# ---------- 构建 ----------
if ($SkipBuild) {
    Write-Host "跳过构建（-SkipBuild），直接推送已有镜像" -ForegroundColor DarkGray
    Invoke-Docker -Arguments @("push", $remoteTag)
} elseif ($Platform -ne "") {
    Write-Host ("--> 跨平台构建并直接推送（" + $Platform + "）") -ForegroundColor Green
    Invoke-Docker -Arguments @("buildx", "build", "--platform", $Platform, "-t", $remoteTag, "--push", ".")
    Write-Host "注意：buildx 跨平台构建不会在本地留下镜像；如需本地运行请另用 docker build。" -ForegroundColor Yellow
} else {
    Write-Host "--> 构建镜像（本地 + 远程双标签）" -ForegroundColor Green
    Invoke-Docker -Arguments @("build", "-t", $localTag, "-t", $remoteTag, ".")

    Write-Host "--> 推送到仓库" -ForegroundColor Green
    Invoke-Docker -Arguments @("push", $remoteTag)
}

# ---------- latest ----------
if ($PushLatest) {
    Write-Host "--> 推送 latest 标签" -ForegroundColor Green
    Invoke-Docker -Arguments @("tag", $remoteTag, $remoteLatest)
    Invoke-Docker -Arguments @("push", $remoteLatest)
}

# ---------- 结果 ----------
Write-Host ""
Write-Host "==============================================" -ForegroundColor Cyan
if ($DryRun) {
    Write-Host " 干跑结束：以上命令均未执行" -ForegroundColor Yellow
} else {
    Write-Host " 推送完成" -ForegroundColor Green
    Write-Host (" 镜像 : " + $remoteTag)
    $digest = ""
    try {
        $digest = (& docker image inspect $remoteTag --format '{{index .RepoDigests 0}}' 2>$null)
    } catch {
        $digest = ""
    }
    if ($digest) { Write-Host (" 摘要 : " + $digest) }
    Write-Host ""
    Write-Host " 线上部署（服务器上执行）：" -ForegroundColor Cyan
    Write-Host ("   docker login " + $Registry)
    Write-Host "   docker compose pull && docker compose up -d"
}
Write-Host "==============================================" -ForegroundColor Cyan
Write-Host ""
Write-Host "提示：" -ForegroundColor Yellow
Write-Host (" 1) 服务器的 docker-compose.yml 里 image 应改为 " + $remoteTag + "，并删掉 build: 段")
Write-Host " 2) 迁移到新服务器时务必一起搬 data/ 目录，否则会生成新签名密钥（客户端全部验签失败）"
Write-Host " 3) 详细步骤见 docs/PUSH-IMAGE.md"
Write-Host ""
