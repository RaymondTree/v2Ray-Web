// v2Ray-on-Browser - 主线程

// 解析 vless://uuid@host:port?params 链接，返回 VlessConfig 或 null
function parseVless(link){
  try{
    link=link.trim();
    if(!link.toLowerCase().startsWith('vless://')) return null;
    // 处理 vless 链接中以 &amp; 编码的情况
    link=link.replace(/&amp;/g,'&');
    const u=new URL(link);
    const uuid=decodeURIComponent(u.username || u.pathname.replace(/^\/\//,'').split('@')[0] || '');
    // URL 解析对 vless 不完全兼容，手动回退解析
    let hostPort = u.host;
    let uuid2=uuid;
    if(!hostPort || !uuid2){
      const m=link.match(/^vless:\/\/([^@]+)@([^:/?#]+):(\d+)/i);
      if(m){ uuid2=m[1]; hostPort=m[2]+':'+m[3]; }
    }
    const address = u.hostname || hostPort.split(':')[0] || '';
    const port = parseInt(u.port || hostPort.split(':')[1] || '443',10);
    const wsPath = u.searchParams.get('path') || '/';
    const sni = u.searchParams.get('sni') || u.searchParams.get('peer') || u.searchParams.get('host') || address;
    // uuid 可能含在 username
    const finalUuid = uuid2 || u.username;
    if(!finalUuid || !address) return null;
    return { address, port, uuid: finalUuid, wsPath: decodeURIComponent(wsPath), sni };
  }catch{ return null; }
}

const LS_KEY = "v2ray-custom-nodes";

const els = {
  address: document.getElementById('inpAddress'),
  port: document.getElementById('inpPort'),
  uuid: document.getElementById('inpUuid'),
  wsPath: document.getElementById('inpWsPath'),
  sni: document.getElementById('inpSni'),
  badge: document.getElementById('statusBadge'),
  btnConnect: document.getElementById('btnConnect'),
  btnDisconnect: document.getElementById('btnDisconnect'),
  btnSaveConfig: document.getElementById('btnSaveConfig'),
  btnExportCfg: document.getElementById('btnExportCfg'),
  btnImportCfg: document.getElementById('btnImportCfg'),
  inpUrl: document.getElementById('inpUrl'),
  btnGo: document.getElementById('btnGo'),
  btnBack: document.getElementById('btnBack'),
  btnForward: document.getElementById('btnForward'),
  btnRefresh: document.getElementById('btnRefresh'),
  btnFullscreen: document.getElementById('btnFullscreen'),
  browserBar: document.getElementById('browserBar'),
  browserCard: document.getElementById('browserCard'),
  browserView: document.getElementById('browserView'),
  browserStatus: document.getElementById('browserStatus'),
  logPanel: document.getElementById('logPanel'),
  logFilter: document.getElementById('logFilter'),
  btnClearLog: document.getElementById('btnClearLog'),
  btnExportLog: document.getElementById('btnExportLog'),
  statUp: document.getElementById('statUp'),
  statDown: document.getElementById('statDown'),
  statReq: document.getElementById('statReq'),
};

let state = "idle"; // idle|connecting|connected|failed
let worker;
let bytesUp = 0, bytesDown = 0, reqCount = 0;
let historyStack = ["https://example.com"];
let historyIndex = 0;
let logs = [];

function formatBytes(n){
  if(n<1024) return n+' B';
  if(n<1024*1024) return (n/1024).toFixed(1)+' KB';
  return (n/1024/1024).toFixed(2)+' MB';
}

function pushLog(level, msg){
  const entry = {level, msg, ts: Date.now()};
  logs.push(entry);
  if(logs.length>1000) logs.shift();
  renderLogs();
  if(level==='error') console.error(msg);
}
function renderLogs(){
  const filter = els.logFilter.value;
  els.logPanel.innerHTML = '';
  logs.filter(l=>filter==='all'||l.level===filter).slice(-300).forEach(l=>{
    const div=document.createElement('div');
    div.className=`log-line ${l.level}`;
    const t=new Date(l.ts).toLocaleTimeString();
    div.textContent=`[${t}] [${l.level}] ${l.msg}`;
    els.logPanel.appendChild(div);
  });
  els.logPanel.scrollTop = els.logPanel.scrollHeight;
}

function setStatus(s, err){
  state=s;
  els.badge.textContent = {idle:'未连接', connecting:'连接中', connected:'已连接', failed:'连接失败'}[s];
  els.badge.className='badge '+s;
  els.btnConnect.disabled = s==='connecting'||s==='connected';
  els.btnDisconnect.disabled = s!=='connected'&&s!=='connecting';
  [els.address, els.port, els.uuid, els.wsPath, els.sni].forEach(i=> i.disabled = s==='connected' || s==='connecting');
  if(err) pushLog('error', err);
}

function getFormConfig(){
  return {
    address: els.address.value.trim(),
    port: parseInt(els.port.value,10),
    uuid: els.uuid.value.trim(),
    wsPath: els.wsPath.value.trim()||"/",
    sni: els.sni.value.trim()||els.address.value.trim(),
  };
}
function setFormConfig(c){
  els.address.value=c.address||"";
  els.port.value=c.port||"";
  els.uuid.value=c.uuid||"";
  els.wsPath.value=c.wsPath||"/";
  els.sni.value=c.sni||"";
}
function validate(cfg){
  if(!cfg.address) return "地址不能为空";
  if(!cfg.port||cfg.port<1||cfg.port>65535) return "端口需 1-65535";
  const uuidRe=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if(!uuidRe.test(cfg.uuid)) return "UUID 格式不正确";
  if(!cfg.wsPath.startsWith("/")) return "WebSocket 路径需以 / 开头";
  if(cfg.sni && !/^([a-z0-9-]+\.)+[a-z]{2,}$/i.test(cfg.sni) && !/^\d+\.\d+\.\d+\.\d+$/.test(cfg.sni)) return "SNI 格式不正确";
  return null;
}

const LS_URL = "v2ray-last-url";
function saveCustom(){
  localStorage.setItem(LS_KEY, JSON.stringify(getFormConfig()));
}
function saveUrl(){
  try{ localStorage.setItem(LS_URL, els.inpUrl.value.trim()); }catch{}
}
function loadUrl(){
  try{
    const v=localStorage.getItem(LS_URL);
    if(v) els.inpUrl.value=v;
  }catch{}
}
function loadCustom(){
  try{
    const v=JSON.parse(localStorage.getItem(LS_KEY)||"null");
    if(v) setFormConfig(v);
  }catch{}
}

// Worker bridge
function initWorker(){
  worker = new Worker('worker.js');
  worker.onmessage = (e)=>{
    const m=e.data;
    if(m.type==='WASM_READY'){ pushLog('info','WASM 加载成功'); }
    if(m.type==='WASM_ERROR'){ pushLog('error','WASM 错误: '+m.error); }
    if(m.type==='STATUS'){ setStatus(m.state, m.error); if(m.state==='connected') pushLog('info','隧道已建立'); if(m.state==='failed') pushLog('error','连接失败: '+(m.error||'')); }
    if(m.type==='LOG'){ pushLog(m.level, m.msg); }
    if(m.type==='STATS'){ bytesUp=m.bytesUp; bytesDown=m.bytesDown; els.statUp.textContent=formatBytes(bytesUp); els.statDown.textContent=formatBytes(bytesDown); }
    if(m.type==='PROXY_RESPONSE'){ handleProxyResponse(m); }
  };
  worker.onerror=(e)=>{ pushLog('error','Worker 异常: '+e.message); setStatus('failed', e.message); };
  worker.postMessage({type:'INIT_WASM'});
  pushLog('info','Worker 已启动，正在加载 WASM…');
}

let pendingFetches = new Map();
const resourceExt=/\.(js|css|woff2?|png|jpe?g|gif|svg|webp|ico|mp4|webm|mp3|pdf|json|map)(\?|$)/i;
// 用于主线程和 SW 共享目标 URL 的广播通道
let _swChannel = null;
try { _swChannel = new BroadcastChannel('sw-target'); } catch(_) {}

// 页面导航：iframe 直接指向 SW 代理路径（SW 拦截 → 隧道 → 主线程重写 HTML）
// srcdoc 会导致 <script type="module"> 无法解析相对路径，必须用真实 src
let _currentProxyTarget = ''; // 当前 iframe 代理的真实目标 URL（用于向 iframe 注入 __swBase）
function proxyFetch(url){
  if(!swReady){ pushLog('warn','Service Worker 未就绪，无法代理浏览'); els.browserStatus.textContent='SW 未就绪'; return; }
  if(state!=='connected'){ pushLog('warn','未连接，无法代理请求: '+url); els.browserStatus.textContent='未连接'; return; }
  reqCount++; els.statReq.textContent=reqCount;
  pushLog('info',`HTTP ${url}`);
  els.browserStatus.textContent='加载中…';
  const u = new URL(url, window.location.href);
  // 如果是代理 URL，提取真实目标 URL 显示在地址栏
  let displayUrl = url;
  if(url.startsWith('/__sw-proxy')){
    try{
      const rawU = u.searchParams.get('u');
      if(rawU) displayUrl = rawU;
    }catch(_e){}
  }
  _currentProxyTarget = displayUrl;
  els.inpUrl.value = displayUrl;
  saveUrl();
  // 通知 SW 当前代理页面的真实目标 URL，用于还原相对路径请求
  try{ swPort && swPort.postMessage({type:'SW_NAV', url:displayUrl}); }catch(_e){}
  // 通过 BroadcastChannel 发送给 SW（比 localStorage 更可靠）
  try{ _swChannel?.postMessage({type:'TARGET', url:displayUrl}); }catch(_e){}
  // 存储到 localStorage（备用）
  try{ localStorage.setItem('__sw_target', displayUrl); }catch(_e){}
  // 主路径：worker 隧道抓取 HTML → srcdoc 渲染。
  // 不用 iframe.src：top-level 文档导航 Chrome SW 不拦截，会落到服务器兜底页。
  // srcdoc 的子资源请求（fetch/img/script）仍会被 SW 正常拦截代理。
  els.browserStatus.textContent='抓取中…';
  const fetchId = Math.random().toString(36).slice(2);
  pendingFetches.set(fetchId, {
    url: displayUrl,
    resolve: (resp) => {
      els.browserStatus.textContent='已加载';
      if(resp.error || !resp.body){ pushLog('warn','页面抓取失败: '+displayUrl); return; }
      const ct = ((resp.headers?.['content-type'])||'').toLowerCase();
      if(!ct.includes('text/html') || resourceExt.test(displayUrl)) return;
      try{
        const processed = processHtml(displayUrl, resp.body);
        const html = new TextDecoder().decode(processed.body);
        els.browserView.srcdoc = html;
        console.log('[main] srcdoc rendered:', displayUrl.slice(0,80));
      }catch(e){ pushLog('warn','HTML 渲染失败: '+e.message); }
    }
  });
  worker.postMessage({type:'PROXY_FETCH', id: fetchId, url: displayUrl, method:'GET'});
}

// iframe load 后：直接向 iframe document 注入 __swBase 脚本，确保 hook 能正确解析相对路径
els.browserView.addEventListener('load', function(){
  try{
    const doc = els.browserView.contentDocument || els.browserView.contentWindow?.document;
    if(!doc || !_currentProxyTarget) return;
    const s = doc.createElement('script');
    s.textContent = 'try{window.__swBase=' + JSON.stringify(_currentProxyTarget) + ';}catch(e){}';
    (doc.head || doc.documentElement).appendChild(s);
    console.log('[main] injected __swBase into iframe:', _currentProxyTarget.slice(0,80));
  }catch(e){ console.log('[main] iframe inject failed:', e.message); }
});

// SW 资源/页面请求：隧道抓取，HTML 在回传前由 handleSwProxy 重写
function swProxyFetch(swId, targetUrl, resolve, reqMeta){
  console.log('[main] swProxyFetch:', JSON.stringify(targetUrl));
  // 兜底：SW 无法恢复 base 的相对路径请求 → 用当前地址栏 URL 作基准还原
  if(targetUrl && targetUrl.startsWith('/')){
    try{
      // 剥掉误挂上来的代理前缀：/__sw-proxy/search?q=x → /search?q=x；/__sw-proxy?q=x → /?q=x
      let path = targetUrl;
      if(path === '/__sw-proxy') path = '/';
      else if(path.startsWith('/__sw-proxy/')) path = path.slice('/__sw-proxy'.length);
      else if(path.startsWith('/__sw-proxy?')){
        const q = path.slice('/__sw-proxy?'.length);
        // 搜索引擎主页的 GET 表单丢掉了 /search 路径：q= 参数 + 无路径 → 补 /search
        // （Google 对 /?q= 返回主页而非结果页）
        if(/[?&]q=/.test(path) || /^q=/.test(q)) path = '/search?' + q;
        else path = '/?' + q;
      }
      const base = els.inpUrl.value || historyStack[historyIndex] || '';
      if(base && /^https?:\/\//i.test(base)){
        const abs = new URL(path, base).href;
        console.log('[main] relative→abs:', targetUrl.slice(0,60), '→', abs.slice(0,100));
        targetUrl = abs;
      }
    }catch(e){ console.log('[main] rel→abs fail:', String(e)); }
  }
  if(state!=='connected'){
    resolve({status:502, headers:{'content-type':'text/plain'}, bodyText:'未连接'});
    return;
  }
  const id=Math.random().toString(36).slice(2);
  pushLog('info',`资源 ${targetUrl}`);
  pendingFetches.set(id, { url: targetUrl, resolve });
  worker.postMessage({type:'PROXY_FETCH', id, url: targetUrl, method: reqMeta?.method, headers: reqMeta?.headers, body: reqMeta?.body});
}

function handleProxyResponse(m){
  const entry=pendingFetches.get(m.id);
  pendingFetches.delete(m.id);
  if(!entry) return;
  if(m.error){ entry.resolve({status:502, headers:{'content-type':'text/plain'}, bodyText:String(m.error)}); return; }
  if(m.body) bytesDown+=m.body.byteLength;
  let headers = m.headers||{};
  let body = m.body;

  // 只对真正的 HTML 文档调用 processHtml，JS/CSS/图片等资源跳过（避免 MIME 校验失败）
  const ct=((headers['content-type'])||'').toLowerCase();
  const isResource = resourceExt.test(entry.url||'');
  if(ct.includes('text/html') && !isResource){
    try{
      const processed = processHtml(entry.url, body);
      body = processed.body;
      headers = Object.assign({}, headers, {'content-type':'text/html; charset=utf-8'});
    }catch(e){ pushLog('warn','HTML 处理失败: '+e.message); }
  }
  entry.resolve({ status:m.status||200, headers, body });
}

// 抽出的 HTML 处理：重写资源 URL + 注入脚本
// 关键：URL 重写必须跳过 <script> 和 <style> 标签内容，否则会破坏 JS/CSS
function processHtml(url, bodyBytes){
  let text=new TextDecoder().decode(bodyBytes);
  const baseUrl=new URL(url);
  try{
    const tm = text.match(/<title[^>]*>([\s\S]{0,120}?)<\/title>/i);
    console.log('[main] processHtml:', url.slice(0,80), '| title:', tm?tm[1].trim():'(none)', '| len:', text.length);
  }catch(_e){}
  // HTML 属性值里的 URL 常带实体编码：百度 SSR 把 query 的 & 写成 &amp;。
  // 我们是绕过 DOM 直接正则抓文本，必须手动解码，否则图片/资源 URL 带字面
  // &amp; 传给目标站会 400（浏览器读 DOM 时会替我们解码，这一步不能漏）。
  const decodeEntities=(s)=> s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (m,d)=> String.fromCharCode(parseInt(d,10)))
    .replace(/&#x([0-9a-fA-F]+);/g, (m,h)=> String.fromCharCode(parseInt(h,16)));
  // GitHub 的字体/资源实际托管在 github.githubassets.com，不在 github.com 根路径
  // 当 base 是 github.com 时，根路径资源（/assets/、/Mona*）需映射到 githubassets.com
  const ghAssetRe = /^\/(assets\/|MonaSans|MonaSansMono|MonaSansVF|MonaSansMonoVF)/;
  const abs=(v)=>{
    try{
      const decoded = decodeEntities(v);
      let u = new URL(decoded, baseUrl);
      // GitHub 特殊处理：github.com 上的根路径资源文件实际在 github.githubassets.com
      if(baseUrl.host === 'github.com' && ghAssetRe.test(u.pathname)){
        u = new URL('https://github.githubassets.com' + u.pathname + u.search);
      }
      return u.href;
    }catch{ return null; }
  };
  const wrap=(v)=>{ const a=abs(v); return a ? `/__sw-proxy?u=${encodeURIComponent(a)}` : v; };

  // 第一步：提取 <script> 和 <style> 标签内容，用唯一占位符替换，避免正则污染 JS/CSS
  // 使用 UUID 风格占位符确保不会与页面内容冲突
  const placeholders = [];
  const makePlaceholder = ()=> `__SW_PH_${Math.random().toString(36).slice(2,10)}_${Date.now()}_${placeholders.length}__`;
  text = text.replace(/<script[\s\S]*?<\/script>/gi, (m)=>{
    const ph = makePlaceholder();
    placeholders.push({ph, orig: m});
    return ph;
  });
  text = text.replace(/<style[\s\S]*?<\/style>/gi, (m)=>{
    const ph = makePlaceholder();
    placeholders.push({ph, orig: m});
    return ph;
  });

  // 第二步：只对 HTML 属性做 URL 重写（此时 script/style 内容已被占位符保护）
  text = text.replace(/(src|href|poster|action)\s*=\s*(["'])([^"']+)\2/gi, (all, attr, q, v)=>{
    if(/^(data:|blob:|#|javascript:)/i.test(v.trim())) return all;
    return `${attr}=${q}${wrap(v)}${q}`;
  });
  // CSS 内 url(...) — 此时 style 内容已被占位，不会误匹配
  text = text.replace(/url\(\s*(['"]?)([^)'"]+)\1\s*\)/gi, (all, q, v)=>{
    if(/^(data:|blob:|#)/i.test(v.trim())) return all;
    return `url(${q}${wrap(v)}${q})`;
  });

  // 第三步：还原占位符
  placeholders.forEach((item)=>{
    text = text.replace(item.ph, item.orig);
  });
  // hook 脚本注入到 <head> 最前面（在任何页面 <script> 之前执行）
  // 否则页面 JS 的 fetch/XHR 先于 hook 运行 → 暴露真实 IP
  // 把真实目标 URL 写入 window.__swBase，让 hook 能正确解析相对路径请求
  const __swBaseScript = '<script>window.__swBase=' + JSON.stringify(baseUrl.href) + '</script>';
  const hookScript = INTERCEPT_SCRIPT(baseUrl.origin);
  if(/<head[^>]*>/i.test(text)){
    text = text.replace(/<head[^>]*>/i, m=>m+__swBaseScript+hookScript);
  } else {
    text = __swBaseScript+hookScript+text;
  }
  text=text.replace(/target\s*=\s*["_']_blank["_']/gi, 'target="_self"');
  const bytes = new TextEncoder().encode(text);
  return { body: bytes.buffer };
}

const INTERCEPT_SCRIPT = (origin) => '<script>' + `
(function(){
  console.log('[hook] SCRIPT LOADED, hooks installed');
  const _base = () => {
    const stored = (() => { try { return localStorage.getItem('__sw_target'); } catch(_) { return null; } })();
    const r = stored || window.__swBase || location.href;
    console.log('[hook] _base() →', r.slice(0,80));
    return r;
  };
  document.addEventListener('click', function(e){
    const a=e.target.closest('a');
    if(!a||!a.href) return;
    if(a.target==='_blank') a.removeAttribute('target');
    let href=a.href;
    try{
      const u=new URL(href, _base());
      if(u.pathname==='/__sw-proxy'){
        href=u.searchParams.get('u');
        e.preventDefault();
        // 下载特征：GitHub releases download 或常见二进制后缀 → 主线程转存文件
        if(new RegExp('/releases/download/').test(href) || /\.(deb|rpm|zip|tar|gz|tgz|xz|exe|dmg|apk|iso|bin|7z|rar)$/i.test(new URL(href).pathname)){
          parent.postMessage({type:'iframe-download', url:href}, '*');
          return;
        }
        parent.postMessage({type:'iframe-navigate', url:href}, '*');
        return;
      }
    }catch(_e){}
    if(href.startsWith('http')){
      e.preventDefault();
      parent.postMessage({type:'iframe-navigate', url:href}, '*');
    }
  }, true);
  const _open=window.open;
  window.open=function(u){ if(u){ try{ u=new URL(u, _base()).href; }catch(_e){} parent.postMessage({type:'iframe-navigate', url:u}, '*'); } return null; };
  const origFetch=window.fetch;
  console.log("[hook] fetch hook installed, original fetch:", typeof origFetch);
  window.fetch=function(input, init){
    try{
      let u = (input && input.url) ? input.url : String(input);
      console.log("[hook] fetch INPUT:", typeof input, input instanceof Request, u.slice(0,120));
      if(!u || u==='null' || u==='undefined' || u==='about:blank'){
        return origFetch.call(this, input, init);
      }
      // DEBUG: log every fetch call in the iframe
      if(u.startsWith('/')) {
        console.log('[hook] fetch REL raw:', JSON.stringify(u).slice(0,80), 'type:', typeof input, 'instanceof Request:', input instanceof Request, '__swBase:', window.__swBase, '_base:', _base());
      }
      if(new RegExp('^https?://').test(u)){
        // 已是代理路径（/__sw-proxy?u=...）→ 不再二次包裹（SW 会解开一层）
        try{
          var nu = new URL(u, _base());
          if(nu.pathname.startsWith('/__sw-proxy')) return origFetch.call(this, input, init);
        }catch(_e2){}
        var rewritten='/__sw-proxy?u='+encodeURIComponent(new URL(u, _base()).href);
        console.log('[hook] fetch REWRITE:', u.slice(0,120), '->', rewritten.slice(0,80));
        input=rewritten;
      } else if(u.startsWith('/__sw-proxy')) {
        // 已是代理路径（以 /__sw-proxy 开头的相对路径），直接透传
        return origFetch.call(this, input, init);
      } else if(u.startsWith('/')) {
        // 相对路径：用 __swBase 解析成绝对 URL 再代理
        try {
          var absUrl = new URL(u, _base()).href;
          var relRewritten = '/__sw-proxy?u=' + encodeURIComponent(absUrl);
          console.log('[hook] fetch REL→ABS:', u.slice(0,80), '→', absUrl.slice(0,120), '->', relRewritten.slice(0,80));
          input = relRewritten;
        } catch(_e2) {}
      }
    }catch(_e){ console.log('[hook] fetch ERROR:', String(_e)); }
    return origFetch.call(this, input, init);
  };
  // include-fragment / 动态元素的 src 兜底重写（新增节点 + 属性变化 + setAttribute hook）
  const fixSrc=(el)=>{
    try{
      const s=el.getAttribute && el.getAttribute('src');
      if(s && new RegExp('^https?://').test(s)) el.setAttribute('data-orig-src', s), el.setAttribute('src','/__sw-proxy?u='+encodeURIComponent(new URL(s, _base()).href));
    }catch(_e){}
  };
  new MutationObserver(muts=>{
    for(const m of muts){
      for(const n of m.addedNodes){
        if(n.nodeType!==1) continue;
        if(n.tagName==='INCLUDE-FRAGMENT' || n.tagName==='DEFERRED-ASSETS') fixSrc(n);
        if(n.querySelectorAll) n.querySelectorAll('include-fragment,deferred-assets').forEach(fixSrc);
      }
      if(m.type==='attributes' && (m.target.tagName==='INCLUDE-FRAGMENT'||m.target.tagName==='DEFERRED-ASSETS')){
        fixSrc(m.target); // 水合覆盖 src 后再改回来
      }
    }
  }).observe(document.documentElement,{childList:true,subtree:true,attributes:true,attributeFilter:['src']});
  // 初始已存在的元素
  const scanExisting=()=>{ document.querySelectorAll('include-fragment,deferred-assets').forEach(fixSrc); };
  scanExisting();
  document.addEventListener('DOMContentLoaded', scanExisting);
  setTimeout(scanExisting, 1000); setTimeout(scanExisting, 3000);
  // hook setAttribute：JS 动态设置 src 时拦截
  const origSetAttr = Element.prototype.setAttribute;
  Element.prototype.setAttribute = function(name, value){
    try{
      if(typeof value==='string' && (name==='src') && new RegExp('^https?://').test(value) &&
         (this.tagName==='INCLUDE-FRAGMENT' || this.tagName==='DEFERRED-ASSETS' || this.tagName==='SCRIPT' || this.tagName==='IMG' || this.tagName==='IFRAME')){
        value='/__sw-proxy?u='+encodeURIComponent(new URL(value, _base()).href);
      }
    }catch(_e){}
    return origSetAttr.call(this, name, value);
  };
  const origOpen=XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open=function(method, u){
    try{
      if(typeof u==='string' && new RegExp('^https?://').test(u)){
        try{ var nx=new URL(u, _base()); if(nx.pathname.startsWith('/__sw-proxy')){ return origOpen.apply(this, arguments); } }catch(_e2){}
        var rewritten='/__sw-proxy?u='+encodeURIComponent(new URL(u, _base()).href);
        console.log('[hook] XHR REWRITE:', method, u.slice(0,120), '->', rewritten.slice(0,80));
        arguments[1]=rewritten;
      } else if(typeof u==='string' && u.startsWith('/__sw-proxy')) {
        // 已是代理路径，直接透传
      } else if(typeof u==='string' && u.startsWith('/')) {
        // 相对路径：同样用 __swBase 解析
        try {
          var absU = new URL(u, _base()).href;
          var xhrRewritten = '/__sw-proxy?u=' + encodeURIComponent(absU);
          console.log('[hook] XHR REL→ABS:', method, u.slice(0,80), '→', absU.slice(0,120), '->', xhrRewritten.slice(0,80));
          arguments[1] = xhrRewritten;
        } catch(_e2) {}
      } else {
        console.log('[hook] XHR SKIP:', method, String(u).slice(0,80));
      }
    }catch(_e){ console.log('[hook] XHR ERROR:', String(_e)); }
    return origOpen.apply(this, arguments);
  };
  // 表单原生提交拦截：GET 表单（如 Google 搜索）会导航到相对路径，
  // 浏览器不触发 fetch/XHR hook。改为手动组装目标 URL 交给主线程。
  document.addEventListener('submit', function(e){
    try{
      const f=e.target;
      if(!f || f.tagName!=='FORM') return;
      const action=f.getAttribute('action')||'';
      if(action.startsWith('/__sw-proxy')) return; // 已是代理路径
      const method=(f.getAttribute('method')||'get').toUpperCase();
      if(method!=='GET'){ return; } // POST 表单暂不处理
      e.preventDefault();
      const fd=new FormData(f);
      const params=new URLSearchParams();
      for(const [k,v] of fd.entries()){ if(typeof v==='string') params.append(k,v); }
      const abs=new URL(action||location.pathname, _base());
      abs.search = params.toString() ? '?'+params.toString() : abs.search;
      console.log('[hook] form GET →', abs.href.slice(0,120));
      parent.postMessage({type:'iframe-navigate', url:abs.href}, '*');
    }catch(err){ console.log('[hook] form ERROR:', String(err)); }
  }, true);
  // hook form.submit()：程序化提交不触发 submit 事件，必须 hook 方法本身
  const origFormSubmit = HTMLFormElement.prototype.submit;
  HTMLFormElement.prototype.submit = function(){
    try{
      const f=this;
      const action=f.getAttribute('action')||'';
      if(!action.startsWith('/__sw-proxy')){
        const method=(f.getAttribute('method')||'get').toUpperCase();
        if(method==='GET'){
          const fd=new FormData(f);
          const params=new URLSearchParams();
          for(const [k,v] of fd.entries()){ if(typeof v==='string') params.append(k,v); }
          const abs=new URL(action||location.pathname, _base());
          abs.search = params.toString() ? '?'+params.toString() : abs.search;
          console.log('[hook] form.submit() GET →', abs.href.slice(0,120));
          parent.postMessage({type:'iframe-navigate', url:abs.href}, '*');
          return; // 阻止原生提交
        }
      }
    }catch(err){ console.log('[hook] form.submit ERROR:', String(err)); }
    return origFormSubmit.apply(this, arguments);
  };
  // 兜底：SW 层 Referer 恢复不了 /search 路径，这里再拦 action 属性写入，
  // 保证 JS 改写 action 时也被转成代理路径
  const actionDesc = Object.getOwnPropertyDescriptor(HTMLFormElement.prototype, 'action');
  if(actionDesc && actionDesc.set){
    Object.defineProperty(HTMLFormElement.prototype, 'action', {
      set: function(v){
        try{
          if(typeof v==='string' && v && !v.startsWith('/__sw-proxy') && !/^(data|blob|javascript):/i.test(v)){
            var abs=new URL(v, _base());
            var rewritten='/__sw-proxy?u='+encodeURIComponent(abs.href);
            console.log('[hook] form.action REWRITE:', v.slice(0,80), '->', rewritten.slice(0,80));
            return actionDesc.set.call(this, rewritten);
          }
        }catch(_e){}
        return actionDesc.set.call(this, v);
      },
      get: function(){
        var v = actionDesc.get.call(this);
        try{
          if(typeof v==='string' && v.startsWith('/__sw-proxy')){
            var u=new URL(v, _base());
            return u.searchParams.get('u') || v;
          }
        }catch(_e){}
        return v;
      },
      configurable: true,
    });
  }
  // hook HTMLScriptElement.prototype.src：拦截 JSONP（ip.sb 等站点用 script src 查 IP）
  const scriptDesc = Object.getOwnPropertyDescriptor(HTMLScriptElement.prototype, 'src');
  if(scriptDesc && scriptDesc.set){
    Object.defineProperty(HTMLScriptElement.prototype, 'src', {
      set: function(v){
        try{
          if(typeof v==='string' && new RegExp('^https?://').test(v)){
            var rewritten='/__sw-proxy?u='+encodeURIComponent(new URL(v, _base()).href);
            console.log('[hook] script.src REWRITE:', v.slice(0,120), '->', rewritten.slice(0,80));
            return scriptDesc.set.call(this, rewritten);
          }
        }catch(_e){ console.log('[hook] script.src ERROR:', String(_e)); }
        return scriptDesc.set.call(this, v);
      },
      get: scriptDesc.get,
      configurable: true,
      enumerable: true,
    });
  }
  // hook Image.prototype.src：拦截图片像素追踪
  const imgDesc = Object.getOwnPropertyDescriptor(Image.prototype, 'src');
  if(imgDesc && imgDesc.set){
    Object.defineProperty(Image.prototype, 'src', {
      set: function(v){
        try{
          if(typeof v==='string' && new RegExp('^https?://').test(v)){
            var rewritten='/__sw-proxy?u='+encodeURIComponent(new URL(v, _base()).href);
            console.log('[hook] img.src REWRITE:', v.slice(0,120));
            return imgDesc.set.call(this, rewritten);
          }
        }catch(_e){}
        return imgDesc.set.call(this, v);
      },
      get: imgDesc.get,
      configurable: true,
      enumerable: true,
    });
  }
  // 接收父线程发来的目标 URL（通过 postMessage），用于替换 location.href 基准
  // 这样即使原生表单提交/location 导航，也能正确解析相对路径
  window.addEventListener('message', function(e){
    if(e.data && e.data.type === 'SW_TARGET' && typeof e.data.url === 'string'){
      window.__swTarget = e.data.url;
      console.log('[hook] SW_TARGET set:', e.data.url.slice(0,80));
    }
  }, true);
  // Hook history API：拦截所有历史导航（pushState/replaceState/back/forward/go）
  const _origPushState = history.pushState;
  const _origReplaceState = history.replaceState;
  history.pushState = function(state, title, url) {
    console.log('[hook] pushState called:', typeof url, url);
    try {
      if (typeof url === 'string' && url.startsWith('/')) {
        const target = window.__swTarget || location.href;
        const abs = new URL(url, target).href;
        console.log('[hook] pushState REL:', url, '→', abs.slice(0,120));
        parent.postMessage({type:'iframe-navigate', url: abs}, '*');
        return; // 阻止原生导航
      }
    } catch(_e) { console.log('[hook] pushState ERROR:', String(_e)); }
    return _origPushState.call(this, state, title, url);
  };
  history.replaceState = function(state, title, url) {
    console.log('[hook] replaceState called:', typeof url, url);
    try {
      if (typeof url === 'string' && url.startsWith('/')) {
        const target = window.__swTarget || location.href;
        const abs = new URL(url, target).href;
        console.log('[hook] replaceState REL:', url, '→', abs.slice(0,120));
        parent.postMessage({type:'iframe-navigate', url: abs}, '*');
        return;
      }
    } catch(_e) { console.log('[hook] replaceState ERROR:', String(_e)); }
    return _origReplaceState.call(this, state, title, url);
  };
  // Hook popstate：拦截后退/前进按钮
  window.addEventListener('popstate', function(e) {
    console.log('[hook] popstate triggered', location.pathname);
    try {
      const url = location.pathname + location.search;
      if (url.startsWith('/') && !url.startsWith('/__sw-proxy')) {
        const target = window.__swTarget || location.href;
        const abs = new URL(url, target).href;
        console.log('[hook] popstate REL:', url, '→', abs.slice(0,120));
        parent.postMessage({type:'iframe-navigate', url: abs}, '*');
      }
    } catch(_e) {}
  }, true);
  // beforeunload：最后兜底，拦截所有导航尝试
  window.addEventListener('beforeunload', function(e) {
    console.log('[hook] beforeunload triggered', location.href);
    try {
      const url = location.pathname + location.search;
      if (url.startsWith('/') && !url.startsWith('/__sw-proxy')) {
        const target = window.__swTarget || location.href;
        const abs = new URL(url, target).href;
        console.log('[hook] beforeunload REL:', url, '→', abs.slice(0,120));
        e.preventDefault();
        e.returnValue = '';
        parent.postMessage({type:'iframe-navigate', url: abs}, '*');
      }
    } catch(_e) {}
  }, true);
  // 全局导航拦截：监听所有 frame 导航事件
  window.addEventListener('hashchange', function() {
    console.log('[hook] hashchange:', location.hash);
  }, true);
})();
</script>`;



window.addEventListener('message', e=>{
  if(!e.data) return;
  // 调试：记录所有接收到的消息
  console.log('[main] message received:', e.data.type, e.data.url ? e.data.url.slice(0,80) : '');
  // 处理来自 iframe 的导航请求（服务器返回的 /__sw-proxy 页面会发送此消息）
  if(e.data.type === 'IFRAME_NAV' && e.data.url){
    // 去重：如果和当前代理目标相同，说明已在循环中，跳过（防止无限循环）
    if(e.data.url === _currentProxyTarget){
      console.log('[main] IFRAME_NAV skipped (same as current target):', e.data.url.slice(0,80));
      return;
    }
    pushLog('info','iframe 内导航 (server): '+e.data.url.slice(0,80));
    navigate(e.data.url);
    return;
  }
  if(e.data.type==='iframe-navigate' && e.data.url){
    let u=e.data.url;
    try{ if(!new RegExp('^https?://').test(u)) u=new URL(u, els.inpUrl.value).href; }catch{}
    pushLog('info','iframe 内导航: '+u); navigate(u);
  }
  if(e.data.type==='iframe-download' && e.data.url){
    const u=e.data.url;
    pushLog('info','开始下载: '+u);
    if(state!=='connected'){ pushLog('warn','未连接，无法下载'); return; }
    reqCount++; els.statReq.textContent=reqCount;
    const id=Math.random().toString(36).slice(2);
    pendingFetches.set(id, { url:u, resolve:(resp)=>{
      // 用 content-disposition 或 URL 推断文件名
      let name='download';
      const cd=(resp.headers&&resp.headers['content-disposition'])||'';
      const m=cd.match(/filename\*?=(?:UTF-8''|\")?([^;\"]+)/i);
      if(m) name=decodeURIComponent(m[1].replace(/\"/g,''));
      else {
        try{ const p=new URL(u).pathname; name=p.slice(p.lastIndexOf('/')+1)||name; }catch{}
      }
      const blob=new Blob([resp.body], {type:(resp.headers&&resp.headers['content-type'])||'application/octet-stream'});
      const a=document.createElement('a');
      a.href=URL.createObjectURL(blob);
      a.download=name;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(()=>URL.revokeObjectURL(a.href), 60000);
      pushLog('info',`已保存: ${name} (${formatBytes(resp.body.byteLength)})`);
    }});
    worker.postMessage({type:'PROXY_FETCH', id, url:u});
  }
});

function navigate(url, pushHistory=true){
  // normalize
  if(!/^https?:\/\//i.test(url) && !url.startsWith('/__sw-proxy')) url='https://'+url;
  try{ new URL(url, window.location.href); }catch{ pushLog('error','URL 不合法: '+url); return; }
  els.inpUrl.value=url;
  saveUrl();
  if(pushHistory){
    historyStack = historyStack.slice(0, historyIndex+1);
    historyStack.push(url);
    historyIndex=historyStack.length-1;
  }
  proxyFetch(url);
}

// 配置只在点击"保存"时写入 localStorage（修改后不点保存则不生效到缓存）
function normalizeConfig(cfg){
  // 若地址栏误粘贴整条 vless 链接，自动解析
  if(cfg.address && cfg.address.toLowerCase().startsWith('vless://')){
    const p=parseVless(cfg.address);
    if(p){ pushLog('info','检测到 vless 链接，已自动解析为地址/端口/UUID/WS路径/SNI'); return p; }
  }
  return cfg;
}
function startConnect(){
  let cfg = getFormConfig();
  cfg = normalizeConfig(cfg);
  if(cfg.address!==getFormConfig().address) setFormConfig(cfg);
  const err=validate(cfg);
  if(err){ pushLog('error', err); setStatus('failed', err); return false; }
  setStatus('connecting');
  pushLog('info',`正在连接 ${cfg.address}:${cfg.port} WS=${cfg.wsPath} SNI=${cfg.sni}`);
  worker.postMessage({type:'CONNECT', payload: cfg});
  return true;
}
els.btnConnect.addEventListener('click', ()=>{ startConnect(); });
els.btnDisconnect.addEventListener('click', ()=>{
  worker.postMessage({type:'DISCONNECT'});
  setStatus('idle');
  pushLog('info','已断开');
});
els.btnSaveConfig.addEventListener('click', ()=>{
  saveCustom();
  pushLog('info','已保存当前配置');
});

// 构造 vless:// 分享链接（标准参数集，兼容主流客户端）
function buildVlessLink(cfg, name){
  const p = new URLSearchParams({
    encryption: 'none',
    security: 'tls',
    sni: cfg.sni,
    fp: 'chrome',
    insecure: '0',
    allowInsecure: '0',
    type: 'ws',
    host: cfg.sni,
    path: cfg.wsPath || '/',
  });
  return `vless://${cfg.uuid}@${cfg.address}:${cfg.port}?${p.toString()}#${encodeURIComponent(name||cfg.sni||'node')}`;
}

els.btnExportCfg.addEventListener('click', ()=>{
  const cfg = getFormConfig();
  const err = validate(cfg);
  if(err){ pushLog('error','无法导出: '+err); return; }
  const link = buildVlessLink(cfg);
  navigator.clipboard.writeText(link).then(
    ()=>pushLog('info','已复制到剪贴板: '+link),
    ()=>{ // 剪贴板不可用时降级为弹窗显示
      prompt('请手动复制节点链接：', link);
    }
  );
});

els.btnImportCfg.addEventListener('click', ()=>{
  const raw = prompt('粘贴 vless:// 节点链接：');
  if(!raw) return;
  const cfg = parseVless(raw.trim());
  if(!cfg){ pushLog('error','导入失败: 无法解析该链接'); return; }
  setFormConfig(cfg);
  saveCustom();
  pushLog('info',`已导入节点 ${cfg.address}:${cfg.port} WS=${cfg.wsPath} SNI=${cfg.sni}`);
});
els.btnGo.addEventListener('click', ()=> navigate(els.inpUrl.value));
els.inpUrl.addEventListener('keydown', e=>{
  if(e.key==='Enter'){
    navigate(els.inpUrl.value);
    els.inpUrl.blur(); // 回车后失焦，避免 iframe 操作时误触
  }
});
els.btnBack.addEventListener('click', ()=>{
  if(historyIndex>0){ historyIndex--; navigate(historyStack[historyIndex], false); }
});
els.btnForward.addEventListener('click', ()=>{
  if(historyIndex<historyStack.length-1){ historyIndex++; navigate(historyStack[historyIndex], false); }
});
els.btnRefresh.addEventListener('click', ()=>{ const u=historyStack[historyIndex]||els.inpUrl.value; proxyFetch(u); });
// 自动刷新：地址栏变化且未聚焦时自动重新加载页面（用于调试）
// 只有当 URL 与当前代理目标不同才触发，避免和 navigate() 竞争
let _lastUrl = els.inpUrl.value;
els.inpUrl.addEventListener('blur', ()=>{
  if(els.inpUrl.value !== _lastUrl && els.inpUrl.value.startsWith('https://') && els.inpUrl.value !== _currentProxyTarget){
    console.log('[main] URL changed, auto refreshing:', els.inpUrl.value.slice(0,80));
    _lastUrl = els.inpUrl.value;
    setTimeout(()=> proxyFetch(els.inpUrl.value), 500);
  } else {
    _lastUrl = els.inpUrl.value; // 同步 _lastUrl，避免下次误触发
  }
});
// 全屏切换：工具行常驻 iframe 卡顶部，CSS 负责铺满视口
let fullscreen = false;
els.btnFullscreen.addEventListener('click', ()=>{
  fullscreen = !fullscreen;
  document.body.classList.toggle('fullscreen', fullscreen);
  els.btnFullscreen.textContent = fullscreen ? '⛶' : '⛶';
  els.btnFullscreen.title = fullscreen ? '恢复' : '全屏显示';
});
// ESC 退出全屏
document.addEventListener('keydown', e=>{ if(e.key==='Escape' && fullscreen) els.btnFullscreen.click(); });

els.btnClearLog.addEventListener('click', ()=>{ logs=[]; renderLogs(); });
els.logFilter.addEventListener('change', renderLogs);
// 日志导出：优先 File System Access API（记住上次保存目录+文件名），降级 <a download>
const LS_LOG_DIR = 'v2ray-log-last-name';
els.btnExportLog.addEventListener('click', async ()=>{
  const blob=new Blob([JSON.stringify(logs,null,2)],{type:'application/json'});
  const lastName = (()=>{ try{ return localStorage.getItem(LS_LOG_DIR) || 'v2ray-log.json'; }catch{ return 'v2ray-log.json'; } })();
  if(window.showSaveFilePicker){
    try{
      const handle = await window.showSaveFilePicker({
        suggestedName: lastName,
        types: [{ description: 'JSON 日志', accept: { 'application/json': ['.json'] } }],
      });
      const w = await handle.createWritable();
      await w.write(blob);
      await w.close();
      try{ localStorage.setItem(LS_LOG_DIR, handle.name); }catch{}
      pushLog('info', '日志已导出: '+handle.name);
      return;
    }catch(e){
      if(e && e.name === 'AbortError') return; // 用户取消
      pushLog('warn', '保存对话框失败，回退直接下载: '+e.message);
    }
  }
  const a=document.createElement('a'); a.href=URL.createObjectURL(blob); a.download=lastName; a.click();
});

// ─── Service Worker：iframe 内资源经隧道加载 ────────────────────────────────
let swPort = null;
let swReady = false;   // SW 可用时才做资源 URL 重写
const swPending = new Map();
let swSeq = 0;

async function setupServiceWorker(){
  if(!('serviceWorker' in navigator)) return;
  try{
    const reg = await navigator.serviceWorker.register('sw.js');
    // 关键：刷新页面不会重启运行中的 SW（跨页面长存的独立进程）。
    // 若浏览器里跑的是旧版 sw.js，只能靠版本更新换代：reg.update() 让浏览器
    // 重取 sw.js，内容有变化就装新 worker（skipWaiting + clients.claim 立刻接管）。
    const activeBefore = reg.active;
    try{ await Promise.race([reg.update(), new Promise(r=>setTimeout(r,8000))]); }catch(_e){}
    if(reg.active !== activeBefore){
      await new Promise(res=>{
        const t = setTimeout(res, 5000);
        navigator.serviceWorker.addEventListener('controllerchange',
          ()=>{ clearTimeout(t); res(); }, {once:true});
      });
      pushLog('info','Service Worker 已更新到最新脚本');
    }
    await navigator.serviceWorker.ready;
    const handoff = (r)=>{
      const ch = new MessageChannel();
      ch.port1.onmessage = (ev)=>{ const m = ev.data; if(m && m.type === 'PROXY_FETCH') handleSwProxy(m); };
      swPort = ch.port1;
      swPort.onmessage = (ev)=>{ const m = ev.data; if(m && m.type === 'PROXY_FETCH') handleSwProxy(m); };
      try{
        r.active.postMessage({type:'SW_PORT'}, [ch.port2]);
      }catch(e){ console.warn('[main] SW_PORT 握手失败:', String(e)); }
      swReady = true;
    };
    handoff(reg);
    // 兜底：之后任何一次换 worker（例如又改了 sw.js）都重新递 port
    navigator.serviceWorker.addEventListener('controllerchange', ()=>handoff(reg));
    pushLog('info','Service Worker 已注册（页面内资源将走代理）');
  }catch(e){
    pushLog('warn','Service Worker 注册失败: '+e.message+'（页面内资源仍直连）');
  }
}

// SW 请求 → worker.js 隧道 → 回传
function handleSwProxy(m){
  console.log('[main] handleSwProxy:', m.id, JSON.stringify(m.url));
  const reqMeta = { method: m.method, headers: m.headers, body: m.body };
  swProxyFetch(m.id, m.url, (resp)=>{
    if(!swPort) return;
    const payload = { id:m.id, status:resp.status, headers:resp.headers };
    if(resp.body instanceof ArrayBuffer){
      payload.bodyBuffer = resp.body;
      swPort.postMessage(payload, [resp.body]);
    } else {
      payload.bodyText = resp.bodyText || '';
      swPort.postMessage(payload);
    }
  });
}

// init
loadCustom();
loadUrl();
initWorker();
setupServiceWorker();
setStatus('idle');
// 进入主页面后自动聚焦地址输入框
els.inpUrl.focus();
// 已保存节点 → 自动连接；未保存 → 提示手动填写
if(els.address.value.trim() && els.uuid.value.trim()){
  const autoCfg = normalizeConfig(getFormConfig());
  const autoErr = validate(autoCfg);
  if(!autoErr){
    pushLog('info','检测到已保存的节点，自动连接…');
    // 等 worker 起来再发 CONNECT（initWorker 内部已 postMessage INIT_WASM，消息会排队）
    setTimeout(()=>{ startConnect(); }, 0);
  } else {
    pushLog('info','页面已就绪。已保存的节点配置无效，请检查后重新连接。');
  }
} else {
  pushLog('info','页面已就绪。请填写节点并连接后使用代理浏览。');
}
