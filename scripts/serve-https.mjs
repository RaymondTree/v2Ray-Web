import https from 'https';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const PORT = parseInt(process.env.PORT || "12346", 10);
const HOST = '0.0.0.0';

const mime = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.wasm': 'application/wasm',
  '.json': 'application/json',
  '.md': 'text/markdown; charset=utf-8',
};

let cert, key;
try {
  throw new Error('skip selfsigned — use existing cert.pem/key.pem'); // npm 离线时 import 会挂起
  const mod = await import('selfsigned');
  const generate = mod.generate || mod.default?.generate || mod.default;
  if (typeof generate !== 'function') throw new Error('selfsigned generate not found');
  const attrs = [{ name: 'commonName', value: '127.0.0.1' }];
  const opts = {
    days: 365,
    keySize: 2048,
    algorithm: 'sha256',
    extensions: [
      {
        name: 'subjectAltName',
        altNames: [
          { type: 7, ip: '127.0.0.1' },
          { type: 7, ip: '::1' },
          { type: 2, value: 'localhost' },
        ],
      },
      { name: 'basicConstraints', cA: false },
      { name: 'keyUsage', digitalSignature: true, keyEncipherment: true },
      { name: 'extKeyUsage', serverAuth: true },
    ],
  };
  const pems = generate(attrs, opts);
  cert = pems.cert;
  key = pems.private || pems.key;
  if (!cert || !key) throw new Error('cert generation failed');
  console.log('[serve] selfsigned cert generated (with SAN 127.0.0.1/::1/localhost)');
} catch (e) {
  console.warn('[serve] selfsigned failed:', e.message);
  try {
    cert = fs.readFileSync(path.join(root, 'cert.pem'));
    key = fs.readFileSync(path.join(root, 'key.pem'));
    console.log('[serve] using existing cert.pem/key.pem');
  } catch {
    console.error('Missing cert. Run: openssl req -x509 -newkey rsa:2048 -nodes -keyout key.pem -out cert.pem -days 365 -subj "/CN=127.0.0.1" -addext "subjectAltName=IP:127.0.0.1,IP:::1,DNS:localhost"');
    process.exit(1);
  }
}

const server = https.createServer({ cert, key }, (req, res) => {
  try {
    let url = (req.url || '/').split('?')[0];
    url = decodeURIComponent(url);
    // 搜索和筛选路径：GitHub 原生表单提交，SW 拦不到 → 302 重定向到 __sw-proxy
    if (url === '/search' || url.startsWith('/search?') || url === '/_filter' || url.startsWith('/_filter/')) {
      const targetUrl = 'https://github.com' + (req.url || '');
      res.writeHead(302, { 'Location': '/__sw-proxy?u=' + encodeURIComponent(targetUrl) });
      res.end();
      return;
    }
    // /__sw-proxy 兜底：SW 未接管时，返回 JS 页面通知主线程重新发起代理
    if (url === '/__sw-proxy') {
      const rawU = (req.url || '').split('u=')[1] || '';
      const targetUrl = rawU ? decodeURIComponent(rawU).split('&_t=')[0] : '';
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`<!DOCTYPE html><html><body style="font-family:system-ui;padding:20px;color:#666">
SW 尚未接管，正在通知主线程代理...
<script>window.top && window.top.postMessage({type:'IFRAME_NAV', url:${JSON.stringify(targetUrl)}}, '*');</script>
</body></html>`);
      return;
    }
    if (url === '/') url = '/index.html';
    const file = path.normalize(path.join(root, url));
    if (!file.startsWith(root)) {
      res.writeHead(403, { 'Content-Type': 'text/plain' });
      res.end('forbidden');
      return;
    }
    if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('not found: ' + url);
      return;
    }
    const ext = path.extname(file).toLowerCase();
    const headers = {
      'Content-Type': mime[ext] || 'application/octet-stream',
      'Cache-Control': 'no-store',
    };
    if (url === '/sw.js') {
      // SW 必须以可执行的 JS MIME 返回（浏览器强校验）
      headers['Content-Type'] = 'application/javascript; charset=utf-8';
      headers['Service-Worker-Allowed'] = '/';
    }
    res.writeHead(200, headers);
    const stream = fs.createReadStream(file);
    stream.on('error', (err) => {
      console.error('[serve] stream error', err.message);
      if (!res.headersSent) res.writeHead(500);
      res.end('internal error');
    });
    stream.pipe(res);
  } catch (err) {
    console.error('[serve] handler error', err);
    if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'text/plain' });
    res.end('internal error');
  }
});

