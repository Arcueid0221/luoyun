#!/bin/bash
# 接口冒烟测试：只看状态码和响应形状，不下载任何东西、不改任何记录。
#
#   npm run smoke
#
# 5678 上已经有 dev server 就直接用它，没有就自己起一个、跑完收掉。
# 已登录和未登录两种情况的期望值不同（requireAuth 那批路由未登录时全是 401），
# 脚本先问一次 /api/auth/status 再决定期望哪个码。
#
# 注意：紧跟中文的变量一律写 ${VAR}。这个 locale 下 bash 会把中文字节
# 当成变量名的一部分，`$LOG）` 会变成一个不存在的变量名（配上 set -u 直接退出）。
set -u

BASE="http://127.0.0.1:5678"
LOG="${TMPDIR:-/tmp}/luoyun-smoke-dev.log"
BODY="${TMPDIR:-/tmp}/luoyun-smoke-body"
HEADERS="${TMPDIR:-/tmp}/luoyun-smoke-headers"
BIG="${TMPDIR:-/tmp}/luoyun-smoke-big"
pass=0
fail=0
DEV_PID=""

port_pids() { lsof -ti tcp:5678 2>/dev/null; }

cleanup() {
  rm -f "$BODY" "$HEADERS" "$BIG"
  # 只在"这次是我起的"时候收。按端口找，不杀进程组 ——
  # npm run dev 和本脚本同组，kill -- -PGID 会把脚本自己一起带走。
  [ -z "$DEV_PID" ] && return 0
  kill "$DEV_PID" 2>/dev/null
  local pids
  pids=$(port_pids)
  [ -n "$pids" ] && kill $pids 2>/dev/null
  sleep 0.5
  pids=$(port_pids)
  [ -n "$pids" ] && kill -9 $pids 2>/dev/null
  return 0
}
trap cleanup EXIT

if ! curl -s -o /dev/null --max-time 2 "$BASE/api/auth/status"; then
  echo "5678 上没人，起一个 dev server（日志：${LOG}）"
  npm run dev > "$LOG" 2>&1 &
  DEV_PID=$!
  for _ in $(seq 1 60); do
    curl -s -o /dev/null --max-time 2 "$BASE/api/auth/status" && break
    if ! kill -0 "$DEV_PID" 2>/dev/null; then
      echo "起不来："
      tail -30 "$LOG"
      exit 1
    fi
    sleep 0.5
  done
fi

# 未登录时 requireAuth 那批返回 401，登录了才走到各自的逻辑
if curl -s --max-time 5 "$BASE/api/auth/status" | grep -q '"authenticated":true'; then
  AUTHED=1
  echo "当前：已登录（requireAuth 的路由会走进真实逻辑）"
else
  AUTHED=0
  echo "当前：未登录（requireAuth 的路由应该全是 401）"
fi
echo

# check <名字> <未登录期望> <已登录期望> [curl 参数...]
check() {
  local name="$1" want
  want=$([ "$AUTHED" = 1 ] && echo "$3" || echo "$2")
  shift 3
  local code
  code=$(curl -s --max-time 10 -o "$BODY" -w '%{http_code}' "$@")
  if [ "$code" = "$want" ]; then
    pass=$((pass + 1))
    printf '  ok   %-3s %s\n' "$code" "$name"
  else
    fail=$((fail + 1))
    printf '  FAIL want %s got %s  %s\n       body: %s\n' \
      "$want" "$code" "$name" "$(head -c 200 "$BODY")"
  fi
}

# 响应体必须是 JSON 对象，不能是 Vite 那张带堆栈的 HTML 报错页
check_json() {
  if head -c 1 "$BODY" | grep -q '{'; then
    pass=$((pass + 1))
    printf '  ok   json %s — %s\n' "$1" "$(head -c 120 "$BODY")"
  else
    fail=$((fail + 1))
    printf '  FAIL 不是 JSON  %s — %s\n' "$1" "$(head -c 200 "$BODY")"
  fi
}

echo "--- 基本路由 ---"
check "GET /api/auth/status" 200 200 "$BASE/api/auth/status"
check_json "auth/status"
check "GET /api/nope" 404 404 "$BASE/api/nope"
check_json "404 也要是 JSON"

