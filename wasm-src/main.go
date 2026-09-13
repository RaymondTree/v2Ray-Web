// main.go - Browser-side VLESS proxy (pure stdlib, no xray-core dependency)
package main

import (
	_ "embed"
	"bufio"
	"errors"
	"bytes"
	"context"
	"crypto/tls"
	"crypto/x509"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"runtime/debug"
	"strconv"
	"strings"
	"sync"
	"syscall/js"
	"time"
)

//go:embed cacert.pem
var caCertPEM []byte

var (
	rootCAOnce sync.Once
	rootCAPool *x509.CertPool
)

func rootCAs() *x509.CertPool {
	rootCAOnce.Do(func() {
		pool := x509.NewCertPool()
		if !pool.AppendCertsFromPEM(caCertPEM) {
			jsLog("WARN: no CA certs parsed")
			return
		}
		rootCAPool = pool
		jsLog("root CAs loaded (%d bytes)", len(caCertPEM))
	})
	return rootCAPool
}

type nodeConfig struct {
	Address string `json:"address"`
	Port    int    `json:"port"`
	UUID    string `json:"uuid"`
	WsPath  string `json:"wsPath"`
	SNI     string `json:"sni"`
}

var (
	stateMu   sync.Mutex
	cfg       nodeConfig
	bytesUp   int64
	bytesDown int64
	connected bool
)

func addUp(n int64)   { stateMu.Lock(); bytesUp += n; stateMu.Unlock() }
func addDown(n int64) { stateMu.Lock(); bytesDown += n; stateMu.Unlock() }

// ─── WebSocket bridge ────────────────────────────────────────────────────────

type wsConn struct {
	ws      js.Value
	readCh  chan []byte
	closeCh chan struct{}
	readBuf []byte
	writeMu sync.Mutex
}

func newWSConn(ws js.Value) *wsConn {
	c := &wsConn{ws: ws, readCh: make(chan []byte, 64), closeCh: make(chan struct{})}
	ws.Set("binaryType", "arraybuffer")
	ws.Call("addEventListener", "message", js.FuncOf(func(this js.Value, args []js.Value) any {
		data := args[0].Get("data")
		if data.InstanceOf(js.Global().Get("ArrayBuffer")) {
			buf := js.Global().Get("Uint8Array").New(data)
			b := make([]byte, buf.Length())
			js.CopyBytesToGo(b, buf)
			select {
			case c.readCh <- b:
			default:
				select {
				case <-c.readCh:
				default:
				}
				c.readCh <- b
			}
		}
		return nil
	}))
	onClose := js.FuncOf(func(this js.Value, args []js.Value) any {
		select {
		case <-c.closeCh:
		default:
			close(c.closeCh)
		}
		return nil
	})
	ws.Call("addEventListener", "close", onClose)
	ws.Call("addEventListener", "error", onClose)
	return c
}

func (c *wsConn) Read(p []byte) (int, error) {
	for len(c.readBuf) == 0 {
		select {
		case frame, ok := <-c.readCh:
			if !ok {
				return 0, io.EOF
			}
			c.readBuf = frame
		case <-c.closeCh:
			select {
			case frame := <-c.readCh:
				c.readBuf = frame
			default:
				return 0, io.EOF
			}
		}
	}
	n := copy(p, c.readBuf)
	c.readBuf = c.readBuf[n:]
	return n, nil
}

func (c *wsConn) Write(p []byte) (int, error) {
	c.writeMu.Lock()
	defer c.writeMu.Unlock()
	select {
	case <-c.closeCh:
		return 0, net.ErrClosed
	default:
	}
	buf := js.Global().Get("Uint8Array").New(len(p))
	js.CopyBytesToJS(buf, p)
	c.ws.Call("send", buf)
	ba := func() int {
		defer func() { recover() }() // ws 关闭后属性访问可能异常
		v := c.ws.Get("bufferedAmount")
		if v.IsUndefined() {
			return -1
		}
		return v.Int()
	}
	// 背压：仅在浏览器缓冲积压过大（>1MB）时等待，避免逐帧串行化拖慢吞吐
	for i := 0; i < 3000; i++ {
		select {
		case <-c.closeCh:
			return len(p), nil
		default:
		}
		n := ba()
		if n < 0 || n == 0 {
			break // 已关闭或已排空
		}
		if n < 1<<20 {
			break // 缓冲未超 1MB，直接返回让上层继续写
		}
		time.Sleep(20 * time.Millisecond)
	}
	return len(p), nil
}

