#!/usr/bin/env bash
# shellcheck disable=SC2034  # 多语言数组经 ${!ref} 间接访问
# =============================================================================
#  Xray-Web · Cloudflare Pages 一键部署
#  ---------------------------------------------------------------------------
#  用法：
#      curl -fsSL <url>/cloudflare-linux.sh | sh
#    或
#      CF_API_TOKEN=xxx CF_ACCOUNT_ID=yyy ./cloudflare-linux.sh
#
#  依赖：bash / curl / python3 / tar（缺失时脚本会尝试自动安装）
#  不需要：node / npm / wrangler / git
#
#  环境变量（都可选，用于跳过交互）：
#      CF_API_TOKEN     Cloudflare API 令牌（权限：账户 → Cloudflare Pages → 编辑）
#      CF_ACCOUNT_ID    Cloudflare 账户 ID
#      CF_PROJECT       Pages 项目名
#      CF_BUNDLE_URL    站点包下载地址（默认从 GitHub Release 取）
# =============================================================================

set -o pipefail

# ── curl | bash 兼容 ─────────────────────────────────────────────────────────
# 管道执行时 stdin 是脚本本身（bash 的解析器正从它读脚本），
# 所以【绝不能】用 exec < /dev/tty —— 那会让解析器改从终端读脚本而挂死。
# 正确做法：每次交互单独从 /dev/tty 读，shell 自己的 stdin 保持不动。

API="https://api.cloudflare.com/client/v4"
REPO="RaymondTree/v2Ray-Web"
BUNDLE_URL="${CF_BUNDLE_URL:-}"

# ── 颜色 ─────────────────────────────────────────────────────────────────────
if [ -t 1 ]; then
  C_RST=$'\033[0m';  C_RED=$'\033[31m';  C_GRN=$'\033[32m'
  C_YEL=$'\033[33m'; C_CYA=$'\033[36m';  C_BLD=$'\033[1m'; C_DIM=$'\033[2m'
else
  C_RST=''; C_RED=''; C_GRN=''; C_YEL=''; C_CYA=''; C_BLD=''; C_DIM=''
fi
ok()   { printf '%s✔%s %s\n'   "$C_GRN" "$C_RST" "$*"; }
bad()  { printf '%s✘%s %s\n'   "$C_RED" "$C_RST" "$*" >&2; }
warn() { printf '%s▲%s %s\n'   "$C_YEL" "$C_RST" "$*"; }
info() { printf '%s·%s %s\n'   "$C_CYA" "$C_RST" "$*"; }
dim()  { printf '%s%s%s\n'     "$C_DIM" "$*" "$C_RST"; }
step() { printf '\n%s▸ %s%s\n' "$C_BLD$C_CYA" "$*" "$C_RST"; }
die()  { bad "$*"; exit 1; }

# ── 多语言 ───────────────────────────────────────────────────────────────────
# 多语言文案表（经 ${!ref} 间接访问）
declare -A M_zh M_en
M_zh[title]="Xray-Web · Cloudflare Pages 一键部署"
M_zh[subtitle]="纯浏览器端 VLESS 代理，部署到你的 Cloudflare 账号"
M_en[title]="Xray-Web · Cloudflare Pages one-click deploy"
M_en[subtitle]="Browser-side VLESS proxy, deployed to your own Cloudflare account"

M_zh[lang_q]="请选择语言"; M_en[lang_q]="Select language"
M_zh[lang_pick]="输入序号"; M_en[lang_pick]="Enter number"

M_zh[env_check]="环境自检"; M_en[env_check]="Checking environment"
M_zh[env_missing]="缺少 %s，尝试自动安装…"; M_en[env_missing]="Missing %s, trying to install…"
M_zh[env_installed]="%s 安装成功"; M_en[env_installed]="%s installed"
M_zh[env_fail]="自动安装 %s 失败。"; M_en[env_fail]="Failed to install %s automatically."
M_zh[env_manual]="请手动安装后重试："; M_en[env_manual]="Please install manually and retry:"
M_zh[env_nopm]="未识别到包管理器"; M_en[env_nopm]="No supported package manager found"
M_zh[env_ok]="环境就绪"; M_en[env_ok]="Environment ready"

