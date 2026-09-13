// sw.js - 把页面内资源请求经主线程转发到 VLESS 隧道
// 拦截路径：/__sw-proxy?u=<encodeURIComponent(目标URL)>

let mainPort = null;
let __swBaseUrl = '';   // 当前 iframe 所代理的真实目标 URL（由主线程 SW_NAV 消息更新）
// 备用：通过 BroadcastChannel 接收
let _bcChannel = null;
try {
  _bcChannel = new BroadcastChannel('sw-target');
  _bcChannel.onmessage = (ev) => {
    if (ev.data && ev.data.type === 'TARGET') {
      __swBaseUrl = ev.data.url || '';
      console.log('[sw] BC TARGET:', __swBaseUrl.slice(0, 80));
    }
  };
} catch(_) {}
// 备用：从 localStorage 读取（比 postMessage 更可靠）
function getStoredTarget() {
  try { return localStorage.getItem('__sw_target') || ''; } catch(_) { return ''; }
}
const pending = new Map();
let seq = 0;
// 主线程的 SW_PORT 握手可能晚于本 SW 收到的第一个 fetch（页面加载竞态、
// 或 SW 刚换版本接管而主线程尚未重发握手）。此时不立即失败，排队等待；
// 超过 15s 仍未收到才判失败。
const portWaiters = [];
function waitForPort(timeoutMs){
  return new Promise((resolve) => {
    if(mainPort){ resolve(mainPort); return; }
    const t = setTimeout(() => {
      const i = portWaiters.indexOf(fn); if(i >= 0) portWaiters.splice(i, 1);
      resolve(null);
    }, timeoutMs);
    const fn = () => { clearTimeout(t); resolve(mainPort); };
    portWaiters.push(fn);
  });
}

self.addEventListener('install', (e) => self.skipWaiting());
// activate 统一在下方 CDN_CACHE 定义之后注册（需清理旧缓存桶 + claim）

self.addEventListener('message', (ev) => {
  const data = ev.data;
  if (data && data.type === 'SW_PORT') {
    mainPort = ev.ports[0];
    mainPort.onmessage = (e2) => {
      const m = e2.data;
      if (m && pending.has(m.id)) {
        const { resolve } = pending.get(m.id);
        pending.delete(m.id);
        resolve(m);
      }
    };
    // 唤醒所有等待握手的请求
    portWaiters.splice(0).forEach((f) => f());
  }
  if (data && data.type === 'SW_NAV') {
    // 主线程通知当前 iframe 代理的是哪个真实 URL，用于还原相对路径请求
    __swBaseUrl = data.url || '';
    console.log('[sw] NAV:', __swBaseUrl.slice(0, 80));
  }
  if (data && data.type === 'SW_DIAG') {
    (async () => {
      const send = (obj) => {
        try { if (ev.ports && ev.ports[0]) ev.ports[0].postMessage(obj); } catch (_) {}
        try { ev.source.postMessage(obj); } catch (_) {}
      };
      try {
        const cache = await caches.open(CDN_CACHE);
        const keys = await cache.keys();
        send({ type: 'SW_DIAG_REPLY', cacheHits, cacheStores, cachePutError, cachedCount: keys.length, sampleKeys: keys.slice(0, 5).map(k => k.url) });
      } catch (e) {
        send({ type: 'SW_DIAG_REPLY', error: String(e && e.message ? e.message : e) });
      }
    })();
  }
});

function proxyViaMain(targetUrl, method, headers, body) {
  return new Promise((resolve, reject) => {
    if (!mainPort) return reject(new Error('main port not ready'));
    const id = 'r' + (++seq);
    pending.set(id, { resolve });
    setTimeout(() => {
      if (pending.has(id)) { pending.delete(id); reject(new Error('proxy timeout: ' + targetUrl)); }
    }, 90000);
    try {
      mainPort.postMessage({ id, type: 'PROXY_FETCH', url: targetUrl, method, headers, body });
    } catch (e) {
      pending.delete(id);
      reject(e);
    }
  });
}

// 我们自己的源上合法存在的文件（页面自身资源），除此之外的同源请求都视为
// 代理页面里漏出来的相对路径 → 还原后走隧道
const LOCAL_FILES = new Set(['/', '/index.html', '/app.js', '/worker.js', '/sw.js', '/wasm_exec.js', '/style.css', '/xray.wasm', '/favicon.ico']);

