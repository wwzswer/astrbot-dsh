#!/usr/bin/env bash
# 一键初始化（Linux / macOS）
# 只做三件事：检查 Node、复制配置模板、跑体检。不删任何东西。
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
echo "== astrbot-dsh 初始化 =="
echo "仓库目录：$root"

if ! command -v node >/dev/null 2>&1; then
  echo "✗ 没找到 node，请先安装 Node.js >= 20.10" >&2
  exit 1
fi

node_version="$(node -v | sed 's/^v//')"
major="${node_version%%.*}"
if [ "$major" -lt 20 ]; then
  echo "✗ Node $node_version 太旧，需要 >= 20.10" >&2
  exit 1
fi
echo "✓ Node $node_version"

if [ ! -f "$root/dsh-shim/config.json" ]; then
  cp "$root/dsh-shim/config.example.json" "$root/dsh-shim/config.json"
  echo "✓ 生成 dsh-shim/config.json（记得填 token）"
else
  echo "· dsh-shim/config.json 已存在，跳过"
fi

if [ ! -f "$root/astrbot-plugin/config.json" ]; then
  cp "$root/astrbot-plugin/config.json.example" "$root/astrbot-plugin/config.json"
  echo "✓ 生成 astrbot-plugin/config.json（token 要与 shim 一致）"
else
  echo "· astrbot-plugin/config.json 已存在，跳过"
fi

echo
echo "== 体检 =="
(cd "$root/dsh-shim" && node src/doctor.mjs)

cat <<'NEXT'

下一步：
  1. 编辑 dsh-shim/config.json，设置 server.token
  2. cd dsh-shim && SHIM_TOKEN=你的token npm start
  3. 把 astrbot-plugin/ 拷到 AstrBot/data/plugins/dsh_bridge/
  4. 重启 AstrBot，在 QQ 里发 /dsh health
NEXT