M_zh[tok_title]="Cloudflare API 令牌"; M_en[tok_title]="Cloudflare API Token"
M_zh[tok_need]="需要的权限：账户 → Cloudflare Pages → 编辑"; M_en[tok_need]="Required permission: Account → Cloudflare Pages → Edit"
M_zh[tok_label]="令牌"; M_en[tok_label]="Token"
M_zh[tok_hint]="没有令牌？输入 %s 回车，我会打开浏览器帮你创建"; M_en[tok_hint]="No token? Type %s and press Enter to open the browser"
M_zh[tok_opening]="正在打开浏览器…"; M_en[tok_opening]="Opening browser…"
M_zh[tok_open_fail]="无法自动打开浏览器，请手动访问："; M_en[tok_open_fail]="Could not open browser, please visit manually:"
M_zh[tok_steps]="照着点：创建令牌 → 创建自定义令牌 → 权限 → 选择「账户、Cloudflare Pages、编辑」→ 继续以显示摘要 → 创建令牌 → 复制令牌粘贴回这里";
M_en[tok_steps]="Click: Create Token → Create Custom Token → Permissions → Account / Cloudflare Pages / Edit → Continue to summary → Create Token → copy it back here"
M_zh[tok_verify]="校验令牌"; M_en[tok_verify]="Verifying token"
M_zh[tok_ok]="令牌有效"; M_en[tok_ok]="Token is valid"
M_zh[tok_bad]="令牌无效或缺少权限"; M_en[tok_bad]="Invalid token or missing permission"
M_zh[tok_retry]="请重新输入（剩余 %s 次）"; M_en[tok_retry]="Try again (%s attempts left)"
M_zh[tok_abort]="令牌校验多次失败，已退出"; M_en[tok_abort]="Too many failed attempts, aborting"

M_zh[acct_check]="确定账户 ID"; M_en[acct_check]="Resolving account ID"
M_zh[acct_auto]="自动识别到账户：%s"; M_en[acct_auto]="Detected account: %s"
M_zh[acct_pick]="该令牌可访问多个账户，请选择"; M_en[acct_pick]="Token can access multiple accounts, pick one"
M_zh[acct_manual]="无法自动获取账户列表（令牌通常没有 Account:Read 权限），请手动输入账户 ID";
M_en[acct_manual]="Cannot list accounts automatically (token usually lacks Account:Read), please enter the account ID"
M_zh[acct_how]="在哪里找账户 ID："; M_en[acct_how]="Where to find the account ID:"
M_zh[acct_how1]="1) 打开 https://dash.cloudflare.com/"; M_en[acct_how1]="1) Open https://dash.cloudflare.com/"
M_zh[acct_how2]="2) 地址栏形如 dash.cloudflare.com/<32位ID>/… ，中间那段就是";
M_en[acct_how2]="2) The URL looks like dash.cloudflare.com/<32-char-id>/… — that segment is it"
M_zh[acct_how3]="3) 或打开 Workers & Pages，右侧栏 Account ID 可一键复制";
M_en[acct_how3]="3) Or open Workers & Pages; the Account ID in the right sidebar has a copy button"
M_zh[acct_input]="账户 ID"; M_en[acct_input]="Account ID"
M_zh[acct_bad]="账户 ID 格式不对（应为 32 位十六进制）"; M_en[acct_bad]="Bad account ID (expect 32 hex chars)"

M_zh[op_q]="要做什么？"; M_en[op_q]="What do you want to do?"
M_zh[op_1]="部署 — 新建一个站点"; M_en[op_1]="Deploy — create a new site"
M_zh[op_2]="更新 — 覆盖已有的站点"; M_en[op_2]="Update — overwrite an existing site"
M_zh[op_pick]="输入序号 [1]"; M_en[op_pick]="Enter number [1]"

M_zh[proj_q]="新站点的项目名（会成为 https://<名字>.pages.dev）"; M_en[proj_q]="Project name for the new site (becomes https://<name>.pages.dev)"
M_zh[proj_input]="项目名"; M_en[proj_input]="Project name"
M_zh[proj_bad]="名字只能用 小写字母/数字/连字符，且以字母或数字开头"; M_en[proj_bad]="Use lowercase letters/digits/hyphens only, starting with a letter or digit"
M_zh[proj_dup]="该项目名已被占用，换一个"; M_en[proj_dup]="That name is taken, try another"
M_zh[proj_made]="项目已创建：%s"; M_en[proj_made]="Project created: %s"

M_zh[upd_none]="账号下还没有任何 Pages 站点，将走「部署」流程"; M_en[upd_none]="No existing Pages site, falling back to Deploy"
M_zh[upd_q]="选择要更新的站点"; M_en[upd_q]="Select the site to update"
M_zh[upd_pick]="输入序号"; M_en[upd_pick]="Enter number"
M_zh[upd_use]="将更新 %s（生产分支：%s）"; M_en[upd_use]="Updating %s (production branch: %s)"

