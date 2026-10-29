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
# 只存文件名/大小/sha256，下载地址由客户端按镜像 raw 前缀自己拼。
assets_json='[]'
for f in ${FILES}; do
  size=$(stat -c%s "${OUT}/${f}")
  sha=$(sha256sum "${OUT}/${f}" | cut -d' ' -f1)
  assets_json=$(jq -c --arg n "${f}" --argjson s "${size}" --arg h "${sha}" \
    '. + [{name:$n, size:$s, sha256:$h}]' <<<"${assets_json}")
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
  echo "本仓库里放的是同一份文件，但 **Gitee 的 raw 直链对大文件要求登录**"
  echo "（\`403 large file require login for access\`），命令行/更新器下载请走下面两处："
  echo ""
  echo "- GitHub Release：\`https://github.com/Zero-wyc/ZViewer/releases/download/${TAG}/<文件名>\`"
  echo "- GitCode Release：\`https://gitcode.com/Zero-wyc/ZViewer/releases/download/${TAG}/<文件名>\`"
  echo ""
  echo "客户端自动更新读的是 \`latest.json\`（体积很小，Gitee raw 可以正常匿名取）。"
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