func (c *wsConn) Close() error {
	select {
	case <-c.closeCh:
	default:
		close(c.closeCh)
	}
	func() { defer func() { recover() }(); c.ws.Call("close") }()
	return nil
}
func (c *wsConn) LocalAddr() net.Addr                { return &net.TCPAddr{} }
func (c *wsConn) RemoteAddr() net.Addr               { return &net.TCPAddr{} }
func (c *wsConn) SetDeadline(t time.Time) error      { return nil }
func (c *wsConn) SetReadDeadline(t time.Time) error  { return nil }
func (c *wsConn) SetWriteDeadline(t time.Time) error { return nil }

func openWS(cfg nodeConfig) (*wsConn, error) {
	wsURL := fmt.Sprintf("wss://%s:%d%s", cfg.SNI, cfg.Port, cfg.WsPath)
	ws := js.Global().Get("WebSocket").New(wsURL)
	// ★ 立即创建 wsConn 并注册全部 listener：
	// 若等到 open 事件再注册 message listener，握手后立即到达的帧会丢失。
	conn := newWSConn(ws)
	opened := make(chan struct{})
	failed := make(chan struct{}, 1)
	h1 := js.FuncOf(func(this js.Value, args []js.Value) any {
		select {
		case <-opened:
		default:
			close(opened)
		}
		return nil
	})
	h2 := js.FuncOf(func(this js.Value, args []js.Value) any {
		select {
		case failed <- struct{}{}:
		default:
		}
		return nil
	})
	ws.Call("addEventListener", "open", h1)
	ws.Call("addEventListener", "error", h2)
	defer func() { h1.Release(); h2.Release() }()
	select {
	case <-opened:
		return conn, nil
	case <-failed:
		func() { defer func() { recover() }(); ws.Call("close") }()
		return nil, fmt.Errorf("ws failed (%s)", wsURL)
	case <-time.After(20 * time.Second):
		func() { defer func() { recover() }(); ws.Call("close") }()
		return nil, fmt.Errorf("ws timeout (%s)", wsURL)
	}
}

// ─── VLESS protocol ──────────────────────────────────────────────────────────

const (
	vlessVer       byte = 0
	vlessCmdTCP    byte = 1
	addrTypeIPv4   byte = 1
	addrTypeDomain byte = 2
	addrTypeIPv6   byte = 3
)

func encodeHeader(uuidHex string, cmd byte, addrType byte, addr []byte, port uint16) []byte {
	// 兼容带横杠的标准 UUID 格式：去掉横杠
	uuidHex = strings.ReplaceAll(uuidHex, "-", "")
	if len(uuidHex) != 32 {
		panic("bad uuid: " + uuidHex)
	}
	uuid := make([]byte, 16)
	for i := 0; i < 16; i++ {
		var v byte
		for j := 0; j < 2; j++ {
			c := uuidHex[i*2+j]
			switch {
			case c >= '0' && c <= '9':
				v = v<<4 | (c - '0')
			case c >= 'a' && c <= 'f':
				v = v<<4 | (c - 'a' + 10)
			case c >= 'A' && c <= 'F':
				v = v<<4 | (c - 'A' + 10)
			}
		}
		uuid[i] = v
	}
	body := make([]byte, 0, 1+16+1+1+2+1+len(addr)+2)
	body = append(body, vlessVer)
	body = append(body, uuid...)
	body = append(body, 0) // addonsLen=0
	body = append(body, cmd)
	body = append(body, byte(port>>8), byte(port&0xff))
	body = append(body, addrType)
	body = append(body, byte(len(addr)))
	body = append(body, addr...)
	return body
}

func encodeAddress(s string) (byte, []byte) {
	if ip := net.ParseIP(s); ip != nil {
		if ip4 := ip.To4(); ip4 != nil {
			return addrTypeIPv4, ip4.To4()
		}
		return addrTypeIPv6, ip.To16()
	}
	return addrTypeDomain, []byte(s)
}

func readExact(r io.Reader, n int) ([]byte, error) {
	buf := make([]byte, n)
	if _, err := io.ReadFull(r, buf); err != nil {
		return nil, err
	}
	return buf, nil
}