M_zh[bdl_title]="获取站点文件"; M_en[bdl_title]="Fetching site bundle"
M_zh[bdl_query]="查询最新发布版本…"; M_en[bdl_query]="Looking up the latest release…"
M_zh[bdl_found]="找到 %s"; M_en[bdl_found]="Found %s"
M_zh[bdl_down]="下载中…"; M_en[bdl_down]="Downloading…"
M_zh[bdl_ok]="已解压 %s 个文件"; M_en[bdl_ok]="Extracted %s files"
M_zh[bdl_fail]="获取站点包失败"; M_en[bdl_fail]="Failed to fetch the bundle"
M_zh[bdl_how]="可手动下载后放到空目录，再用 CF_BUNDLE_URL 指定"; M_en[bdl_how]="Download it manually and pass it via CF_BUNDLE_URL"
M_zh[bdl_bad]="站点包内容不完整（缺 %s）"; M_en[bdl_bad]="Bundle is incomplete (missing %s)"
M_zh[bdl_retry]="下载失败（第 %s 次），重试中…"; M_en[bdl_retry]="Download failed (attempt %s), retrying…"
M_zh[bdl_manual]="若持续失败，请手动下载后重跑："; M_en[bdl_manual]="If it keeps failing, download manually and rerun:"

M_zh[key_title]="计算资源指纹"; M_en[key_title]="Hashing assets"
M_zh[key_n]="共 %s 个文件"; M_en[key_n]="%s files"

M_zh[jwt_fail]="获取上传凭证失败（检查令牌是否有 Pages:Edit 权限）"; M_en[jwt_fail]="Failed to get upload token (check Pages:Edit permission)"

M_zh[miss_title]="检查增量"; M_en[miss_title]="Checking which assets are missing"
M_zh[miss_none]="全部命中缓存，跳过上传"; M_en[miss_none]="All cached, skipping upload"
M_zh[miss_n]="需要上传 %s 个"; M_en[miss_n]="Uploading %s assets"

M_zh[up_title]="上传资源"; M_en[up_title]="Uploading assets"
M_zh[up_file]="+ %s"; M_en[up_file]="+ %s"
M_zh[up_big]="（大文件，约需几十秒）"; M_en[up_big]="(large file, may take a while)"
M_zh[up_fail]="上传失败：%s"; M_en[up_fail]="Upload failed: %s"

M_zh[dep_title]="创建部署"; M_en[dep_title]="Creating deployment"
M_zh[dep_fail]="创建部署失败：%s"; M_en[dep_fail]="Deployment failed: %s"

M_zh[poll_title]="等待部署完成"; M_en[poll_title]="Waiting for deployment"
M_zh[poll_bad]="部署失败：%s"; M_en[poll_bad]="Deployment failed: %s"
M_zh[poll_timeout]="等待超时，请到 Cloudflare Dashboard 查看状态"; M_en[poll_timeout]="Timed out — check the Cloudflare dashboard"

M_zh[ok_title]="部署完成"; M_en[ok_title]="Deployment complete"
M_zh[ok_prod]="生产地址"; M_en[ok_prod]="Production"
M_zh[ok_prev]="本次预览"; M_en[ok_prev]="This deploy (preview)"
M_zh[ok_next]="下一步：打开上面的地址，在页面里填入你的 VLESS 节点（地址/端口/UUID/WS 路径/SNI），点「连接」即可开始浏览。";
M_en[ok_next]="Next: open the URL above, fill in your VLESS node (host/port/UUID/WS path/SNI) and click Connect."

M_zh[dom_q]="是否绑定你自己的域名？（可稍后在 Dashboard 绑定）"; M_en[dom_q]="Bind your own domain? (can also do it later in the dashboard)"
M_zh[dom_yn]="绑定？[y/N]"; M_en[dom_yn]="Bind? [y/N]"
M_zh[dom_input]="域名（如 1018.example.com）"; M_en[dom_input]="Domain (e.g. 1018.example.com)"
M_zh[dom_ok]="已提交绑定，证书签发通常需 1–2 分钟"; M_en[dom_ok]="Binding submitted; certificate issuance usually takes 1–2 minutes"
M_zh[dom_for]="令牌缺少 Zone→DNS→编辑 权限，已跳过"; M_en[dom_for]="Token lacks Zone→DNS→Edit permission, skipping"
M_zh[dom_fail]="绑定失败：%s"; M_en[dom_fail]="Binding failed: %s"

M_zh[bye]="再见"; M_en[bye]="Bye"
LANG="zh"
t() { local k="$1"; shift; local ref="M_${LANG}[$k]"; local v="${!ref}"; printf "$v" "$@"; }

