#!/usr/bin/env bash
#
# 把当前正式版的产物替换式发布到独立产物仓库（默认 Zero-wyc/ZviewerRelease）。
#
# 用法（在产物所在目录执行）：
#   TAG=v5.1.1 SHA=<commit> RELEASE_REPO_TOKEN=<pat> bash scripts/publish-release-repo.sh
#
# 三个产物 + latest.json + README.md 一起进目标仓库的 main，用孤儿提交 force push，
# 所以仓库里永远只有「当前版本」这一份文件，旧包随旧提交一起消失。
#
# 环境变量：
#   TAG                 必需，如 v5.1.1
#   VERSION             可选，缺省从 TAG 去掉 v 前缀
#   SHA                 必需，构建所用 commit（写进 latest.json 与提交信息）
#   RELEASE_REPO_TOKEN  必需，对目标仓库有 contents:write 的 PAT
#   TARGET_REPO         可选，默认 Zero-wyc/ZviewerRelease
#   TARGET_BRANCH       可选，默认 main
#   SRC_DIR             可选，产物所在目录，默认当前目录
#   PUSH_URL            可选，覆盖推送地址（本地联调指向裸仓库用）
#   MIRROR_PUSH_URL     可选，第二个推送地址（GitCode 产物仓库）。给了就推同一份孤儿提交，
#                       客户端正是从那边取清单和安装包，必须跟着发版一起更新。
#   VERIFY_MIRROR       可选，默认 1：推完 GitCode 后回读 latest.json 与一个安装包，核对是否落地
#   MIRROR_RAW_BASE     可选，覆盖清单/下载地址前缀（默认 GitCode 的 /raw 接口，换通道时改这里）
#
# 为什么用绝对路径 + find 兜底：构建里曾出现过「test -f 通过、cp ../x 却报不存在」的情况
# （见 publish-branch 的失败日志），产物被 merge 到哪一层不由我们控制，所以先按名字找，
# 找不到再递归找一层，最后才报错退出。

set -euo pipefail

TAG="${TAG:?缺少 TAG}"
SHA="${SHA:?缺少 SHA}"
RELEASE_REPO_TOKEN="${RELEASE_REPO_TOKEN:?缺少 RELEASE_REPO_TOKEN}"
VERSION="${VERSION:-${TAG#v}}"
TARGET_REPO="${TARGET_REPO:-Zero-wyc/ZviewerRelease}"
TARGET_BRANCH="${TARGET_BRANCH:-main}"

FILES="zviewer-linux-x64.tar.gz zviewer-windows-x64.zip zviewer-windows-x64-GUI.zip"
SRC_DIR="${SRC_DIR:-$PWD}"

echo "== 产物目录：${SRC_DIR}"
ls -la "${SRC_DIR}" || true
echo "== 目录内压缩包（递归 3 层）"
find "${SRC_DIR}" -maxdepth 3 -type f \( -name '*.zip' -o -name '*.tar.gz' \) \
  -printf '  %p  %s bytes\n' 2>/dev/null || true

OUT="$(mktemp -d)"
trap 'rm -rf "${OUT}"' EXIT

for f in ${FILES}; do
  src="${SRC_DIR}/${f}"
  if [ ! -f "${src}" ]; then
    src="$(find "${SRC_DIR}" -maxdepth 3 -type f -name "${f}" -print -quit 2>/dev/null || true)"
  fi
  if [ -z "${src}" ] || [ ! -f "${src}" ]; then
    echo "::error::缺少产物 ${f}（已在上方列出目录内所有压缩包）"
    exit 1
  fi
  cp -v "${src}" "${OUT}/${f}"
done