func doVLESSRequest(conn net.Conn, req *http.Request) (*http.Response, error) {
	host := req.URL.Hostname()
	port := uint16(443)
	if p := req.URL.Port(); p != "" {
		var err error
		port, err = uint16FromString(p)
		if err != nil {
			return nil, err
		}
	}
	addrType, addrBytes := encodeAddress(host)

	httpBuf := new(bytes.Buffer)
	req.Write(httpBuf)
	httpBody := httpBuf.Bytes()

	header := encodeHeader(cfg.UUID, vlessCmdTCP, addrType, addrBytes, port)

	data := make([]byte, 0, len(header)+len(httpBody))
	data = append(data, header...)
	data = append(data, httpBody...)
	if _, err := conn.Write(data); err != nil {
		return nil, err
	}
	addUp(int64(len(data)))

	// VLESS 响应头: ver(1B) | addonsLen(1B) | addons(N)；其后全是裸数据流（无长度前缀）
	hdr, err := readExact(conn, 2)
	if err != nil {
		return nil, fmt.Errorf("vless resp header: %w", err)
	}
	if hdr[0] != vlessVer {
		return nil, fmt.Errorf("vless bad version: %d", hdr[0])
	}
	if n := int(hdr[1]); n > 0 { // addonsLen
		addons, err := readExact(conn, n)
		if err != nil {
			return nil, fmt.Errorf("vless addons: %w", err)
		}
		_ = addons
	}

	// 流式读取全部响应直到连接关闭（Connection: close 由我们请求头声明）
	var respBody []byte
	buf := make([]byte, 16*1024)
	for {
		n, err := conn.Read(buf)
		if n > 0 {
			respBody = append(respBody, buf[:n]...)
			if len(respBody) > 24*1024*1024 {
				break // 上限保护
			}
		}
		if err == io.EOF {
			break
		}
		if err != nil {
			if len(respBody) == 0 {
				return nil, fmt.Errorf("vless body: %w", err)
			}
			break // 已有数据，容忍读错误
		}
	}
	addDown(int64(len(respBody)))

	resp, err := http.ReadResponse(bufio.NewReader(bytes.NewReader(respBody)), req)
	if err != nil {
		return nil, fmt.Errorf("http parse: %w", err)
	}
	resp.Body = io.NopCloser(bytes.NewReader(respBody))
	return resp, nil
}

func uint16FromString(s string) (uint16, error) {
	var n uint64
	for _, c := range s {
		if c < '0' || c > '9' {
			return 0, fmt.Errorf("invalid port: %s", s)
		}
		n = n*10 + uint64(c-'0')
	}
	if n > 0xffff {
		return 0, fmt.Errorf("port out of range: %s", s)
	}
	return uint16(n), nil
}

// ─── 隧道传输层：http.Transport ↔ VLESS ─────────────────────────────────────

// vlessConn：把一条 WS 连接包装成目标站的 net.Conn。
// 写入时先发 VLESS 头（一次性），之后的数据作为裸 payload 流式追加。
type vlessConn struct {
	writeSeq    int
	respHdrDone bool
	firstReadLogged bool
	ws          *wsConn
	dest     string // 已编码的 VLESS 头（首次 Write 时发送）
	header   []byte
	headerSent bool
	rBuf     []byte
	readMu   sync.Mutex
	broken   bool // 标记连接已损坏（读/写出错）
}

func (v *vlessConn) markBroken() {
	v.readMu.Lock()
	v.broken = true
	v.readMu.Unlock()
	// 不再逐条打日志：keep-alive 下对端空闲关闭/我们主动 close_notify 都会走这里，
	// 每个资源页面几十次，纯噪音。真正的故障在 Read/Write 的错误路径单独报。
}

func newVlessConn(ws *wsConn, header []byte) *vlessConn {
	return &vlessConn{ws: ws, header: header}
}

func (v *vlessConn) ensureHeader(p []byte) error {
	if v.headerSent {
		return nil
	}
	v.headerSent = true
	// 首次写：头+首批数据同帧发出（规避 anti-probe）
	data := make([]byte, 0, len(v.header)+len(p))
	data = append(data, v.header...)
	data = append(data, p...)
	jsLog("first frame: header %dB + payload %dB (total %d)", len(v.header), len(p), len(data))
	_, err := v.ws.Write(data)
	return err
}