# ── 交互小工具 ───────────────────────────────────────────────────────────────
hr() { printf '%s%s%s\n' "$C_DIM" "────────────────────────────────────────────────────────────" "$C_RST"; }
NO_TTY_MSG_ZH="没有可交互的终端（stdin 已关闭）。请把脚本下载后再运行，或用环境变量提供参数。"
NO_TTY_MSG_EN="No interactive terminal (stdin closed). Download the script and run it, or pass parameters via environment variables."
no_tty() { [ "$LANG" = "en" ] && bad "$NO_TTY_MSG_EN" || bad "$NO_TTY_MSG_ZH"; exit 1; }
# 交互输入统一走这里：优先 /dev/tty（curl|bash 时 shell 的 stdin 是脚本本身）
_tty_read() {  # 普通读取 → REPLY_INPUT
  if [ -r /dev/tty ]; then read -r REPLY_INPUT < /dev/tty 2>/dev/null
  else read -r REPLY_INPUT 2>/dev/null; fi
}
_tty_read_secret() {  # 不回显读取 → REPLY_INPUT
  if [ -r /dev/tty ]; then read -rs REPLY_INPUT < /dev/tty 2>/dev/null
  else read -rs REPLY_INPUT 2>/dev/null; fi
}
ask() {  # ask <提示> [默认值]  → 结果写入 REPLY_INPUT
  local p="$1" def="${2:-}"
  if [ -n "$def" ]; then printf '%s%s%s [%s]: ' "$C_BLD" "$p" "$C_RST" "$def"
  else printf '%s%s%s: ' "$C_BLD" "$p" "$C_RST"; fi
  _tty_read || { printf '\n'; no_tty; }
  REPLY_INPUT="${REPLY_INPUT:-$def}"
}
ask_secret() {  # 不回显
  local p="$1"
  printf '%s%s%s: ' "$C_BLD" "$p" "$C_RST"
  _tty_read_secret || { printf '\n'; no_tty; }
  printf '\n'
}
pick() {  # pick <提示> <数量> → 结果写入 REPLY_PICK (1-based)
  local p="$1" n="$2" ans
  while :; do
    ask "$p" ""
    ans="$REPLY_INPUT"
    if [[ "$ans" =~ ^[0-9]+$ ]] && [ "$ans" -ge 1 ] && [ "$ans" -le "$n" ]; then
      REPLY_PICK="$ans"; return 0
    fi
    bad "$(t op_pick)"
  done
}
jq_py() { python3 -c "$1"; }
fetch_retry() {  # fetch_retry <url> <outfile>；网络抖动时重试 4 轮
  local u="$1" o="$2" i=1
  while [ "$i" -le 4 ]; do
    if curl -fsSL --connect-timeout 20 --retry 3 --retry-all-errors --retry-delay 3 \
            -o "$o" "$u" 2>/dev/null; then return 0; fi
    warn "$(t bdl_retry "$i")"
    i=$((i+1)); [ "$i" -le 4 ] && sleep 3
  done
  return 1
}
jtrue() {  # stdin JSON → "1"/"0"（success 是否为 true）
  jq_py 'import sys,json
try: print("1" if json.load(sys.stdin).get("success") is True else "0")
except Exception: print("0")'
}
jstatus() {  # stdin JSON → /user/tokens/verify 的 result.status
  jq_py 'import sys,json
try: print(json.load(sys.stdin).get("result",{}).get("status",""))
except Exception: print("")'
}
jerr() {  # stdin JSON → 错误码列表（逗号分隔）
  jq_py 'import sys,json
try: print(",".join(str(e.get("code","")) for e in (json.load(sys.stdin).get("errors") or [])))
except Exception: print("")'
}
is_tty() { [ -t 0 ] && [ -t 1 ]; }

# =============================================================================
# ① 语言
# =============================================================================
printf '\n%s%s%s\n' "$C_BLD$C_CYA" "Xray-Web · Cloudflare Pages" "$C_RST"
dim "https://github.com/$REPO"
printf '\n'
printf '  1) 中文\n  2) English\n\n'
ask "请选择语言 / Select language" "1"
[ "$REPLY_INPUT" = "2" ] && LANG="en"
printf '\n%s%s%s\n' "$C_BLD" "$(t title)" "$C_RST"
dim "$(t subtitle)"

# =============================================================================
# ② 环境自检 + 自动修复
# =============================================================================
step "$(t env_check)"

PM=""; SUDO=""
if   command -v apt-get >/dev/null 2>&1; then PM="apt-get"
elif command -v dnf     >/dev/null 2>&1; then PM="dnf"
elif command -v yum     >/dev/null 2>&1; then PM="yum"
elif command -v pacman  >/dev/null 2>&1; then PM="pacman"
elif command -v apk     >/dev/null 2>&1; then PM="apk"
elif command -v zypper  >/dev/null 2>&1; then PM="zypper"
fi
[ "$(id -u)" -ne 0 ] && command -v sudo >/dev/null 2>&1 && SUDO="sudo"

pkg_name() {  # 工具名 → 该包管理器下的包名
  case "$1:$PM" in
    python3:pacman) echo "python" ;;
    *)              echo "$1" ;;
  esac
}
install_tool() {
  local tool="$1" pkg; pkg="$(pkg_name "$tool")"
  [ -n "$PM" ] || return 1
  case "$PM" in
    apt-get) $SUDO apt-get update -qq >/dev/null 2>&1; $SUDO apt-get install -y -qq "$pkg" >/dev/null 2>&1 ;;
    dnf|yum) $SUDO "$PM" install -y -q "$pkg" >/dev/null 2>&1 ;;
    pacman)  $SUDO pacman -S --noconfirm --quiet "$pkg" >/dev/null 2>&1 ;;
    apk)     $SUDO apk add --quiet "$pkg" >/dev/null 2>&1 ;;
    zypper)  $SUDO zypper --quiet --non-interactive install "$pkg" >/dev/null 2>&1 ;;
  esac
}