# 版本清单：网页端与 GUI 的自动更新直接读它，不再解析各平台 Release 接口
# （GitCode 的 created_at 升序、字段缺失那些坑随之一并消失）。
#
# 每个产物都带一个 url：客户端优先用它，缺失才按自己的镜像前缀拼。这样以后
# 换下载通道（或者某个站不可用了）只改这里，不用等客户端发版。
#
# 直链走 api.gitcode.com 的仓库文件接口，而不是 raw.gitcode.com：
# 后者前面挂了 CloudWAF，对非浏览器的 TLS 指纹一律回 418「访问被拦截」，
# 伪装 UA / Referer 都没用；这个接口返回 application/octet-stream、支持 Range，
# 实测 52MB 安装包 8.8MB/s。
MIRROR_URL_BASE="${MIRROR_RAW_BASE:-https://api.gitcode.com/api/v5/repos/${TARGET_REPO}/raw}"
assets_json='[]'
for f in ${FILES}; do
  size=$(stat -c%s "${OUT}/${f}")
  sha=$(sha256sum "${OUT}/${f}" | cut -d' ' -f1)
  url="${MIRROR_URL_BASE}/${f}?ref=${TARGET_BRANCH}"
  assets_json=$(jq -c --arg n "${f}" --argjson s "${size}" --arg h "${sha}" --arg u "${url}" \
    '. + [{name:$n, size:$s, sha256:$h, url:$u}]' <<<"${assets_json}")
done
jq -n \
  --arg tag "${TAG}" \
  --arg version "${VERSION}" \
  --arg commit "${SHA}" \
  --arg publishedAt "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" \
  --arg releaseUrl "https://github.com/Zero-wyc/ZViewer/releases/tag/${TAG}" \
  --argjson assets "${assets_json}" \
  '{tag:$tag, version:$version, commit:$commit, publishedAt:$publishedAt, releaseUrl:$releaseUrl, assets:$assets}' \
  > "${OUT}/latest.json"
echo "== latest.json"
cat "${OUT}/latest.json"

{
  echo "# ZViewer 预编译包（${TAG}）"
  echo ""
  echo "由 GitHub Actions 自动发布，内容与 [GitHub Release ${TAG}](https://github.com/Zero-wyc/ZViewer/releases/tag/${TAG}) 完全一致；每次发版会整体替换本仓库。"
  echo ""
  echo "## 下载"
  echo ""
  echo "- **Windows**：\`zviewer-windows-x64.zip\` — 解压后运行 \`start.bat\`"
  echo "- **Windows GUI**：\`zviewer-windows-x64-GUI.zip\` — 解压后运行 \`ZViewerDesktop.exe\`"
  echo "- **Linux**：\`zviewer-linux-x64.tar.gz\` — 解压后运行 \`./start.sh\`"
  echo ""
  echo "## 下载地址"
  echo ""
  echo "更新器用的直链（GitCode 仓库文件接口，支持 Range、不走 CloudWAF）："
  echo ""
  echo "\`\`\`"
  echo "${MIRROR_URL_BASE}/<文件名>?ref=${TARGET_BRANCH}"
  echo "\`\`\`"
  echo ""
  echo "浏览器里手动下载更方便的是 GitHub Release："
  echo "\`https://github.com/Zero-wyc/ZViewer/releases/download/${TAG}/<文件名>\`"
  echo ""
  echo "构建提交：https://github.com/Zero-wyc/ZViewer/commit/${SHA}"
  echo "发布时间：$(date -u '+%Y-%m-%d %H:%M:%S UTC')"
} > "${OUT}/README.md"

# 孤儿提交重建：目标仓库历史上永远只有「当前版本」这一个提交，
# 上一次的文件自然就没了，也不用处理"哪些该删哪些该留"。
PUSH_URL="${PUSH_URL:-https://x-access-token:${RELEASE_REPO_TOKEN}@github.com/${TARGET_REPO}.git}"

git -C "${OUT}" init -q -b "${TARGET_BRANCH}"
git -C "${OUT}" config user.name "github-actions[bot]"
git -C "${OUT}" config user.email "41898282+github-actions[bot]@users.noreply.github.com"
git -C "${OUT}" add -A
git -C "${OUT}" commit -qm "release: ${TAG} (${SHA:0:7})"
git -C "${OUT}" push --force "${PUSH_URL}" "HEAD:refs/heads/${TARGET_BRANCH}"
echo "== ${TARGET_REPO} 已更新 → ${TAG}"