server.on('error', (err) => console.error('[serve] server error', err));


// ─── HTTP 模式（SW 在 http://127.0.0.1 也是安全上下文，绕过自签证书问题）───
// 默认 HTTP 模式（SW 需要 http://127.0.0.1 才能注册）
{

  const http = await import('http');
  const handler = (req, res) => {
    let url = (req.url || '/').split('?')[0];
    try { url = decodeURIComponent(url); } catch {}
    // 搜索和筛选路径：GitHub 原生表单提交，SW 拦不到 → 302 重定向到 __sw-proxy
    if (url === '/search' || url.startsWith('/search?') || url === '/_filter' || url.startsWith('/_filter/')) {
      const targetUrl = 'https://github.com' + (req.url || '');
      res.writeHead(302, { 'Location': '/__sw-proxy?u=' + encodeURIComponent(targetUrl) });
      res.end();
      return;
    }
    // /__sw-proxy 兜底：SW 未接管时，返回 JS 页面通知主线程重新发起代理
    if (url === '/__sw-proxy') {
      const rawU = (req.url || '').split('u=')[1] || '';
      const targetUrl = rawU ? decodeURIComponent(rawU).split('&_t=')[0] : '';
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`<!DOCTYPE html><html><body style="font-family:system-ui;padding:20px;color:#666">
SW 尚未接管，正在通知主线程代理...
<script>window.top && window.top.postMessage({type:'IFRAME_NAV', url:${JSON.stringify(targetUrl)}}, '*');</script>
</body></html>`);
      return;
    }
    if (url === '/') url = '/index.html';
    const file = path.normalize(path.join(root, url));
    if (!file.startsWith(root)) { res.writeHead(403); res.end('forbidden'); return; }
    if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404, {'Content-Type':'text/plain'}); res.end('not found: ' + url); return; }
    const ext = path.extname(file).toLowerCase();
    const headers = { 'Content-Type': mime[ext] || 'application/octet-stream', 'Cache-Control': 'no-store' };
    if (url === '/sw.js') {
      headers['Content-Type'] = 'application/javascript; charset=utf-8';
      headers['Service-Worker-Allowed'] = '/';
    }
    res.writeHead(200, headers);
    fs.createReadStream(file).pipe(res);
  };
  http.createServer(handler).listen(PORT, HOST, () => {
    console.log(`[serve] HTTP mode: Serving http://127.0.0.1:${PORT}  （Service Worker 可正常注册）`);
  });
}

// ─── 附带 HTTPS 入口（12346）：老书签 https://127.0.0.1:12345 的补救 ──────
// 无法在 12345 上同时说两种协议；在 4443/12346 起 https，纯 302 引导到 http。
try {
  const certFile = path.join(root, 'cert.pem');
  const keyFile = path.join(root, 'key.pem');
  if (fs.existsSync(certFile) && fs.existsSync(keyFile)) {
    const httpMod = await import('http');
    const httpsMod = await import('https');
    const redirectHttps = httpsMod.createServer({ cert: fs.readFileSync(certFile), key: fs.readFileSync(keyFile) }, (req, res) => {
      res.writeHead(302, { Location: `http://127.0.0.1:${PORT}${req.url}` });
      res.end();
    });
    redirectHttps.listen(12443, HOST, () => console.log('[serve] https://127.0.0.1:12443 → 302 → http://127.0.0.1:' + PORT));
    redirectHttps.on('error', () => {});
  }
} catch {}

// 老书签还指向 https://127.0.0.1:12345 —— 在同端口上再挂一个"TLS 探测 + 302"
// 做不到（同一 socket 不能既说 TLS 又说明文）。退而求其次：
// HTTP 主服务保持不变，用户需手动用 http:// 访问。

