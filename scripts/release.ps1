# Trae Usage Monitor 发布脚本
# 用法: .\scripts\release.ps1 -Version "1.0.1"

param(
    [Parameter(Mandatory=$true)]
    [string]$Version
)

# 验证版本格式
if ($Version -notmatch '^\d+\.\d+\.\d+$') {
    Write-Error "版本格式错误。请使用语义化版本格式，例如: 1.0.1"
    exit 1
}

# 检查是否在正确的目录
if (!(Test-Path "package.json")) {
    Write-Error "请在项目根目录运行此脚本"
    exit 1
}

# 读取当前package.json中的版本
$packageJson = Get-Content "package.json" | ConvertFrom-Json
$currentVersion = $packageJson.version

Write-Host "当前版本: $currentVersion" -ForegroundColor Yellow
Write-Host "新版本: $Version" -ForegroundColor Green

# 确认发布
$confirmation = Read-Host "确认发布版本 $Version 吗? (y/N)"
if ($confirmation -ne 'y' -and $confirmation -ne 'Y') {
    Write-Host "发布已取消" -ForegroundColor Red
    exit 0
}

try {
    # 更新package.json中的版本号
    Write-Host "更新package.json版本号..." -ForegroundColor Blue
    $packageJson.version = $Version
    $packageJson | ConvertTo-Json -Depth 100 | Set-Content "package.json"
    
    # 提交版本更改
    Write-Host "提交版本更改..." -ForegroundColor Blue
    git add package.json
    git commit -m "chore: bump version to $Version"
    
    # 创建并推送标签
    Write-Host "创建版本标签..." -ForegroundColor Blue
    git tag "v$Version"
    
    Write-Host "推送到远程仓库..." -ForegroundColor Blue
    git push origin main
    git push origin "v$Version"
    
    Write-Host "✅ 发布流程已启动!" -ForegroundColor Green
    Write-Host "请查看 GitHub Actions 页面监控构建和发布进度:" -ForegroundColor Cyan
    Write-Host "https://github.com/whyuds/TraeUsage/actions" -ForegroundColor Cyan
    
} catch {
    Write-Error "发布过程中出现错误: $($_.Exception.Message)"
    exit 1
}