# 同一份内容推到 GitCode 产物仓库：客户端走 api.gitcode.com 的仓库文件接口取清单和包，
# 那边不跟着更新，用户就会一直被告知「已是最新」。历史分叉也无所谓，force 覆盖成同一棵树。
if [ -n "${MIRROR_PUSH_URL:-}" ]; then
  echo "== 推送到 GitCode 产物仓库"
  if ! out=$(GIT_TERMINAL_PROMPT=0 git -C "${OUT}" push --force "${MIRROR_PUSH_URL}" \
      "HEAD:refs/heads/${TARGET_BRANCH}" 2>&1); then
    printf '%s\n' "${out}" | sed -E 's#https://[^@[:space:]]*@#https://***@#g'
    # GitCode 的镜像仓（image repository）只读：镜像方向是 GitCode 从 GitHub 拉，
    # 远端回 CH.00905403。平台会自己按节奏追上，所以只告警、不判失败；
    # 要「发版即同步」得去 GitCode 关掉 Pull 镜像。
    if printf '%s' "${out}" | grep -qiE 'image repository|CH\.00905403'; then
      echo "::warning::GitCode 的 ${TARGET_REPO} 是镜像仓（只读），平台拒绝了 CI 推送。GitCode 会自己从 GitHub 拉取，本次发版稍后才生效；要做到发版即同步，请在 GitCode 项目设置 → 仓库镜像 关闭 Pull 镜像。"
      exit 0
    fi
    echo "::error::GitCode 产物仓库推送失败，客户端会继续读到旧清单"
    exit 1
  fi
  printf '%s\n' "${out}" | sed -E 's#https://[^@[:space:]]*@#https://***@#g'
  echo "== GitCode 产物仓库已更新"

  # 回读校验：GitCode 的 raw 接口偶有延迟，轮询到新 tag 出现为止（最多 ~2 分钟）。
  # 只告警不失败——推送本身成功就说明内容已经进库，读慢一点不该把发版判成失败。
  if [ "${VERIFY_MIRROR:-1}" = "1" ]; then
    GOT_TAG=''
    for _ in $(seq 1 12); do
      GOT_TAG=$(curl -fsS -m 20 "${MIRROR_URL_BASE}/latest.json?ref=${TARGET_BRANCH}" 2>/dev/null \
        | jq -r '.tag // empty' 2>/dev/null || true)
      if [ "${GOT_TAG}" = "${TAG}" ]; then break; fi
      sleep 10
    done
    if [ "${GOT_TAG}" = "${TAG}" ]; then
      echo "== 回读 GitCode 清单：tag=${GOT_TAG} ✅"
      MANIFEST="$(curl -fsS -m 20 "${MIRROR_URL_BASE}/latest.json?ref=${TARGET_BRANCH}" 2>/dev/null || echo '{}')"
      for f in ${FILES}; do
        url=$(jq -r --arg n "${f}" '.assets[] | select(.name==$n) | .url // empty' <<<"${MANIFEST}" 2>/dev/null || true)
        [ -n "${url}" ] || { echo "::warning::清单里 ${f} 没有 url"; continue; }
        head_out=$(curl -fsS -m 30 -r 0-1023 -o /dev/null -D - "${url}" 2>/dev/null || true)
        total=$(printf '%s' "${head_out}" | tr -d '\r' | awk -F'/' 'tolower($1) ~ /content-range/ {print $2}' | head -1)
        code=$(printf '%s' "${head_out}" | head -1 | awk '{print $2}')
        want=$(stat -c%s "${OUT}/${f}")
        echo "   ${f}  HTTP ${code:-?}  总字节 ${total:-?}  期望 ${want}"
        [ "${code}" = '200' ] || [ "${code}" = '206' ] || echo "::warning::${f} 取不到内容（HTTP ${code:-无响应}）"
        if [ -n "${total}" ] && [ "${total}" != "${want}" ]; then
          echo "::warning::${f} 的大小对不上（远端 ${total} / 本地 ${want}），可能还没同步完"
        fi
      done
    else
      echo "::warning::GitCode 上 latest.json 仍是 ${GOT_TAG:-读不到}（期望 ${TAG}），稍后可手动复查：${MIRROR_URL_BASE}/latest.json?ref=${TARGET_BRANCH}"
    fi
  fi
else
  echo "::warning::未提供 MIRROR_PUSH_URL，GitCode 产物仓库未更新（客户端会读到旧清单）"
fi
