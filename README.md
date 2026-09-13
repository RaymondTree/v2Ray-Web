# v2Ray-on-Browser

**100% 在本地浏览器里运行的 VLESS 网页代理。**

本项目把完整的代理内核（VLESS + WebSocket + TLS 隧道）用 Go 编译成约 10MB 的单文件
WASM，在浏览器的 Web Worker 中直接运行。打开网页、填入节点、开始浏览——
**所有代理流量都从你的浏览器经你自己的 VLESS 节点直连目标网站，托管平台
（Cloudflare Pages 等）只负责分发这几个静态文件，全程不参与流量转发，
看不到你的目标地址，也看不到任何明文内容。**

## 亮点

- **真正"本地"的代理**：内核 100% 跑在你的浏览器里。托管平台只是文件仓库，
  不是中转——对比"在线网页代理"，它永远有平台方看到明文的问题。
- **不到 10MB 的 WASM**：纯 Go 标准库实现（零第三方依赖，内嵌 Mozilla CA
  信任库），单线程编译、无 `SharedArrayBuffer` 需求。如此小的体积意味着
  **任何静态托管平台都能部署**：Cloudflare Pages、GitHub Pages、Vercel、
  Netlify、甚至你自己 VPS 上的 nginx——把一个 URL 丢进浏览器就是一个完整的代理。
- **完整网页浏览体验**：Service Worker 全量拦截 + HTML 资源重写 + 注入式
  fetch/XHR hook，iframe 里的图片、CSS、JS、子资源、动态请求全部自动走隧道，
  无需页面配合。
- **性能优化**：连接池复用（同域名只付一次握手）、遥测/广告请求黑名单
  （就地 204 拦截、不占隧道并发）、CDN 静态资源浏览器缓存。
- **开源**：GPL 3.0，欢迎 PR。

## 部署

### 方式一：一键脚本（推荐，Cloudflare Pages）

**Linux / macOS：**

```bash
curl -fsSL https://raw.githubusercontent.com/RaymondTree/v2Ray-Web/main/cloudflare-linux.sh | bash
```

**Windows（PowerShell）：**

```powershell
irm https://raw.githubusercontent.com/RaymondTree/v2Ray-Web/main/cloudflare-windows.ps1 | iex
```

> Windows 版脚本尚未发布，上面这条命令暂时不可用。

脚本会在终端里用交互界面带你走完整个流程：

1. **选择语言**（中文 / English）；
2. **环境自检** —— 缺 `curl` / `python3` / `tar` 时自动调用系统包管理器安装，
   装不上则打印各发行版的安装命令并退出；
3. **粘贴 Cloudflare API 令牌** —— 界面里会写明需要的权限
   （`账户 → Cloudflare Pages → 编辑`）；没有令牌时输入 `b` 回车，
   脚本用默认浏览器打开令牌创建页并列出点击路径；
4. **选择「部署」或「更新」** —— 部署＝新建站点（自己起名），
   更新＝覆盖账号里已有的某个站点；
5. **自动下载最新站点包**并上传、部署；
6. 输出访问地址 `https://<项目名>.pages.dev`，并可选绑定你自己的域名。

> **不需要 node / npm / wrangler / git。** 脚本只依赖 `bash + curl + python3`，
> 全程调 Cloudflare REST API，站点包从本仓库的 GitHub Release 自动获取。
>
> **需要用 `bash` 而不是 `sh`**：启用了 TUI 与关联数组，dash 不支持；
> 脚本针对 `curl | bash` 的管道模式做了专门处理（交互从 `/dev/tty` 读取）。

### 方式二：手动部署

把以下文件原样上传到任意静态托管平台（目录结构保持平铺）：

```
index.html   app.js   sw.js   worker.js   style.css
wasm_exec.js xray.wasm   _headers   favicon.ico（可选）
```

两个关键约束：

| 约束 | 原因 | 解决 |
|---|---|---|
| `xray.wasm` 必须以 `application/wasm` 响应 | 浏览器按 MIME 校验 WASM 字节码 | CF Pages 用仓库自带 `_headers`；其他平台配置等价响应头 |
| 站点必须是 HTTPS（或本地 `127.0.0.1`/`localhost`） | Service Worker 要求安全上下文 | 各大静态平台默认 HTTPS，天然满足 |

CF Pages 手动操作：Dashboard → Workers & Pages → 新建 Pages 项目 →
直接上传（Upload）整个目录，构建命令留空（纯静态，无需构建）。

### 本地运行

```bash
node scripts/serve-https.mjs    # http://127.0.0.1:12346（SW 可注册的安全上下文）
```

## 本地开发与调试

> 以下命令默认在仓库根目录（`v2Ray-Web/`）执行。

### 1. 起本地服务

