// test-wasm-node.mjs — 无浏览器端到端测试：
// 用 Node 22 原生 WebSocket + WebAssembly 加载 xray.wasm，
// 连接真实 VLESS 节点并经隧道抓取一个页面。
//
// 用法: node scripts/test-wasm-node.mjs [wasm路径] [目标URL]
// 环境变量 TEST_ADDRESS/TEST_PORT/TEST_UUID/TEST_WSPATH/TEST_SNI 可覆盖预设节点

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const wasmPath = process.argv[2] || path.join(root, 'xray.wasm');
const targetURL = process.argv[3] || 'https://www.google.com/generate_204';

const CFG = {
  address: process.env.TEST_ADDRESS,
  port: parseInt(process.env.TEST_PORT || '443', 10),
  uuid: process.env.TEST_UUID,
  wsPath: process.env.TEST_WSPATH || '/',
  sni: process.env.TEST_SNI,
};

for (const k of ['address', 'uuid']) {
  if (!CFG[k]) {
    console.error(`✗ 缺少环境变量 TEST_${k.toUpperCase()}（测试脚本不内置任何真实节点）`);
    process.exit(1);
  }
}

if (!fs.existsSync(wasmPath)) {
  console.error(`✗ wasm 不存在: ${wasmPath}`);
  console.error('  先运行 scripts/build-wasm.sh 编译');
  process.exit(1);
}

// ── Node 环境 shim：让 Go 的 wasm_exec.js 满意 ──
import { webcrypto } from 'node:crypto';
if (!globalThis.crypto) globalThis.crypto = webcrypto;

const wasmBytes = fs.readFileSync(wasmPath);
console.log(`▸ wasm 大小: ${(wasmBytes.length / 1024 / 1024).toFixed(2)} MiB`);
if (wasmBytes.length >= 25 * 1024 * 1024) {
  console.error('✗ 超过 25MiB 上限');
  process.exit(1);
}

console.log('▸ 加载 wasm_exec.js …');
await import('../wasm_exec.js');

const go = new Go();
console.log('▸ 实例化 wasm (', (wasmBytes.length / 1024 / 1024).toFixed(1), 'MiB )…');
const t0 = Date.now();
const result = await WebAssembly.instantiate(wasmBytes, go.importObject);
go.run(result.instance);
console.log(`▸ Go 运行时启动 (${Date.now() - t0}ms)`);

for (const fn of ['xrayStart', 'xrayFetch', 'xrayStop']) {
  if (typeof globalThis[fn] !== 'function') {
    console.error(`✗ 缺少导出函数 ${fn} — 包装层未生效`);
    process.exit(1);
  }
}
console.log('✓ 导出检查通过: xrayStart/xrayFetch/xrayStop/xrayStats',
  typeof globalThis.xrayStats === 'function' ? '(+xrayStats)' : '');

// ── 启动隧道 ──
console.log(`▸ 连接节点 ${CFG.address}:${CFG.port} ws=${CFG.wsPath} sni=${CFG.sni} …`);
await globalThis.xrayStart(CFG);
console.log('✓ 隧道就绪');

// ── 经隧道抓取 ──
console.log(`▸ 经隧道请求 ${targetURL} …`);
const t1 = Date.now();
const resp = await globalThis.xrayFetch(targetURL);
const ms = Date.now() - t1;
const bodyBytes = resp.body ? (resp.body.length ?? resp.body.byteLength) : 0;
console.log(`✓ 响应 ${resp.status} · ${bodyBytes} B · ${ms}ms`);
console.log('  headers:', JSON.stringify(Object.fromEntries(
  Object.entries(resp.headers || {}).slice(0, 6)), null, 0));

if (resp.status >= 200 && resp.status < 400 && bodyBytes > 0) {
  const stats = globalThis.xrayStats ? globalThis.xrayStats() : {};
  console.log('✓ 流量统计:', JSON.stringify(stats));
  console.log('\n✅ 端到端成功：流量确实经过 VLESS 隧道');
  process.exit(0);
} else {
  console.error('\n✌ 响应异常（状态码或空 body）');
  process.exit(2);
}