NEEDED="curl python3 tar"
for tool in $NEEDED; do
  if command -v "$tool" >/dev/null 2>&1; then continue; fi
  warn "$(t env_missing "$tool")"
  if install_tool "$tool" && command -v "$tool" >/dev/null 2>&1; then
    ok "$(t env_installed "$tool")"
  else
    bad "$(t env_fail "$tool")"
    if [ -z "$PM" ]; then bad "$(t env_nopm)"; fi
    printf '\n%s%s%s\n' "$C_BLD" "$(t env_manual)" "$C_RST"
    printf '  Debian/Ubuntu : sudo apt install -y %s\n'  "$(pkg_name "$tool")"
    printf '  Fedora/RHEL   : sudo dnf install -y %s\n'  "$(pkg_name "$tool")"
    printf '  Arch          : sudo pacman -S %s\n'       "$(pkg_name "$tool")"
    printf '  Alpine        : sudo apk add %s\n'         "$(pkg_name "$tool")"
    printf '  openSUSE      : sudo zypper install %s\n'  "$(pkg_name "$tool")"
    exit 1
  fi
done
ok "$(t env_ok)"

# =============================================================================
# ③ 获取 API Token
# =============================================================================
TOKEN="${CF_API_TOKEN:-}"
if [ -n "$TOKEN" ]; then
  info "CF_API_TOKEN ✔"
else
  tries=3
  while [ "$tries" -gt 0 ]; do
    printf '\n'
    hr
    printf '%s  %s%s\n' "$C_BLD" "$(t tok_title)" "$C_RST"
    printf '  %s\n' "$(t tok_need)"
    printf '\n'
    printf '  %s%s%s\n' "$C_DIM" "$(t tok_hint "b")" "$C_RST"
    hr
    ask_secret "  $(t tok_label)"
    TOKEN="$REPLY_INPUT"

    if [ "$TOKEN" = "b" ] || [ "$TOKEN" = "B" ]; then
      URL="https://dash.cloudflare.com/profile/api-tokens"
      info "$(t tok_opening)"
      if command -v xdg-open >/dev/null 2>&1; then xdg-open "$URL" >/dev/null 2>&1 &
      elif command -v open >/dev/null 2>&1;   then open "$URL" >/dev/null 2>&1 &
      elif command -v wslview >/dev/null 2>&1; then wslview "$URL" >/dev/null 2>&1 &
      else
        bad "$(t tok_open_fail)"
        printf '  %s\n\n' "$URL"
      fi
      warn "$(t tok_steps)"
      continue
    fi
    [ -n "$TOKEN" ] || { bad "$(t tok_bad)"; tries=$((tries-1)); continue; }

    step "$(t tok_verify)"
    VR=$(curl -sS --connect-timeout 20 -H "Authorization: Bearer $TOKEN" "$API/user/tokens/verify" 2>/dev/null)
    if [ "$(printf '%s' "$VR" | jstatus)" = "active" ]; then
      ok "$(t tok_ok)"
      break
    else
      bad "$(t tok_bad)"
      tries=$((tries-1))
      [ "$tries" -gt 0 ] && warn "$(t tok_retry "$tries")"
    fi
  done
  [ "$tries" -gt 0 ] || die "$(t tok_abort)"
fi

