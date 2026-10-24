#!/usr/bin/env bash
# 在真实库副本 + 真实 B站 接口上验证 /api/stream/resolve-bilibili。
#
# 为什么必须打真实接口：解析链的价值全在「B站 到底返回什么」——
# 清晰度降级、试看虚报时长、轨道过滤这些行为，mock 数据永远造不对。
set -u
REPO=/f/Code/ZViewer/ZViewer
TESTDIR=/tmp/zvbili
BIN=/tmp/zviewerd.exe
HERE="$(cd "$(dirname "$0")" && pwd)"
. "$HERE/lib-proc.sh"

# 端口随机，见 lib-proc.sh 顶部说明（残留进程冒充本次构建是本类脚本最大的坑）。
PORT=$(pick_port)

rm -rf "$TESTDIR"; mkdir -p "$TESTDIR"
cp "$REPO/config/dev.sqlite" "$TESTDIR/dev.sqlite"

HASH=$(cd "$REPO" && node -e "console.log(require('bcryptjs').hashSync('bili-pass-1234',10))")
python - "$TESTDIR/dev.sqlite" "$HASH" <<'PY'
import sqlite3, sys
db, h = sys.argv[1], sys.argv[2]
c = sqlite3.connect(db)
c.execute('DELETE FROM "user" WHERE "username" = ?', ('bili-user',))
c.execute('INSERT INTO "user" ("username","passwordHash","role","status") VALUES (?,?,?,?)',
          ('bili-user', h, 'root', 'active'))
c.commit()
print('已插入 bili-user')
PY

CONFIG_DIR="$TESTDIR" PORT="$PORT" PROJECT_ROOT="$REPO" "$BIN" > "$TESTDIR/server.log" 2>&1 &
SRV=$!
trap 'kill_tree "$SRV"' EXIT

wait_ready "$PORT" Go "$TESTDIR/server.log" "\[start\] 监听" || exit 1
BASE="http://127.0.0.1:$PORT"
echo "端口 $PORT"

TOKEN=$(curl -s -X POST "$BASE/api/auth/login" -H 'Content-Type: application/json' \
  -d '{"username":"bili-user","password":"bili-pass-1234"}' \
  | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{console.log(JSON.parse(s).accessToken||'')}catch(e){console.log('')}})")
echo "token 长度: ${#TOKEN}"

# field <json-string> <path>：从 done 行取字段
field() {
  JS_JSON="$1" JS_PATH="$2" node -e "
    const o = JSON.parse(process.env.JS_JSON);
    let v = o;
    for (const k of process.env.JS_PATH.split('.')) v = v?.[k];
    console.log(v === undefined || v === null ? '' : (typeof v === 'object' ? JSON.stringify(v) : v));
  "
}

resolve() {
  curl -s -H "Authorization: Bearer $TOKEN" "$BASE/api/stream/resolve-bilibili?$1"
}

echo
echo "=== 1. 未鉴权 -> 期望 401 ==="
curl -s -o /dev/null -w "status=%{http_code}\n" "$BASE/api/stream/resolve-bilibili?url=BV1GJ411x7h7"

echo
echo "=== 2. 缺 url -> 期望 400 ==="
curl -s -H "Authorization: Bearer $TOKEN" "$BASE/api/stream/resolve-bilibili"; echo

echo
echo "=== 3. 无法识别的链接 -> 期望 400 ==="
curl -s -H "Authorization: Bearer $TOKEN" "$BASE/api/stream/resolve-bilibili?url=https://example.com/xyz"; echo

echo
echo "=== 4. UGC 匿名解析（单 P）==="
RAW=$(resolve "url=https://www.bilibili.com/video/BV1GJ411x7h7")
echo "$RAW"
DONE=$(echo "$RAW" | tail -1)
for f in format currentQn loggedIn vipStatus title duration cid videoCodec audioCodec isHdr; do
  echo "  $f = $(field "$DONE" "$f")"