// ─── CDN 静态资源缓存 ──────────────────────────────────────────────────────
// 主页/搜索页大量共用同 CDN 的 CSS/JS/字体（URL 带内容哈希、不可变）。
// 每次导航都重新走隧道下载全部资源是搜索页慢的主因。把这些 200 响应缓存到
// Cache Storage，后续请求 cache-first，直接命中本地，省掉隧道下载。
// 只缓存可判"不可变"的 CDN host，绝不动主文档（www.baidu.com/s?wd= 是动态结果）。
// ⚠️ v2：v1 桶里可能存有残缺响应（历史 bug：缓存副本与页面响应共享同一流，
// 页面侧 1 字节 → 缓存里 1 字节 CSS → 样式全失效 → 图片"变大"）。
// activate 会删除所有旧 v2ray-cdn* 桶，本文件首次接管即清掉污染缓存。
const CDN_CACHE = 'v2ray-cdn-v2';
const CDN_HOST_RE = /\.(bdstatic|bcebos|githubassets|gstatic|jsdelivr|unpkg|cloudfront|akamaihd|akamai|fastly|bootcdn|staticfile)\./;
function isCacheable(targetUrl){
  try{
    const h = new URL(targetUrl).hostname;
    return CDN_HOST_RE.test(h);
  }catch(e){ return false; }
}

self.addEventListener('activate', (e) => {
  // 清掉旧版本的缓存桶，再 claim
  e.waitUntil((async () => {
    try{
      const keys = await caches.keys();
      await Promise.all(keys.filter(k => k.startsWith('v2ray-cdn') && k !== CDN_CACHE).map(k => caches.delete(k)));
    }catch(_e){}
    self.clients.claim();
  })());
});