func (v *vlessConn) Read(p []byte) (int, error) {
	// 首次读：剥离 VLESS 响应头 ver(1B)+addonsLen(1B)+addons(N)，只把 payload 给上层
	if !v.respHdrDone {
		hdr := make([]byte, 2)
		if _, err := io.ReadFull(v.ws, hdr); err != nil {
			jsLog("resp header read: %v", err)
			v.markBroken()
			return 0, err
		}
		if hdr[0] != vlessVer {
			jsLog("bad resp ver: %d", hdr[0])
			return 0, fmt.Errorf("vless bad response version: %d", hdr[0])
		}
		if n := int(hdr[1]); n > 0 {
			addons := make([]byte, n)
			if _, err := io.ReadFull(v.ws, addons); err != nil {
				v.markBroken()
				return 0, err
			}
		}
		v.respHdrDone = true
		jsLog("resp header stripped (ver=%d)", hdr[0])
	}
	n, err := v.ws.Read(p)
	if err != nil {
		if err == io.EOF {
			// 干净关闭：对端空闲超时或 TLS close_notify。属正常连接生命周期，
			// Go http.Transport 下次请求自动重拨（GET 透明重试），只标记不报日志。
			v.markBroken()
			return 0, err
		}
		// 非 EOF 的读错误才是真故障（reset/broken pipe 等）
		jsLog("vlessConn read err after %dB: %v", n, err)
		v.markBroken()
	}
	if n > 0 && !v.firstReadLogged {
		v.firstReadLogged = true
		jsLog("first read %dB: %q", n, string(p[:minInt(24, n)]))
	}
	return n, err
}

func (v *vlessConn) Write(p []byte) (int, error) {
	v.writeSeq++
	jsLog("write #%d: %dB (headerSent=%v) first16=%x", v.writeSeq, len(p), v.headerSent, p[:minInt(16, len(p))])
	if !v.headerSent {
		if err := v.ensureHeader(p); err != nil {
			v.markBroken()
			return 0, err
		}
		addUp(int64(len(p)))
		return len(p), nil
	}
	n, err := v.ws.Write(p)
	if err != nil {
		v.markBroken()
	}
	addUp(int64(n))
	return n, err
}

func minInt(a, b int) int { if a < b { return a }; return b }

func (v *vlessConn) Close() error                       { return v.ws.Close() }
func (v *vlessConn) LocalAddr() net.Addr                { return &net.TCPAddr{} }
func (v *vlessConn) RemoteAddr() net.Addr               { return &net.TCPAddr{} }
func (v *vlessConn) SetDeadline(t time.Time) error      { return nil }
func (v *vlessConn) SetReadDeadline(t time.Time) error  { return nil }
func (v *vlessConn) SetWriteDeadline(t time.Time) error { return nil }

// tlsConnWithClose：把 tls.Conn 的关闭传导到内层隧道连接
type tlsConnWithClose struct {
	*tls.Conn
	inner *vlessConn
}

func (c *tlsConnWithClose) Close() error {
	err := c.Conn.Close()
	_ = c.inner.Close()
	return err
}

// 并发隧道上限：节点（CF Worker）对"频繁开新隧道"敏感——dial 越猛它越杀
// （12 并发→44 broken；8 并发→14 broken）。但主页 ~50 个资源抢 8 条隧道，
// 小文件会排队等槽位（2KB 图标实测 13s，纯排队非下载慢）。瓶颈是并行度而非节点：
// 被杀的空闲连接由 Go transport 透明重开（实测 0 个资源最终失败、0 个 502），
// 故适度提到 16，让资源并行下载。单 host 提到 10，缓解同 host keep-alive 串行。
const maxConcurrentTunnels = 16
var tunnelSem = make(chan struct{}, maxConcurrentTunnels)

func dialNewConn(host string, port int) (*vlessConn, error) {
	addrType, addrBytes := encodeAddress(host)
	header := encodeHeader(cfg.UUID, vlessCmdTCP, addrType, addrBytes, uint16(port))
	ws, err := openWS(cfg)
	if err != nil {
		return nil, err
	}
	vc := newVlessConn(ws, header)
	jsLog("dial %s:%d (new tunnel, active=%d/%d)", host, port, cap(tunnelSem)-len(tunnelSem), cap(tunnelSem))
	return vc, nil
}