done
echo "  acceptQuality = $(field "$DONE" acceptQuality)"
VURL=$(field "$DONE" videoUrl)
AURL=$(field "$DONE" audioUrl)
echo "  videoUrl 前 80 字符: ${VURL:0:80}"
echo -n "  videoUrl 可达性: "
if [ -n "$VURL" ]; then
  curl -s -o /dev/null -w "status=%{http_code} size=%{size_download}\n" -r 0-1023 \
    -H "Referer: https://www.bilibili.com" \
    -H "User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0.0.0" "$VURL"
else
  echo "(空)"
fi
if [ -n "$AURL" ]; then
  echo -n "  audioUrl 可达性: "
  curl -s -o /dev/null -w "status=%{http_code}\n" -r 0-1023 \
    -H "Referer: https://www.bilibili.com" \
    -H "User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0.0.0" "$AURL"
fi

echo
echo "=== 5. UGC 匿名 + 指定 qn=16（应真的降到 360P，而不是仍给最高档）==="
RAW16=$(resolve "url=https://www.bilibili.com/video/BV1GJ411x7h7&qn=16")
echo "$RAW16" | tail -1 | node -e "
let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{
  const o=JSON.parse(s);
  console.log('  format='+o.format, 'currentQn='+o.currentQn);
  console.log('  acceptQuality='+JSON.stringify((o.acceptQuality||[]).map(q=>q.id+':'+q.label)));
});"

echo
echo "=== 6. UGC MP4 直连模式（preferMp4）==="
RAWMP4=$(resolve "url=BV1GJ411x7h7&preferMp4=1")
echo "$RAWMP4" | tail -1 | node -e "
let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{
  const o=JSON.parse(s);
  console.log('  format='+o.format, 'currentQn='+o.currentQn, 'acceptQuality='+JSON.stringify((o.acceptQuality||[]).map(q=>q.id)));
  console.log('  videoUrl='+(o.videoUrl||'').slice(0,70));
});"

echo
echo "=== 7. PGC 免费集 ep321808（名侦探柯南 第1集）==="
RAWEP=$(resolve "url=https://www.bilibili.com/bangumi/play/ep321808")
echo "$RAWEP" | tail -1 | node -e "
let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{
  const o=JSON.parse(s);
  console.log('  title='+o.title);
  console.log('  format='+o.format, 'currentQn='+o.currentQn, 'duration='+o.duration);
  console.log('  epId='+o.epId, 'seasonId='+o.seasonId, 'seasonTitle='+o.seasonTitle, 'preview='+o.preview);
  console.log('  pages 数量='+(o.pages||[]).length, 'currentPage='+o.currentPage);
  console.log('  前 2 集='+JSON.stringify((o.pages||[]).slice(0,2)));
});"

echo
echo "=== 8. PGC 会员专享集 ep322558（匿名，应判为试看 MP4 且时长被压到片段长度）==="
RAWPAID=$(resolve "url=https://www.bilibili.com/bangumi/play/ep322558")
echo "$RAWPAID" | tail -1 | node -e "
let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{
  const o=JSON.parse(s);
  console.log('  format='+o.format, 'preview='+o.preview, 'duration='+o.duration, 'currentQn='+o.currentQn);
  console.log('  epId='+o.epId, 'title='+o.title);
  const cur=(o.pages||[]).find(p=>p.page===o.currentPage);
  console.log('  该集权威时长='+(cur?cur.duration:'?')+' 秒, badge='+(cur?cur.badge:'?'));
  console.log('  videoUrl='+(o.videoUrl||'').slice(0,70));
});"

echo
echo "=== 9. PGC 按 cid 切集（用 ep322559 的 cid）==="
curl -s -H "Authorization: Bearer $TOKEN" "$BASE/api/stream/resolve-bilibili?url=https://www.bilibili.com/bangumi/play/ep322559" \
  | tail -1 | node -e "
let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{
  const o=JSON.parse(s);
  console.log('  epId='+o.epId, 'currentPage='+o.currentPage, 'title='+o.title, 'format='+o.format, 'preview='+o.preview);
});"