```bash
# 仓库不带 node_modules（保持仓库精简），首次运行前装一次依赖：
npm install        # 会依据 package.json 拉取 selfsigned / acorn 等，生成 node_modules/

# HTTP 模式（推荐）：http://127.0.0.1:12346，Service Worker 可正常注册
node scripts/serve-https.mjs
```

> `node_modules/` 不入库（体积大、可复现）。上面的 `npm install` 会自动依据
> `package.json` / `package-lock.json` 装好。离线或无 npm 时可手动 `npm pack`
> 各依赖解包，或让 CI/部署脚本代跑 `npm install`（本项目的部署脚本已内置）。

服务同时会在 `https://127.0.0.1:12443` 起一个 302 兜口，重定向到上面的
HTTP 地址，方便旧书签访问。

### 2. 浏览器端调试

1. 打开 `http://127.0.0.1:12346`，DevTools（F12）。
2. **Console**：`[vless-go]`（Go 内核）、`[main]`（主线程）、`[sw]`
   （Service Worker）、`[hook]`（注入到代理页面的 fetch/XHR hook）日志都打在这里。
3. **Application → Service Workers**：能看到 `sw.js` 的运行实例。改了 `sw.js`
   后需要强制刷新（或 Unregister 再刷新）才会重新加载，因为 SW 是跨页面
   长存的独立进程。
4. 右侧日志面板 = 页面内嵌的实时日志（对应 `v2ray-log.json` / `*.log` 的
   来源），可点「导出」落盘。

主线程与 Worker、SW 的通信路径（排查"消息没到"类问题用）：

```
app.js（主线程） ⇄ worker.js（Web Worker）⇄ xray.wasm（Go 内核）
      │ postMessage: LOG / STATUS / STATS / PROXY_RESPONSE
      └ MessageChannel ⇄ sw.js（Service Worker）
```

### 3. 无浏览器端到端测试（Node）

不依赖浏览器，用 Node 22 原生 `WebSocket` + `WebAssembly` 直接加载
`xray.wasm`，连接真实节点并抓取一个页面：

```bash
# 必给节点（脚本不内置任何真实节点）
export TEST_ADDRESS=203.0.113.1
export TEST_PORT=443
export TEST_UUID=xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
export TEST_WSPATH=/ray
export TEST_SNI=example.com

node scripts/test-wasm-node.mjs               # 默认抓 https://www.google.com/generate_204
node scripts/test-wasm-node.mjs xray.wasm https://github.com/   # 指定 wasm 与目标
```

### 4. 编译 Go 内核 → xray.wasm

```bash
./scripts/build-wasm.sh        # 产物覆盖仓库根 xray.wasm
```

改完 `wasm-src/main.go` 后必须重新编译并重新起服务 / 刷新页面，浏览器里的
旧 wasm 不会自动更新。

## 制作精简版 xray.wasm

`build-wasm.sh` 默认产物约 9.5 MiB，已经做过三层瘦身：

1. **`-trimpath` + `-ldflags="-s -w"`**：去掉调试符号与 DWARF（`-s` 去符号表、
   `-w` 去 DWARF），这是体积大头。
2. **内嵌 CA**（`//go:embed cacert.pem`）：Go 侧 TLS 校验自带 Mozilla 信任库，
   运行期零额外依赖，不会因缺证书而失败。