// ─── 共享 keep-alive 传输层（连接复用）────────────────────────────────────────
// 全局一个 *http.Transport。它的 persistConn 池把 "隧道 + VLESS 头 + TLS 会话"
// 按 host 复用：同 host 首个请求开隧道握手，后续请求直接在已建好的 TLS 连接上
// 发 HTTP（不再重开 WS / VLESS 头 / TLS，省 ~2-25s/请求），且不会在同一条隧道
// 上重发 ClientHello。ServerName 留空 → Go 按每个请求 host 自动推导 SNI，跨域
// 重定向也正确。
// 关键：成功路径不能 cancel 请求 context——否则 Go 会立刻把刚读完、本可回池
// 复用的连接关掉（reqCancel 触发 Close），复用率归零。连接的回收交给
// IdleConnTimeout 管理。
var (
	sharedTransport *http.Transport
	transportOnce   sync.Once
)

func getSharedTransport() *http.Transport {
	transportOnce.Do(func() {
		sharedTransport = &http.Transport{
			Proxy: nil,
			DialContext: func(ctx context.Context, network, addr string) (net.Conn, error) {
				h, p, err := net.SplitHostPort(addr)
				if err != nil {
					h, p = addr, "443"
				}
				port, _ := strconv.Atoi(p)
				if port == 0 {
					port = 443
				}
				// 取并发槽位（满则排队；ctx 取消则归还）。槽位跟随隧道生命周期：
				// 新开时持有，直到这条隧道被真正 Close（空闲超时/服务端关闭/节点切换）。
				select {
				case tunnelSem <- struct{}{}:
				case <-ctx.Done():
					return nil, ctx.Err()
				}
				vc, err := dialNewConn(h, port)
				if err != nil {
					<-tunnelSem
					return nil, err
				}
				return &pooledConn{Conn: vc, host: h, port: port}, nil
			},
			MaxIdleConns:          24,
			MaxIdleConnsPerHost:   10,
			IdleConnTimeout:       20 * time.Second, // 空闲隧道 20s 后回收（释放槽位）
			ForceAttemptHTTP2:     false,
			TLSHandshakeTimeout:   30 * time.Second,
			ResponseHeaderTimeout: 90 * time.Second,
			TLSClientConfig: &tls.Config{
				RootCAs:    rootCAs(),
				// ServerName 留空：Go 按请求 host 自动设 SNI
				NextProtos: []string{"http/1.1"},
				MinVersion: tls.VersionTLS12,
			},
		}
	})
	return sharedTransport
}

// closeAllIdleTunnels 关闭全部空闲隧道（释放并发槽位），节点切换/断开时调用。
// 绝不碰 transportOnce（那会让 getSharedTransport 的初始化被永久跳过→nil panic）。
func closeAllIdleTunnels() {
	if sharedTransport != nil {
		sharedTransport.CloseIdleConnections()
	}
}

// pooledConn 包装 vlessConn，关闭时释放并发槽位。
// 每条隧道持有 1 个槽位（dial 时取，Close 时还）。http.Transport 会在空闲超时、
// 连接损坏、CloseIdleConnections 等时机调用 Close()，可能多次；用 sync.Once
// 保证"每个隧道恰好归还一次"，既不泄漏（死锁）也不双归还（槽位越界）。
type pooledConn struct {
	net.Conn
	host        string
	port        int
	releaseOnce sync.Once
}

func (pc *pooledConn) Close() error {
	err := pc.Conn.Close()
	pc.releaseOnce.Do(func() {
		<-tunnelSem // 归还并发槽位
	})
	return err
}

// ─── JS exports ──────────────────────────────────────────────────────────────

func jsLog(format string, args ...any) {
	js.Global().Get("console").Call("log", "[vless-go] "+fmt.Sprintf(format, args...))
}

