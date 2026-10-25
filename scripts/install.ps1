# 一键初始化（Windows PowerShell）
# 只做三件事：检查 Node、复制配置模板、跑体检。不删任何东西。

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot

Write-Host "== astrbot-dsh 初始化 ==" -ForegroundColor Cyan
Write-Host "仓库目录：$root"

# 1. Node 版本
try {
    $nodeVersion = (& node -v) -replace '^v', ''
} catch {
    Write-Host "✗ 没找到 node，请先安装 Node.js >= 20.10" -ForegroundColor Red
    exit 1
}
$major = [int]($nodeVersion.Split('.')[0])
if ($major -lt 20) {
    Write-Host "✗ Node $nodeVersion 太旧，需要 >= 20.10" -ForegroundColor Red
    exit 1
}
Write-Host "✓ Node $nodeVersion"

# 2. 配置模板
$shimConfig = Join-Path $root 'dsh-shim\config.json'
if (-not (Test-Path $shimConfig)) {
    Copy-Item (Join-Path $root 'dsh-shim\config.example.json') $shimConfig
    Write-Host "✓ 生成 dsh-shim\config.json（记得填 token）" -ForegroundColor Green
} else {
    Write-Host "· dsh-shim\config.json 已存在，跳过"
}

$pluginConfig = Join-Path $root 'astrbot-plugin\config.json'
if (-not (Test-Path $pluginConfig)) {
    Copy-Item (Join-Path $root 'astrbot-plugin\config.json.example') $pluginConfig
    Write-Host "✓ 生成 astrbot-plugin\config.json（token 要与 shim 一致）" -ForegroundColor Green
} else {
    Write-Host "· astrbot-plugin\config.json 已存在，跳过"
}

# 3. 体检
Write-Host ""
Write-Host "== 体检 ==" -ForegroundColor Cyan
Push-Location (Join-Path $root 'dsh-shim')
try {
    & node src/doctor.mjs
} finally {
    Pop-Location
}

Write-Host ""
Write-Host "下一步：" -ForegroundColor Cyan
Write-Host "  1. 编辑 dsh-shim\config.json，设置 server.token"
Write-Host "  2. cd dsh-shim ; `$env:SHIM_TOKEN='你的token' ; npm start"
Write-Host "  3. 把 astrbot-plugin\ 拷到 AstrBot/data/plugins/dsh_bridge\"
Write-Host "  4. 重启 AstrBot，在 QQ 里发 /dsh health"