# =============================================================================
# ④ 确定 account_id
# =============================================================================
step "$(t acct_check)"
AID="${CF_ACCOUNT_ID:-}"
if [ -z "$AID" ]; then
  ACC=$(curl -sS --connect-timeout 20 -H "Authorization: Bearer $TOKEN" "$API/accounts" 2>/dev/null)
  readarray -t ACC_LINES < <(printf '%s' "$ACC" | jq_py '
import sys,json
try: d=json.load(sys.stdin)
except Exception: sys.exit(0)
for a in (d.get("result") or []): print(a["id"] + "\t" + a["name"])
' 2>/dev/null || true)

  if [ "${#ACC_LINES[@]}" -eq 1 ] && [ -n "${ACC_LINES[0]}" ]; then
    AID="${ACC_LINES[0]%%$'\t'*}"; ANAME="${ACC_LINES[0]#*$'\t'}"
    ok "$(t acct_auto "$ANAME")"
  elif [ "${#ACC_LINES[@]}" -gt 1 ]; then
    info "$(t acct_pick)"
    i=0; for l in "${ACC_LINES[@]}"; do i=$((i+1)); printf '  %s%d)%s %s\n' "$C_BLD" "$i" "$C_RST" "${l#*$'\t'}"; done
    pick "$(t op_pick)" "$i"
    AID="${ACC_LINES[$((REPLY_PICK-1))]%%$'\t'*}"
  fi
fi
if [ -z "$AID" ]; then
  warn "$(t acct_manual)"
  printf '\n%s%s%s\n' "$C_BLD" "$(t acct_how)" "$C_RST"
  dim "  $(t acct_how1)"; dim "  $(t acct_how2)"; dim "  $(t acct_how3)"
  printf '\n'
  while :; do
    ask "$(t acct_input)"
    AID="$REPLY_INPUT"
    [[ "$AID" =~ ^[0-9a-fA-F]{32}$ ]] && break
    bad "$(t acct_bad)"
  done
fi
info "account_id: $AID"

# =============================================================================
# ⑤ 部署 / 更新
# =============================================================================
projects_tsv() {  # 输出 name<TAB>branch
  curl -sS --connect-timeout 20 -H "Authorization: Bearer $TOKEN" "$API/accounts/$AID/pages/projects" 2>/dev/null | jq_py '
import sys,json
try: d=json.load(sys.stdin)
except Exception: sys.exit(0)
for p in (d.get("result") or []):
    print(p.get("name","") + "\t" + (p.get("production_branch") or "main"))
' 2>/dev/null || true
}

PROJECT="${CF_PROJECT:-}"
BRANCH="main"
if [ -z "$PROJECT" ]; then
  step "$(t op_q)"
  printf '  %s1)%s %s\n' "$C_BLD" "$C_RST" "$(t op_1)"
  printf '  %s2)%s %s\n' "$C_BLD" "$C_RST" "$(t op_2)"
  printf '\n'
  ask "$(t op_pick)" "1"
  MODE="$REPLY_INPUT"

  if [ "$MODE" = "2" ]; then
    readarray -t PROJ_LINES < <(projects_tsv)
    if [ "${#PROJ_LINES[@]}" -eq 0 ] || [ -z "${PROJ_LINES[0]}" ]; then
      warn "$(t upd_none)"; MODE="1"
    else
      step "$(t upd_q)"
      i=0; for l in "${PROJ_LINES[@]}"; do i=$((i+1)); printf '  %s%d)%s %s\n' "$C_BLD" "$i" "$C_RST" "${l%%$'\t'*}"; done
      pick "$(t upd_pick)" "$i"
      sel="${PROJ_LINES[$((REPLY_PICK-1))]}"
      PROJECT="${sel%%$'\t'*}"; BRANCH="${sel#*$'\t'}"
      ok "$(t upd_use "$PROJECT" "$BRANCH")"
    fi
  fi

  # ── ⑥ 新建项目（部署路径）
  if [ -z "$PROJECT" ]; then
    printf '\n'
    info "$(t proj_q)"
    while :; do
      ask "$(t proj_input)"
      PROJECT="$REPLY_INPUT"
      if ! [[ "$PROJECT" =~ ^[a-z0-9][a-z0-9-]{0,57}$ ]]; then bad "$(t proj_bad)"; continue; fi
      RES=$(curl -sS --connect-timeout 20 -X POST "$API/accounts/$AID/pages/projects" \
              -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
              --data "{\"name\":\"$PROJECT\",\"production_branch\":\"main\"}" 2>/dev/null)
      if [ "$(printf '%s' "$RES" | jtrue)" = "1" ]; then break; fi
      if printf '%s' "$RES" | jerr | grep -q '8000033'; then
        RES=$(curl -sS --connect-timeout 20 -X POST "$API/accounts/$AID/pages/projects" \
                -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
                --data "{\"name\":\"$PROJECT\",\"production_branch\":\"main\"}" 2>/dev/null)
        [ "$(printf '%s' "$RES" | jtrue)" = "1" ] && break
      fi
      bad "$(t proj_dup)"
    done
    ok "$(t proj_made "https://$PROJECT.pages.dev")"
  fi
fi

# =============================================================================
# ⑦ 获取站点文件
# =============================================================================
step "$(t bdl_title)"
WORK="$(mktemp -d)"; DIST="$WORK/dist"; mkdir -p "$DIST"
cleanup() { rm -rf "$WORK"; }
trap cleanup EXIT

if [ -z "$BUNDLE_URL" ]; then
  info "$(t bdl_query)"
  REL=$(curl -sS --connect-timeout 20 --retry 2 --retry-delay 2 \
          "https://api.github.com/repos/$REPO/releases" 2>/dev/null)
  # 注意：必须用 /releases（列表），/releases/latest 不含预发行版
  readarray -t B_INFO < <(printf '%s' "$REL" | jq_py '
import sys,json
try: d=json.load(sys.stdin)
except Exception: sys.exit(0)
if not isinstance(d,list) or not d: sys.exit(0)
r=d[0]
print(r.get("tag_name",""))
for a in r.get("assets",[]):
    if a["name"].endswith(".tar.gz"): print(a["browser_download_url"]); break
else:
    for a in r.get("assets",[]):
        if a["name"].endswith(".zip"): print(a["browser_download_url"]); break
' 2>/dev/null || true)
  TAG="${B_INFO[0]:-}"; BUNDLE_URL="${B_INFO[1]:-}"
  [ -n "$TAG" ] && ok "$(t bdl_found "$TAG")"
fi
[ -n "$BUNDLE_URL" ] || { bad "$(t bdl_fail)"; dim "  $(t bdl_how)"; exit 1; }

info "$(t bdl_down)"
case "$BUNDLE_URL" in
  *.zip) fetch_retry "$BUNDLE_URL" "$WORK/b.zip" || { bad "$(t bdl_fail)"; dim "  $(t bdl_manual)"; dim "  $BUNDLE_URL"; die "$(t bdl_how)"; }
         ( cd "$DIST" && unzip -qo "$WORK/b.zip" ) || die "$(t bdl_fail)" ;;
  *)     fetch_retry "$BUNDLE_URL" "$WORK/b.tgz" || { bad "$(t bdl_fail)"; dim "  $(t bdl_manual)"; dim "  $BUNDLE_URL"; die "$(t bdl_how)"; }
         tar xzf "$WORK/b.tgz" -C "$DIST" || die "$(t bdl_fail)" ;;