func parseConfig(raw string) (nodeConfig, error) {
	var c nodeConfig
	// Use JS JSON.parse
	jsVal := js.Global().Get("JSON").Call("parse", js.ValueOf(raw))
	// Extract fields
	if v := jsVal.Get("address"); !v.IsUndefined() {
		c.Address = v.String()
	}
	if v := jsVal.Get("port"); !v.IsUndefined() {
		c.Port = v.Int()
	}
	if v := jsVal.Get("uuid"); !v.IsUndefined() {
		c.UUID = v.String()
	}
	if v := jsVal.Get("wsPath"); !v.IsUndefined() {
		c.WsPath = v.String()
	}
	if v := jsVal.Get("sni"); !v.IsUndefined() {
		c.SNI = v.String()
	}
	return c, nil
}

func xrayStart(this js.Value, args []js.Value) any {
	promise, resolve, reject := newPromise()
	if len(args) < 1 {
		reject(js.ValueOf("missing config"))
		return promise
	}
	raw := js.Global().Get("JSON").Call("stringify", args[0]).String()
	c, err := parseConfig(raw)
	if err != nil {
		reject(js.ValueOf("bad config: " + err.Error()))
		return promise
	}
	if c.Address == "" || c.UUID == "" {
		reject(js.ValueOf("address/uuid required"))
		return promise
	}
	if c.Port <= 0 {
		c.Port = 443
	}
	if c.SNI == "" {
		c.SNI = c.Address
	}
	if c.WsPath == "" {
		c.WsPath = "/"
	}
	go func() {
		defer func() {
			if r := recover(); r != nil {
				jsLog("xrayStart PANIC: %v", r)
				reject(js.ValueOf(fmt.Sprintf("panic: %v", r)))
			}
		}()
		// 不预开 WS：空闲连接会触发服务端 anti-probe。
		// 保存配置前清掉上一节点可能残留的空闲隧道（旧 SNI/WS 的连接不能再发新节点流量）。
		closeAllIdleTunnels()
		stateMu.Lock()
		cfg = c
		connected = true
		stateMu.Unlock()
		jsLog("ready %s:%d ws=%s sni=%s", c.Address, c.Port, c.WsPath, c.SNI)
		resolve(js.ValueOf(map[string]any{"ok": true}))
	}()
	return promise
}