echo
echo "=== 10. 不存在的 BV -> 期望业务错误码 VIDEO_NOT_FOUND ==="
resolve "url=https://www.bilibili.com/video/BV1xx411x7xx" | tail -1; echo

echo
echo "=== 11. 弹幕：按 cid 直取（cid 取自 ep321808，期望解析出上千条）==="
# 注意 cid=170001（早期的 av170001）弹幕池已关闭，接口返回 200 但没有任何 <d> 节点，
# 用它测解析等于什么都没测。
curl -s -H "Authorization: Bearer $TOKEN" "$BASE/api/stream/bilibili/danmaku?cid=26835486927" | node -e "
let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{
  const o=JSON.parse(s);
  const list=o.danmaku||[];
  console.log('  success='+o.success, '条数='+list.length);
  if(list.length){
    const bad=list.filter(x=>!x.id||typeof x.time!=='number'||x.content===undefined).length;
    console.log('  首条='+JSON.stringify(list[0]).slice(0,140));
    console.log('  字段缺失条数='+bad);
    const txt=list.map(x=>x.content).join('');
    console.log('  残留 &amp;/&lt; 实体='+/&(amp|lt|gt|quot|#39);/.test(txt));
    console.log('  id 唯一性='+(new Set(list.map(x=>x.id)).size===list.length));
  }
});"

echo
echo "=== 12. 弹幕：只给 bvid（服务端应自行补首 P 的 cid）==="
curl -s -H "Authorization: Bearer $TOKEN" "$BASE/api/stream/bilibili/danmaku?bvid=BV1GJ411x7h7" | node -e "
let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{
  const o=JSON.parse(s);
  const list=o.danmaku||[];
  console.log('  success='+o.success, '条数='+list.length, o.message||'');
  if(list.length) console.log('  首条='+JSON.stringify(list[0]).slice(0,140));
});"

echo
echo "=== 13. 弹幕：参数缺失 -> 期望 400 ==="
curl -s -o /dev/null -w "  status=%{http_code}\n" -H "Authorization: Bearer $TOKEN" \
  "$BASE/api/stream/bilibili/danmaku"

echo
echo "=== 14. 字幕：匿名态（B站 对未登录不下发字幕轨道，期望 lines 为空 + 该提示）==="
# cid 用 BV1GJ411x7h7 的真实 cid（137649199）。注意 cid ≠ aid：
# 拿 av170001 的 170001 当 cid 会查到一个毫不相干的稿件。
# 正路径（真拿到字幕行）需要带 SESSDATA 的 Cookie，匿名脚本里无法覆盖，
# 解析逻辑改由 subtitle_test.go 覆盖。
curl -s -H "Authorization: Bearer $TOKEN" \
  "$BASE/api/stream/bilibili/ai-subtitle?bvid=BV1GJ411x7h7&cid=137649199&duration=213" | node -e "
let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{
  const o=JSON.parse(s);
  const lines=o.lines||[];
  console.log('  success='+o.success, 'lines='+lines.length, 'source='+(o.source||'-'));
  console.log('  message='+(o.message||'(无)'));
  if(lines.length){
    console.log('  首行='+JSON.stringify(lines[0]).slice(0,120));
    console.log('  末行 to='+lines[lines.length-1].to);
  }
  const okEmpty=o.success===true && lines.length===0;
  console.log('  判定：'+(okEmpty?'符合匿名预期（200 + success:true + 空 lines）':'异常'));
});"

echo
echo "=== 15. 字幕：参数非法 -> 期望 400 ==="
curl -s -o /dev/null -w "  status=%{http_code}\n" -H "Authorization: Bearer $TOKEN" \
  "$BASE/api/stream/bilibili/ai-subtitle?bvid=not-a-bv&cid=0"

echo
echo "=== 服务器日志（bilibili 相关，末 25 行）==="
grep -E "\[bilibili|\[req\]" "$TESTDIR/server.log" | tail -25
