// worker.js - VLESS shim (纯标准库实现，无 xray-core)
let connected = false, cfg = null, bytesUp = 0, bytesDown = 0;
function log(l, m) { postMessage({ type: 'LOG', level: l, msg: m, ts: Date.now() }); }
function setStatus(s, e) { postMessage({ type: 'STATUS', state: s, error: e }); }
function pushStats() { postMessage({ type: 'STATS', bytesUp, bytesDown }); }
setInterval(pushStats, 1000);

let wasmInitPromise = null;
async function initWasm() {
  if (wasmInitPromise) return wasmInitPromise; // 幂等：只初始化一次
  wasmInitPromise = (async () => {
    await doInitWasm();
  })();
  return wasmInitPromise;
}

async function doInitWasm() {
  try {
    const resp = await fetch('xray.wasm');
    if (!resp.ok) throw new Error('fetch wasm HTTP ' + resp.status);
    const buf = await resp.arrayBuffer();
    importScripts('wasm_exec.js');
    const go = new Go();
    const result = await WebAssembly.instantiate(buf, go.importObject);
    // 把 Go 侧 console.log（[vless-go] 前缀）转发到主线程日志面板
    const origLog = console.log.bind(console);
    console.log = (...args) => {
      const s = args.join(' ');
      if (s.includes('[vless-go]')) log('info', s.replace('[vless-go] ', ''));
      origLog(...args);
    };
    go.run(result.instance);
    if (typeof globalThis.xrayStart !== 'function') throw new Error('xrayStart not exported');
    postMessage({ type: 'WASM_READY' });
    log('info', 'VLESS 内核就绪 (xrayStart/xrayFetch/xrayStop)');
  } catch (e) {
    postMessage({ type: 'WASM_ERROR', error: e.message });
    log('error', 'WASM 加载失败: ' + e.message);
  }
}

async function connectTunnel(data) {
  setStatus('connecting');
  await initWasm();
  if (typeof globalThis.xrayStart !== 'function') {
    setStatus('failed', 'WASM 未就绪');
    return;
  }
  try {
    await globalThis.xrayStart(data);
    cfg = data;
    connected = true;
    setStatus('connected');
    log('info', 'VLESS 隧道已建立');
  } catch (e) {
    setStatus('failed', String(e));
    log('error', '连接失败: ' + e.message);
  }
}

function disconnectTunnel() {
  try { if (typeof globalThis.xrayStop === 'function') globalThis.xrayStop(); } catch (e) {}
  connected = false;
  cfg = null;
  setStatus('idle');
  log('info', '已断开');
}

async function proxyFetch(id, url, method, headers, body) {
  log('info', `[DEBUG] proxyFetch id=${id} url=${JSON.stringify(url)} method=${method} connected=${connected}`);
  if (!connected) { postMessage({ type: 'PROXY_RESPONSE', id, error: '未连接' }); return; }
  if (!url || url === 'null' || url === 'undefined' || !url.startsWith('http')) {
    log('warn', `[DEBUG] proxyFetch 跳过无效 url: ${JSON.stringify(url)}`);
    postMessage({ type: 'PROXY_RESPONSE', id, error: 'invalid url: ' + url });
    return;
  }
  log('info', `代理请求: ${url}`);
  const start = Date.now();
  try {
    // body 需转 ArrayBuffer（Go 端按 ArrayBuffer 读取）
    let goBody = null;
    if (body) {
      goBody = body instanceof ArrayBuffer ? body : (body.buffer || body);
    }
    const res = await globalThis.xrayFetch(url, { method: method || 'GET', headers: headers || {}, body: goBody });
    let respBody = res.body;
    if (respBody instanceof Uint8Array) respBody = respBody.buffer.slice(respBody.byteOffset, respBody.byteOffset + respBody.byteLength);
    const hdrs = res.headers || {};
    bytesDown += respBody.byteLength; bytesUp += 512;
    pushStats();
    log('info', `响应 ${res.status} (VLESS 隧道) ${url} ${Date.now()-start}ms ${respBody.byteLength}B`);
    postMessage({ type: 'PROXY_RESPONSE', id, status: res.status, headers: hdrs, body: respBody }, [respBody]);
  } catch (e) {
    log('warn', `VLESS 隧道失败: ${e && e.message ? e.message : String(e)}`);
    postMessage({ type: 'PROXY_RESPONSE', id, error: String(e) });
  }
}

onmessage = async e => {
  const m = e.data;
  if (m.type === 'INIT_WASM') await initWasm();
  if (m.type === 'CONNECT') await connectTunnel(m.payload);
  if (m.type === 'DISCONNECT') disconnectTunnel();
  if (m.type === 'PROXY_FETCH') await proxyFetch(m.id, m.url, m.method, m.headers, m.body);
};