esac
for f in index.html app.js sw.js worker.js wasm_exec.js xray.wasm _headers; do
  [ -f "$DIST/$f" ] || die "$(t bdl_bad "$f")"
done
ok "$(t bdl_ok "$(find "$DIST" -maxdepth 1 -type f | wc -l)")"

# =============================================================================
# ⑧ 资源指纹 + manifest
# =============================================================================
step "$(t key_title)"
python3 - "$DIST" "$WORK" <<'PY'
import sys, os, json, hashlib, mimetypes
dist, work = sys.argv[1], sys.argv[2]
skip = {'_headers', '_redirects', '_routes.json'}
EXTRA = {'.wasm':'application/wasm', '.js':'application/javascript', '.mjs':'application/javascript',
         '.css':'text/css', '.html':'text/html', '.json':'application/json',
         '.svg':'image/svg+xml', '.png':'image/png', '.jpg':'image/jpeg', '.ico':'image/x-icon'}
manifest, hashes, rows = {}, [], []
for fn in sorted(os.listdir(dist)):
    full = os.path.join(dist, fn)
    if not os.path.isfile(full) or fn in skip: continue
    data = open(full, 'rb').read()
    h = hashlib.sha256(data).hexdigest()[:32]
    ext = os.path.splitext(fn)[1].lower()
    # ⚠️ contentType 必须是裸 MIME：带 "; charset=…" 会导致部署成功但全站 500
    ct = EXTRA.get(ext) or mimetypes.guess_type(fn)[0] or 'application/octet-stream'
    ct = ct.split(';')[0].strip()
    manifest['/' + fn] = h
    hashes.append(h)
    rows.append(f'{h}\t{fn}\t{ct}\t{len(data)}')
    print(f"   /{fn}  {h[:10]}...  {len(data)}B  {ct}")
open(os.path.join(work,'manifest.json'),'w').write(json.dumps(manifest))
open(os.path.join(work,'hashes.json'),'w').write(json.dumps({"hashes": hashes}))
open(os.path.join(work,'map.tsv'),'w').write('\n'.join(rows))
PY
info "$(t key_n "$(grep -c '' "$WORK/map.tsv")")"