func xrayFetch(this js.Value, args []js.Value) any {
	promise, resolve, reject := newPromise()
	if len(args) < 1 {
		reject(js.ValueOf("missing url"))
		return promise
	}
	rawURL := args[0].String()
	if rawURL == "" || rawURL == "null" || rawURL == "undefined" {
		reject(js.ValueOf("invalid url: " + rawURL))
		return promise
	}
	stateMu.Lock()
	ok := connected
	stateMu.Unlock()
	if !ok {
		reject(js.ValueOf("not connected"))
		return promise
	}
	// 可选参数：args[1] = { method, headers, bodyArrayBuffer }
	// 由 SW 层捕获的原始请求头透传（UA/Referer/Sec-Fetch-* 等），
	// 比硬编码 UA 更接近真实浏览器，降低被目标站识别为异常的概率
	method := "GET"
	var reqHdrs map[string]string
	var bodyBytes []byte
	if len(args) > 1 && !args[1].IsUndefined() && !args[1].IsNull() {
		obj := args[1]
		if m := obj.Get("method"); !m.IsUndefined() && !m.IsNull() {
			if s := m.String(); s != "" {
				method = s
			}
		}
		if h := obj.Get("headers"); !h.IsUndefined() && !h.IsNull() {
			reqHdrs = map[string]string{}
			keysVal := js.Global().Get("Object").Call("keys", h)
			for i := 0; i < keysVal.Length(); i++ {
				ks := keysVal.Index(i).String()
				if sv := h.Get(ks).String(); sv != "" {
					reqHdrs[ks] = sv
				}
			}
		}
		// body 由 worker.js 统一转成 ArrayBuffer 传入
		if b := obj.Get("body"); !b.IsUndefined() && !b.IsNull() {
			if b.InstanceOf(js.Global().Get("ArrayBuffer")) {
				u8 := js.Global().Get("Uint8Array").New(b)
				bodyBytes = make([]byte, u8.Length())
				js.CopyBytesToGo(bodyBytes, u8)
			}
		}
	}
	go func() {
		defer func() {
			if r := recover(); r != nil {
				jsLog("xrayFetch PANIC: %v\n%s", r, string(debug.Stack()))
				reject(js.ValueOf(fmt.Sprintf("panic: %v", r)))
			}
		}()
		start := time.Now()

		// 重试：服务端对并发新连接有限流（突发 EOF），瞬时失败退避后重试。
		// 关键：把「读响应体」也纳入每次尝试的 context 生命周期内，
		// 且只有拿到完整 body 才算成功，Do()/ReadAll 任一阶段的瞬时错误都触发重试。
		//
		// 协议升级：http:// 目标先试 https://（80 端口隧道极慢，见 upgradeToHTTPS）。
		// 仅当 https 在【传输层】失败（握手/证书/EOF，非 4xx/5xx 业务响应）时回退一次
		// 原始 http。attempt 序列（原 URL 是 http 时）：https → http → https。
		httpsURL, upgraded := upgradeToHTTPS(rawURL)
		curURL := rawURL
		if upgraded {
			curURL = httpsURL
		}
		// 回退动作（幂等）：仍在 https 上失败 → 切回原始 http 供下一 attempt 使用。
		fallbackToHTTP := func(reason string) {
			if upgraded && curURL == httpsURL {
				curURL = rawURL
				jsLog("https %s → fallback to http for %s", reason, rawURL)
			}
		}
		var lastResp *http.Response
		var bodySuccess []byte
		for attempt := 1; attempt <= 3; attempt++ {
			reqCtx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
			// 每次尝试重新构造 bodyReader（重试时旧 reader 已被读空）
			var bodyReader io.Reader
			if len(bodyBytes) > 0 {
				bodyReader = bytes.NewReader(bodyBytes)
			}
			req, err := http.NewRequestWithContext(reqCtx, method, curURL, bodyReader)
			if err != nil {
				cancel()
				reject(js.ValueOf("bad url: " + err.Error()))
				return
			}
			if reqHdrs != nil {
				for k, v := range reqHdrs {
					switch strings.ToLower(k) {
					case "host", "content-length", "connection", "accept-encoding":
						continue // hop-by-hop / 浏览器自己算的
					}
					req.Header.Set(k, v)
				}
			}
			if req.Header.Get("User-Agent") == "" {
				req.Header.Set("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36")
			}
			if req.Header.Get("Accept") == "" && method == "GET" {
				req.Header.Set("Accept", "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8")
			}

			client := &http.Client{
				Transport: getSharedTransport(),
				CheckRedirect: func(r *http.Request, via []*http.Request) error {
					if len(via) >= 5 {
						return errors.New("too many redirects")
					}
					return nil
				},
			}
			resp, err := client.Do(req)
			if err != nil {
				cancel()
				if isTransientFetchErr(err) && attempt < 3 {
					fallbackToHTTP("Do传输层失败")
					wait := 300 * time.Millisecond * time.Duration(attempt)
					jsLog("retry %d/3 (Do): %s (%v, backoff %v)", attempt, curURL, err, wait)
					time.Sleep(wait)
					continue
				}
				reject(js.ValueOf("fetch: " + err.Error()))
				return
			}

			// 读 body 仍在同一 context 生命周期内，不会 context canceled
			body, readErr := io.ReadAll(io.LimitReader(resp.Body, 24*1024*1024))
			_ = resp.Body.Close()
			if readErr != nil {
				if isTransientFetchErr(readErr) && attempt < 3 {
					cancel()
					fallbackToHTTP("读body传输层失败")
					wait := 300 * time.Millisecond * time.Duration(attempt)
					jsLog("retry %d/3 (read): %s (%v, backoff %v)", attempt, curURL, readErr, wait)
					time.Sleep(wait)
					continue
				}
				cancel()
				reject(js.ValueOf("read: " + readErr.Error()))
				return
			}

			// 成功：body 已读完并 Close。关键：这里【不 cancel】reqCtx ——
			// cancel 会触发 Go transport 的 reqCancel，立刻关闭这条刚读完、
			// 本可 keep-alive 回池复用的隧道（上一轮"复用率归零 + conn broken
			// 刷屏"的根因）。连接的回收交给 IdleConnTimeout(20s) 管理。
			// resp.Header 在 Do 返回时已解析完，context 90s 超时后自动回收，无泄漏。
			lastResp = resp
			bodySuccess = body
			break
		}
		if lastResp == nil {
			return
		}
		resp := lastResp

		hdrs := map[string]any{}
		for k, v := range resp.Header {
			if len(v) > 0 {
				hdrs[strings.ToLower(k)] = v[0]
			}
		}
		u8 := js.Global().Get("Uint8Array").New(len(bodySuccess))
		js.CopyBytesToJS(u8, bodySuccess)
		jsLog("%s -> %d %dB %dms", rawURL, resp.StatusCode, len(bodySuccess), time.Since(start).Milliseconds())
		resolve(js.ValueOf(map[string]any{
			"status":  resp.StatusCode,
			"headers": hdrs,
			"body":    u8,
		}))
	}()
	return promise
}

