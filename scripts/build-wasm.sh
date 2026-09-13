#!/usr/bin/env bash
# build-wasm.sh — 编译浏览器端单线程 xray.wasm
# 产物: 仓库根 xray.wasm (GOOS=js GOARCH=wasm, <25MiB)
set -e
cd "$(dirname "$0")/../wasm-src"

export GOOS=js
export GOARCH=wasm
export GOTOOLCHAIN=auto

OUT="$(cd .. && pwd)/xray.wasm"

echo "[build] go build (js/wasm, 单线程)…"
go build -trimpath -ldflags="-s -w" -o "$OUT" .

SIZE=$(stat -c%s "$OUT")
MIB=$(awk "BEGIN{printf \"%.2f\", $SIZE/1048576}")
echo "[build] 产物: $OUT ($MIB MiB)"

if [ "$SIZE" -ge $((25*1024*1024)) ]; then
  echo "[build] ✗ 超过 25MiB 上限！" && exit 1
fi

# 可选压缩（若装了 binaryen）
if command -v wasm-opt > /dev/null; then
  echo "[build] wasm-opt -Oz 压缩中（arm64 上较慢，耐心等）…"
  wasm-opt -Oz "$OUT" -o "$OUT.tmp" && mv "$OUT.tmp" "$OUT"
  SIZE2=$(stat -c%s "$OUT")
  echo "[build] 压缩后 $(awk "BEGIN{printf \"%.2f\", $SIZE2/1048576}") MiB"
else
  echo "[build] 未安装 wasm-opt，跳过压缩（可选: apt install binaryen）"
fi

echo "[build] 完成。验证: node scripts/test-wasm-node.mjs"