# =============================================================================
# ⑨ JWT
# =============================================================================
JWT=$(curl -sS --connect-timeout 20 -H "Authorization: Bearer $TOKEN" \
       "$API/accounts/$AID/pages/projects/$PROJECT/upload-token" 2>/dev/null \
      | jq_py 'import sys,json
try: print(json.load(sys.stdin).get("result",{}).get("jwt",""))
except Exception: print("")')
[ -n "$JWT" ] || die "$(t jwt_fail)"

# =============================================================================
# ⑩ 查缺
# =============================================================================
step "$(t miss_title)"
MISSING=$(curl -sS --connect-timeout 20 -X POST "$API/pages/assets/check-missing" \
            -H "Authorization: Bearer $JWT" -H "Content-Type: application/json" \
            --data-binary @"$WORK/hashes.json" 2>/dev/null \
          | jq_py 'import sys,json
try: print(json.dumps(json.load(sys.stdin).get("result",[])))
except Exception: print("[]")')
NMISS=$(printf '%s' "$MISSING" | jq_py 'import sys,json;print(len(json.load(sys.stdin)))')

# =============================================================================
# ⑪ 上传
# =============================================================================
if [ "$NMISS" -gt 0 ]; then
  step "$(t up_title)"
  info "$(t miss_n "$NMISS")"
  python3 - "$DIST" "$WORK" "$MISSING" <<'PY'
import sys, os, json, base64
dist, work, missing = sys.argv[1], sys.argv[2], json.loads(sys.argv[3])
missing = set(missing)
payload = []
for row in open(os.path.join(work,'map.tsv')):
    h, fn, ct, size = row.rstrip('\n').split('\t')
    if h not in missing: continue
    data = open(os.path.join(dist, fn), 'rb').read()
    payload.append({"key": h, "value": base64.b64encode(data).decode(),
                    "metadata": {"contentType": ct}, "base64": True})
    print(f"   + {fn} ({size}B)")
open(os.path.join(work,'upload.json'),'w').write(json.dumps(payload))
PY
  UP=$(curl -sS --connect-timeout 20 -X POST "$API/pages/assets/upload" \
         -H "Authorization: Bearer $JWT" -H "Content-Type: application/json" \
         --data-binary @"$WORK/upload.json" 2>/dev/null)
  [ "$(printf '%s' "$UP" | jtrue)" = "1" ] || die "$(t up_fail "$UP")"
  ok "$(t miss_n "$NMISS")"
else
  ok "$(t miss_none)"
fi

# ⑫ 登记哈希
curl -sS --connect-timeout 20 -X POST "$API/pages/assets/upsert-hashes" \
  -H "Authorization: Bearer $JWT" -H "Content-Type: application/json" \
  --data-binary @"$WORK/hashes.json" >/dev/null 2>&1 || true

# =============================================================================
# ⑬ 创建部署
# =============================================================================
step "$(t dep_title)"
CURL_ARGS=(-sS -X POST "$API/accounts/$AID/pages/projects/$PROJECT/deployments"
           -H "Authorization: Bearer $TOKEN"
           -F "manifest=<$WORK/manifest.json;type=application/json"
           -F "branch=$BRANCH")
[ -f "$DIST/_headers" ] && CURL_ARGS+=(-F "_headers=@$DIST/_headers;filename=_headers")
DEP=$(curl "${CURL_ARGS[@]}" 2>/dev/null)
readarray -t D_INFO < <(printf '%s' "$DEP" | jq_py '
import sys,json
try: d=json.load(sys.stdin)
except Exception: sys.exit(0)
r=d.get("result") or {}
print(r.get("id","")); print(r.get("url",""))
' 2>/dev/null || true)
DID="${D_INFO[0]:-}"; DURL="${D_INFO[1]:-}"
[ -n "$DID" ] || die "$(t dep_fail "$DEP")"

# =============================================================================
# ⑭ 轮询
# =============================================================================
step "$(t poll_title)"
STATUS=""
for _ in $(seq 1 40); do
  STATUS=$(curl -sS --connect-timeout 20 -H "Authorization: Bearer $TOKEN" \
             "$API/accounts/$AID/pages/projects/$PROJECT/deployments/$DID" 2>/dev/null \
           | jq_py 'import sys,json
try: print(json.load(sys.stdin).get("result",{}).get("latest_stage",{}).get("status",""))
except Exception: print("")')
  printf '   %s%s%s\n' "$C_DIM" "$STATUS" "$C_RST"
  case "$STATUS" in
    success) break ;;
    failure|canceled) die "$(t poll_bad "$STATUS")" ;;
  esac
  sleep 3
done
[ "$STATUS" = "success" ] || die "$(t poll_timeout)"

# =============================================================================
# ⑮ 完成
# =============================================================================
printf '\n'
hr
printf '%s  ✔ %s%s\n\n' "$C_BLD$C_GRN" "$(t ok_title)" "$C_RST"
printf '   %s%-12s%s %shttps://%s.pages.dev%s\n' "$C_BLD" "$(t ok_prod)" "$C_RST" "$C_CYA" "$PROJECT" "$C_RST"
printf '   %s%-12s%s %s%s%s\n\n'                  "$C_BLD" "$(t ok_prev)" "$C_RST" "$C_DIM" "$DURL" "$C_RST"
dim "   $(t ok_next)"
hr

# =============================================================================
# ⑯ 可选：绑定自定义域名
# =============================================================================
printf '\n'
info "$(t dom_q)"
ask "$(t dom_yn)" "n"
if [[ "$REPLY_INPUT" =~ ^[yY]$ ]]; then
  ask "$(t dom_input)"
  DOMAIN="$REPLY_INPUT"
  if [ -n "$DOMAIN" ]; then
    DRES=$(curl -sS --connect-timeout 20 -X POST "$API/accounts/$AID/pages/projects/$PROJECT/domains" \
             -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
             --data "{\"name\":\"$DOMAIN\"}" 2>/dev/null)
    if   [ "$(printf '%s' "$DRES" | jtrue)" = "1" ]; then ok "$(t dom_ok)"
    elif printf '%s' "$DRES" | jerr | grep -qE '9109|10000'; then warn "$(t dom_for)"
    else bad "$(t dom_fail "$DRES")"; fi
  fi
fi

printf '\n%s\n\n' "$(t bye)"