// upgradeToHTTPS：把 http:// 目标升级为 https://。
// 百度系结果页大量引用 http:// 静态资源，80 端口隧道实测中位 44~61s，
// https 隧道 2.8s。目标站（CDN/静态资源）几乎都支持 https。
// 只对 scheme==http 的 URL 生效；显式 :80 端口必须去掉（否则变成 https 的 80 端口）。
// 返回 (升级后的 https URL, 是否升级成功)。非 http 或解析失败 → 原样返回、ok=false。
func upgradeToHTTPS(rawURL string) (string, bool) {
	u, err := url.Parse(rawURL)
	if err != nil || u.Scheme != "http" {
		return rawURL, false
	}
	u.Scheme = "https"
	if u.Port() == "80" {
		u.Host = u.Hostname()
	}
	return u.String(), true
}

// isTransientFetchErr：可重试的瞬时错误（服务端限流/连接被掐）
func isTransientFetchErr(err error) bool {
	if err == nil {
		return false
	}
	s := err.Error()
	for _, k := range []string{
		"EOF",
		"connection reset",
		"connection closed",
		"use of closed network connection",
		"broken pipe",
		// TLS 握手失败：通常是节点瞬时过载/限流拒绝新隧道，重拨常能成功。
		"tls: handshake failure",
		"handshake failure",
		"remote error: tls",
		"context deadline exceeded",
		"ws timeout",
		"ws failed",
	} {
		if strings.Contains(s, k) {
			return true
		}
	}
	return false
}

func xrayStop(this js.Value, args []js.Value) any {
	stateMu.Lock()
	connected = false
	stateMu.Unlock()
	closeAllIdleTunnels() // 断开时关掉所有 host 的空闲隧道，释放并发槽位
	return js.ValueOf(map[string]any{"ok": true})
}

// ─── Promise helper ──────────────────────────────────────────────────────────

type promiseBox struct {
	set     chan struct{}
	resolve func(v any)
	reject  func(v any)
}

func newPromise() (js.Value, func(any), func(any)) {
	box := &promiseBox{set: make(chan struct{})}
	var fnRef js.Func
	fnRef = js.FuncOf(func(this js.Value, fnArgs []js.Value) any {
		box.resolve = func(v any) {
			defer func() { recover() }()
			if len(fnArgs) > 0 && !fnArgs[0].IsUndefined() {
				fnArgs[0].Invoke(toJSValue(v))
			}
		}
		box.reject = func(v any) {
			defer func() { recover() }()
			if len(fnArgs) > 1 && !fnArgs[1].IsUndefined() {
				fnArgs[1].Invoke(toJSValue(v))
			}
		}
		close(box.set)
		return nil
	})
	promise := js.Global().Get("Promise").New(fnRef)
	<-box.set
	return promise, box.resolve, box.reject
}

func toJSValue(v any) js.Value {
	switch t := v.(type) {
	case js.Value:
		return t
	case string:
		return js.ValueOf(t)
	default:
		return js.ValueOf(v)
	}
}

func main() {
	js.Global().Set("xrayStart", js.FuncOf(xrayStart))
	js.Global().Set("xrayFetch", js.FuncOf(xrayFetch))
	js.Global().Set("xrayStop", js.FuncOf(xrayStop))
	js.Global().Set("xrayStats", js.FuncOf(func(this js.Value, args []js.Value) any {
		stateMu.Lock()
		defer stateMu.Unlock()
		return js.ValueOf(map[string]any{"bytesUp": bytesUp, "bytesDown": bytesDown})
	}))
	jsLog("vless shim ready")
	// 主 goroutine 永不过期：select{} 在无其他 goroutine 时会触发
	// deadlock 检测导致 exit(2)，改用周期性 Sleep 让 runtime 认为有活干。
	for {
		time.Sleep(1 * time.Hour)
	}
}