// ─── 遥测/埋点噪音拦截 ─────────────────────────────────────────────────────
// 浏览器后台不停发的统计/广告请求。每个都要占一个并发槽 + 付一次全量
// WS 握手（~1.5s 起步），把真实内容挤出排队区。直接回 204：遥测库认为
// 成功不重试，且这些请求与页面内容零关系。精确按 host 匹配，避免误伤
// 正常域名（google.com / bing.com / baidu.com 主站等一律放行）。
const TELE_HOSTS = new Set([
  'collector.github.com',                       // GitHub 行为遥测（404 刷屏元凶）
  'google-analytics.com', 'ssl.google-analytics.com', 'stats.google.com',
  'adservice.google.com', 'googleadservices.com',
  'doubleclick.net', 'amazon-adsystem.com', 'scorecardresearch.com',
  'bat.bing.com',
  'analytics.twitter.com', 'syndication.twitter.com', 'platform.twitter.com',
  'connect.facebook.net', 'fbcdn.net', 'facebook.net',
  'sentry.io', 'segment.io', 'mixpanel.com', 'hotjar.com', 'optimizely.com',
  'cloudflareinsights.com', 'quantserve.com',
  'tongji.baidu.com', 'hm.baidu.com',            // 百度统计（纯遥测）
  'mbd.baidu.com', 'nsclick.baidu.com', 'fclick.baidu.com',  // 百度行为/点击打点
]);
// ⚠️ 绝不可加进黑名单（会 204 掉真实内容，导致图片/字体/JS 加载不出来）：
//   gips0-3.baidu.com / t1-t9.baidu.com（/it/u= 图片）、gimg*.baidu.com（百科图）、
//   psstatic.cdn.bcebos.com（静态资产）、hector*/baidu.com、www.baidu.com、
//   pss.bdstatic.com（CSS/JS/字体）。百度"sp1/sp2"的 v.gif 是打点但域名也可能
//   出图，保守起见不整域拉黑。
// 相对路径漏出（同域 127.0.0.1）时没有 host 可判，用 GitHub 内部遥测路径兜底
const TELE_REL_PATHS = new Set([
  '/_private/browser/stats',
  '/_private/dashboard/stats',
]);
let cacheHits = 0, cacheStores = 0;
let cachePutError = null;   // 记录最近一次 cache.put 的异常，供诊断
let teleBlocked = 0;
function isTelemetry(target){
  try{
    const u = new URL(target);
    const h = u.hostname;
    if (TELE_HOSTS.has(h)) return true;
    if (/(^|\.)google-analytics\.com$/.test(h)) return true;
    if (/(^|\.)ingest\.sentry\.io$/.test(h)) return true;   // o123.ingest.sentry.io
    if ((h === 'api.github.com' || h === 'github.com') && u.pathname.startsWith('/_private/')) return true;
    return false;
  }catch(e){
    // 相对路径（同域漏出）：去掉 query 再比对
    return TELE_REL_PATHS.has(String(target).split('?')[0]);
  }
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);
  const sameOrigin = url.origin === self.location.origin;
  // 非 http(s)（扩展、blob 等）放行
  if (!/^https?:$/.test(url.protocol)) return;
  if (sameOrigin) {
    if (LOCAL_FILES.has(url.pathname)) return;          // 页面自身资源 → 放行
    if (url.pathname.startsWith('/__sw-proxy')) { /* 标准代理路径 */ }
    else if (!url.search.includes('_t=')) { /* 漏出的相对路径 → 继续走还原 */ }
  }
  // 特殊处理：搜索相关路径直接转发到 github.com（如果 base 已设置）
  if (sameOrigin && (url.pathname === '/search' || url.pathname.startsWith('/search?'))) {
    if (__swBaseUrl || getStoredTarget()) {
      const base = __swBaseUrl || getStoredTarget();
      const targetUrl = new URL(url.pathname + url.search, base).href;
      console.log('[sw] SEARCH FORCE:', url.pathname + url.search, '→', targetUrl.slice(0,100));
      event.respondWith(proxyViaMain(targetUrl, req.method, Object.fromEntries(req.headers), null));
      return;
    }
  }
  // 添加所有相对路径请求的日志（包括 /search）
  if (sameOrigin && url.pathname.startsWith('/')) {
    console.log('[sw] ALL REL PATH:', url.pathname + url.search, 'from:', url.href.slice(0,100));
  }
  console.log('[sw] INTERCEPT:', req.method, url.href.slice(0, 120), 'sameOrigin:', sameOrigin);

  event.respondWith((async () => {
    try {
      let targetUrl;
      if (sameOrigin) {
        const rawU = url.searchParams.get('u');
        if (rawU) {
          // 标准代理路径：/__sw-proxy?u=<encodeURIComponent(绝对URL)>
          // searchParams.get 已解码一次，切勿再 decodeURIComponent ——
          // 那会把目标 URL 内层的合法百分号编码（如百度 gimg 的
          // src=https%3A%2F%2Fbkimg...）二次解码成 ://，导致源站 400。
          targetUrl = rawU;
        } else {
          // 兜底：页面内相对路径请求（JS 动态创建的 script/img/fetch、表单提交等）
          // 从 Referer 里恢复真实 base，把路径解析成绝对 URL
          // 相对路径请求：交给主线程用地址栏 URL 作基准还原
          // （SW 拿不到 iframe location；Referer 可能被 Referrer-Policy 剥掉）
          const relPath = url.pathname + url.search;
          console.log('[sw] REL path detected:', relPath.slice(0,80), '| __swBaseUrl:', __swBaseUrl.slice(0,60), '| stored:', getStoredTarget().slice(0,60));
          if (__swBaseUrl || getStoredTarget()) {
            const base = __swBaseUrl || getStoredTarget();
            try {
              targetUrl = new URL(relPath, base).href;
              console.log('[sw] REL→ABS:', relPath.slice(0,60), '→', targetUrl.slice(0,100));
            } catch (_e) {
              targetUrl = relPath;
            }
          } else {
            targetUrl = relPath;
            console.log('[sw] NO BASE available for:', relPath.slice(0,60));
          }
          // 硬编码修复：如果 targetUrl 仍然是相对路径且是搜索相关路径，强制用 github.com
          if ((targetUrl.startsWith('/') || targetUrl.startsWith('http://127.0.0.1')) &&
              (targetUrl.includes('/search') || targetUrl.includes('/search?q='))) {
            const urlObj = new URL(targetUrl, 'https://github.com');
            targetUrl = urlObj.href;
            console.log('[sw] FORCE github.com for search:', targetUrl);
          }
        }
      } else {
        targetUrl = req.url;
      }
      console.log('[sw] targetUrl:', JSON.stringify(targetUrl).slice(0,140));
      // 遥测噪音：直接 204 返回，不读 body、不进隧道、不占并发槽
      if (isTelemetry(targetUrl)) {
        teleBlocked++;
        console.log(`[sw] TELE-BLOCK #${teleBlocked}: ${targetUrl.slice(0,80)} (204, 不走隧道)`);
        return new Response(null, { status: 204, statusText: 'No Content' });
      }
      const headers = {};
      req.headers.forEach((v, k) => { headers[k] = v; });
      let body = null;
      if (req.method !== 'GET' && req.method !== 'HEAD') body = await req.arrayBuffer();

      // CDN 静态资源缓存：cache-first。命中则完全不走隧道，
      // 这是搜索页提速最大的一刀（主页/搜索页共用大量 CSS/JS/字体）。
      if (req.method === 'GET' && isCacheable(targetUrl)) {
        try {
          const cache = await caches.open(CDN_CACHE);
          const hit = await cache.match(targetUrl);
          if (hit) {
            cacheHits++;
            console.log(`[sw] CACHE-HIT #${cacheHits}: ${targetUrl.slice(0,80)}`);
            return hit;
          }
        } catch (_e) {}
      }

      // 所有到达这里的请求都交给主线程：绝对 URL 直接代理；
      // 相对路径由主线程用地址栏 URL 还原后再代理（还原失败会返回错误响应）。
      if (!mainPort) mainPort = await waitForPort(15000);
      if (!mainPort) throw new Error('main port not ready (等待 15s 仍未收到主线程通道，刷新一次)');
      const resp = await proxyViaMain(targetUrl, req.method, headers, body);
      console.log('[sw] proxied:', targetUrl.slice(0, 80), '→', resp.status);
      let buf;
      if (resp.bodyBuffer instanceof ArrayBuffer || ArrayBuffer.isView(resp.bodyBuffer)) buf = resp.bodyBuffer;
      else buf = new TextEncoder().encode(resp.bodyText || '').buffer;
      // 剥离会阻止嵌入/限制代理页面的安全头
      // CSP 整条删除：目标站的资源白名单（如 script-src github.githubassets.com）
      // 对重写后的同源 URL 全部失效，保留只会误拦
      const respHeaders = Object.assign({}, resp.headers || {});
      delete respHeaders['x-frame-options'];
      delete respHeaders['content-security-policy'];
      const out = new Response(buf, { status: resp.status || 502, statusText: '', headers: respHeaders });
      // 仅缓存成功的 GET 静态资源（CDN 域，URL 不可变）。
      // 跨源写入 Cache Storage 要求响应带 Access-Control-Allow-Origin，
      // 否则 cache.put 抛 InvalidStateError。
      // ⚠️ 关键：必须用 out.clone() 生成独立流——Response.body 是
      // ReadableStream，若缓存副本与页面响应共享同一流，两者争抢消费，
      // 页面拿到的 body 会被截断（CSS 只剩 1 字节 → 样式全失效）。
      if (req.method === 'GET' && (resp.status || 502) === 200 && isCacheable(targetUrl)) {
        // 防御：绝不缓存 0 字节/异常短小响应（上游半截数据会污染缓存）
        if (buf.byteLength > 0) {
          try {
          const target = new URL(targetUrl);
          const crossOrigin = target.origin !== self.location.origin;
          const clone = out.clone();
          const cacheable = crossOrigin
            ? new Response(clone.body, { status: out.status, statusText: out.statusText, headers: Object.assign({}, respHeaders, { 'access-control-allow-origin': '*' }) })
            : clone;
          const cache = await caches.open(CDN_CACHE);
          await cache.put(targetUrl, cacheable);
          cacheStores++;
          console.log(`[sw] CACHE-STORE #${cacheStores}: ${targetUrl.slice(0,80)}`);
        } catch (_e) {
          cachePutError = String(_e && _e.message ? _e.message : _e);
          console.warn('[sw] CACHE-STORE failed:', cachePutError);
        }
        }
      }
      return out;
    } catch (e) {
      return new Response(String(e), { status: 502, headers: { 'content-type': 'text/plain' } });
    }
  })());
});