echo "--- requireAuth ---"
check "GET /api/fs/default" 401 200 "$BASE/api/fs/default"
check "GET /api/fs/list" 401 200 "$BASE/api/fs/list"
check "GET /api/fs/list?path=/etc（家目录外）" 401 400 "$BASE/api/fs/list?path=/etc"
check "GET /api/playlists" 401 200 "$BASE/api/playlists"
check "GET /api/download" 401 200 "$BASE/api/download"
check "GET /api/download/nope" 401 404 "$BASE/api/download/nope"
check "GET /api/download/nope/events（SSE 也要挡）" 401 404 "$BASE/api/download/nope/events"
check "POST /api/download/nope/cancel" 401 404 \
  -X POST -H 'Content-Type: application/json' "$BASE/api/download/nope/cancel"
# destDir 故意传数字：已登录时应该被 safeDir 判成 400，
# 传真路径会真的删掉那个目录的幂等记录，冒烟测试不能有副作用
check "POST /api/download/forget（destDir 不是字符串）" 401 400 \
  -X POST -H 'Content-Type: application/json' -d '{"destDir":123}' "$BASE/api/download/forget"
# 没勾任何内容项，会在联网之前就 400，不会真的建任务
check "POST /api/download（没选内容）" 401 400 \
  -X POST -H 'Content-Type: application/json' -d '{"playlistId":"1"}' "$BASE/api/download"

echo "--- 跨站防护 ---"
check "Sec-Fetch-Site: cross-site" 403 403 -H 'Sec-Fetch-Site: cross-site' "$BASE/api/auth/status"
check "Sec-Fetch-Site: same-site（本机别的端口）" 403 403 \
  -H 'Sec-Fetch-Site: same-site' "$BASE/api/auth/status"
check "Sec-Fetch-Site: same-origin 放行" 200 200 \
  -H 'Sec-Fetch-Site: same-origin' "$BASE/api/auth/status"
check "Origin 和 Host 不一致" 403 403 -H 'Origin: http://evil.example' "$BASE/api/auth/status"
check "Origin: null（sandbox iframe / file://）" 403 403 -H 'Origin: null' "$BASE/api/auth/status"
check "Origin 一致放行" 200 200 -H "Origin: $BASE" "$BASE/api/auth/status"
check "写请求带 text/plain" 415 415 -X POST -H 'Content-Type: text/plain' -d 'x' "$BASE/api/auth/cookie"
check "写请求不带 Content-Type" 415 415 -X POST "$BASE/api/auth/logout"

curl -s --max-time 5 -o "$BODY" -D "$HEADERS" "$BASE/api/auth/status"
if grep -qi 'access-control-allow' "$HEADERS"; then
  fail=$((fail + 1))
  echo "  FAIL 响应里出现了 CORS 头：$(grep -i 'access-control-allow' "$HEADERS")"
else
  pass=$((pass + 1))
  echo "  ok   响应里没有任何 Access-Control-Allow-*"
fi

echo "--- 请求体与路径的形状 ---"
check "GET /api/playlists/%（坏转义）" 404 404 "$BASE/api/playlists/%"
check_json "坏转义"
check "body 是数组" 400 400 -X POST -H 'Content-Type: application/json' -d '[]' "$BASE/api/auth/cookie"
check "body 是 null" 400 400 -X POST -H 'Content-Type: application/json' -d 'null' "$BASE/api/auth/cookie"
check "body 不是合法 JSON" 400 400 -X POST -H 'Content-Type: application/json' -d '{oops' "$BASE/api/auth/cookie"
check "musicU 不是字符串" 400 400 \
  -X POST -H 'Content-Type: application/json' -d '{"musicU":123}' "$BASE/api/auth/cookie"
head -c 1200000 /dev/zero | tr '\0' 'a' > "$BIG"
check "请求体超过 1MB" 413 413 \
  -X POST -H 'Content-Type: application/json' --data-binary "@$BIG" "$BASE/api/auth/cookie"

echo
echo "通过 ${pass}，失败 ${fail}"
[ "${fail}" -eq 0 ]