3. **可选 `wasm-opt -Oz`**：装了 [binaryen](https://github.com/WebAssembly/binaryen)
   的话脚本自动调用做二次压缩。

手动安装并强制压缩（体积敏感时）：

```bash
# Debian/Ubuntu
sudo apt install binaryen
# 或 macOS
brew install binaryen

# 只编译不压缩
GOOS=js GOARCH=wasm go build -trimpath -ldflags="-s -w" -o xray.wasm ./wasm-src/

# 再叠加 wasm-opt 极致压缩
wasm-opt -Oz xray.wasm -o xray.wasm
```

要点：

- 单线程编译（`GOARCH=wasm` 默认），**不要**开 `-tags "goos_js goarch_wasm"`
  多线程路径，否则需要 `SharedArrayBuffer` + COOP/COEP 头，纯静态托管部署不上。
- 产物必须 **< 25 MiB**（build-wasm.sh 会校验，超限直接报错）。
- 压缩后体积变化较大时，记得让浏览器/CDN 重新拉取，避免拿到旧缓存。
- 想进一步减体积，只能裁功能（比如去掉某个 `jsLog` 分支 / 去掉 `debug.Stack`
  的 recover 路径），代价是可读性/可维护性下降，一般不建议。

## 项目代码介绍

```
┌────────── 浏览器（100% 本地执行）──────────────────────────┐
│                                                            │
│  主线程 app.js                                             │
│   ├─ UI：节点表单 / 日志面板 / 流量统计                    │
│   ├─ 注册 sw.js，MessageChannel 双向通道握手               │
│   ├─ processHtml：重写资源 URL + 注入 hook 脚本            │
│   └─ iframe → /__sw-proxy?u=<目标URL>                     │
│        │                                                   │
│        ▼                                                   │
│  sw.js（Service Worker）                                    │
│   ├─ 拦截 /__sw-proxy* → 经通道转发主线程                  │
│   ├─ 遥测黑名单：命中直接回 204，不进隧道                   │
│   └─ CDN 静态资源 → Cache API 本地缓存                     │
│        │                                                   │
│        ▼                                                   │
│  worker.js（Web Worker）                                    │
│   └─ 加载 xray.wasm（约 9.5MB，Go 单线程内核）             │
│        │                                                   │
│        ▼                                                   │
│  Go 内核：VLESS 握手帧 → WebSocket(wss://) → TLS 隧道     │
│        │  连接池复用 / 并发 6 槽位 / 故障重试               │
└────────┼───────────────────────────────────────────────────┘
         │ wss://你的 VLESS 节点（浏览器直连，不经过托管平台）
         ▼
      目标网站（github.com / baidu.com / google.com ...）
```

### 文件说明

| 文件 | 作用 |
|---|---|
| `index.html` | 主界面：节点配置表单（支持粘贴 `vless://` 链接自动解析）、代理浏览 iframe、日志面板、流量统计 |
| `style.css` | 界面样式（浅色主题） |
| `app.js`（主线程） | 节点管理（vless:// 解析、导入导出、localStorage 持久化）；Web Worker 生命周期；SW 注册与 MessageChannel 握手（含 SW 换代后 `controllerchange` 重握手，避免"刷新两次才好"的竞态）；`processHtml` 把响应 HTML 的 `src/href/action` 全部重写为 `/__sw-proxy?u=` 代理路径，并注入 `INTERCEPT_SCRIPT`；浏览器历史/前进后退/日志 |
| `INTERCEPT_SCRIPT`（在 app.js 内，注入到每个代理页面） | hook 页面内的 `fetch` / `XMLHttpRequest` / `img.src` / 表单提交 / 超链点击，把漏出隧道的请求重定向回代理路径；带"已重写过则放行"守卫，避免双重重包 |
| `sw.js`（Service Worker） | 拦截所有 `/__sw-proxy?u=` 请求，经 MessageChannel 转发给主线程→Worker 隧道；**遥测黑名单**（`isTelemetry`：github collector、百度统计、Google Analytics 等命中直接回 204，不占隧道并发槽）；**CDN 静态资源缓存**（Cache API，命中本地直接返回）；mainPort 等待握手（首屏请求早于握手到达时最多等 15s，不报错） |
| `worker.js`（Web Worker） | 加载 `wasm_exec.js` + `xray.wasm`，转调 Go 侧 `xrayStart` / `xrayFetch` / `xrayStop`，统计上下行字节，回传 PROXY_RESPONSE |
| `wasm-src/main.go`（Go 内核，~1000 行） | 纯标准库：`jsWSConn`/`wsConn` 把浏览器 WebSocket 包装成 `net.Conn`（含背压控制）；`vlessConn` 封装 VLESS 握手帧（首帧 = 头+首批数据同帧，规避服务端 anti-probe）；`sharedTransport` 全局 `http.Transport` 连接池（同域名复用 TLS 会话，SNI 按请求推导，`broken` 标志探活，并发 6 槽位信号量排队）；内嵌 Mozilla `cacert.pem` 信任库；EOF/断连自动重试 |
| `wasm_exec.js` | Go 官方 WASM 运行时胶水（`GOOS=js` 生成） |
| `xray.wasm` | 编译产物（~9.5MB，`-trimpath -ldflags="-s -w"` + 可选 wasm-opt 压缩） |
| `_headers` | Cloudflare Pages 配置：`*.wasm` 响应 `Content-Type: application/wasm` |
| `scripts/build-wasm.sh` | 一键编译：`GOOS=js GOARCH=wasm go build` + 可选 `wasm-opt -Oz` |
| `scripts/serve-https.mjs` | 本地静态服务器（HTTP 模式 12346，附 HTTPS 302 兜底 12443） |
| `scripts/test-wasm-node.mjs` | Node 冒烟测试 |

## 编译 WASM（可选）

```bash
./scripts/build-wasm.sh
# 需要 Go 1.21+；产物覆盖仓库根 xray.wasm（<25 MiB）
node scripts/test-wasm-node.mjs   # 冒烟验证
```

## 协议支持

当前实现：**VLESS + WebSocket + TLS**。节点配置需要：地址、端口、UUID、
WS 路径（如 `/ray`）、SNI（可选，默认同地址）。

## 许可证

**GNU General Public License v3.0 (GPL 3.0)**

本项目是自由软件，你可以重新分发和/or修改；详见 `LICENSE` 文件。
使用即表示你同意 GPL 3.0 条款（衍生作品须以相同许可证开源分发）。
