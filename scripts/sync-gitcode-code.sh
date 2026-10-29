#!/usr/bin/env bash
#
# 把正式版的 main 提交与 tag 推送到 GitCode 镜像仓库（默认 Zero-wyc/ZViewer）。
#
# 为什么必须显式推：GitCode 没有开放「立刻同步一次」的接口（mirror/pull、mirror/sync
# 这类路由实测全是 404 Route Not Found），仓库侧也不保证跟着 GitHub 走。发版时不主动
# 推一次，gitcode.com 上就停在旧提交，用户看到的代码、tag、Releases 全是旧的。
#
# 用法：
#   GITCODE_TOKEN=xxx TAG=v5.1.1 SHA=<commit> bash scripts/sync-gitcode-code.sh
#   GITCODE_TOKEN=xxx SHA=<commit> bash scripts/sync-gitcode-code.sh      # 只同步分支，不带 tag
#
# 环境变量：
#   GITCODE_TOKEN   必需，GitCode 私人令牌（需对目标仓库有写权限）
#   SHA             必需，要放到 main 上的提交（取自构建时解析出的 sha）
#   TAG             可选，如 v5.1.1；留空则只同步分支
#   GITCODE_OWNER   可选，默认 Zero-wyc
#   GITCODE_REPO    可选，默认 ZViewer
#   GITCODE_BRANCH  可选，默认 main
#   GITCODE_URL     可选，覆盖推送地址（本地联调指向裸仓库用，需自带凭据）
#
# 幂等：main 已经指向该提交时跳过推送；tag 一律 --force 覆盖（同一次发版重跑不会冲突）。

set -euo pipefail

GITCODE_TOKEN="${GITCODE_TOKEN:?缺少 GITCODE_TOKEN}"
TAG="${TAG:-}"
SHA="${SHA:?缺少 SHA}"
GITCODE_OWNER="${GITCODE_OWNER:-Zero-wyc}"
GITCODE_REPO="${GITCODE_REPO:-ZViewer}"
GITCODE_BRANCH="${GITCODE_BRANCH:-main}"

REPO_URL="${GITCODE_URL:-https://${GITCODE_OWNER}:${GITCODE_TOKEN}@gitcode.com/${GITCODE_OWNER}/${GITCODE_REPO}.git}"

# 任何输出都过一遍脱敏：git 的报错里会带完整 URL（含 token）。
mask() { sed -E 's#https://[^@[:space:]]*@#https://***@#g'; }

echo "== 目标：gitcode.com/${GITCODE_OWNER}/${GITCODE_REPO}（${GITCODE_BRANCH}${TAG:+ + tag ${TAG}}）"
echo "== 提交：${SHA}"

# 先探一次连通性：仓库不存在 / token 无效时，这里的报错比后面 push 的报错清楚得多
if ! probe=$(GIT_TERMINAL_PROMPT=0 git ls-remote "${REPO_URL}" 2>&1 >/dev/null); then
  printf '%s\n' "${probe}" | mask
  echo "::error::连不上 ${GITCODE_OWNER}/${GITCODE_REPO}：确认仓库地址、GITCODE_TOKEN 是否有效、账号是否有该仓库的访问权限。"
  exit 1
fi

# GitCode 的「镜像仓」（image repository）是只读的：镜像方向是 GitCode 从 GitHub 拉，
# 不接受任何写入，远端会回 `<CH.00905403> ... repository is an image repository`。
# 这种状态下 CI 推不上去，但平台会按自己的节奏把 GitHub 的新提交拉过来——只是晚一点，
# 不会丢东西。所以按「跳过 + 告警」处理，不把已经成功的 GitHub 发版判成失败。
is_image_repo() {
  printf '%s' "$1" | grep -qiE 'image repository|CH\.00905403'
}

skip_image_repo() {
  echo "::warning::${GITCODE_OWNER}/${GITCODE_REPO} 是 GitCode 的镜像仓（只读），平台拒绝了 CI 推送（CH.00905403）。"
  echo "::warning::GitCode 会自己按平台节奏从 GitHub 拉取，本次发版稍后才能在那看到；要做到「发版即同步」，请到 GitCode 项目设置 → 仓库镜像 关闭 Pull 镜像，仓库变普通仓库后 CI 就能直接推。"
  exit 0
}

# 只读镜像仓（GitCode 侧配了 Pull 镜像）会拒绝写入，只能由人解除，这里给出准确指引。
explain_failure() {
  local log="$1"
  if printf '%s' "${log}" | grep -qiE 'image repository|mirror|read.?only|protected'; then
    echo "::error::GitCode 拒绝了写入：该仓库被配置成只读镜像仓。请到 GitCode「项目设置 → 仓库镜像」关闭 Pull 镜像（改为由 CI 直接推送），再重跑本 job。"
  elif printf '%s' "${log}" | grep -qiE 'authentication|403|401|denied'; then
    echo "::error::GitCode 认证失败：确认 Secret GITCODE_TOKEN 未过期，且该令牌的账号对 ${GITCODE_OWNER}/${GITCODE_REPO} 有写权限。"
  elif printf '%s' "${log}" | grep -qi 'non-fast-forward'; then
    echo "::error::GitCode 的 ${GITCODE_BRANCH} 有本地没见过的提交（历史分叉）。确认没人直接在 GitCode 上提交后，手动对齐一次即可。"
  elif printf '%s' "${log}" | grep -qi 'shallow'; then
    echo "::error::本地是浅克隆，缺提交对象，推不上去。工作流里 checkout 必须带 fetch-depth: 0。"
  fi
}

remote_sha() {
  git ls-remote "${REPO_URL}" "$1" 2>/dev/null | awk '{print $1}' | head -1
}

# annotated tag 的 ref 指向 tag 对象本身，`^{}` 才是它包住的提交；两个都取，优先解引用后的。
# 注意不能给 ls-remote 传 pattern——带 pattern 时它会把 `^{}` 那一行过滤掉。
remote_tag_commit() {
  git ls-remote --tags "${REPO_URL}" 2>/dev/null \
    | awk -v t="refs/tags/$1" '$2 == t"^{}" {d=$1} $2 == t {p=$1} END {print (d != "" ? d : p)}'
}

# ---- 1. 分支 ----
CUR="$(remote_sha "refs/heads/${GITCODE_BRANCH}" || true)"
if [ "${CUR}" = "${SHA}" ]; then
  echo "== ${GITCODE_BRANCH} 已是 ${SHA:0:7}，跳过分支推送"
else
  echo "== 推送 ${GITCODE_BRANCH}：${CUR:-（空仓库）} → ${SHA:0:7}"
  if ! out=$(GIT_TERMINAL_PROMPT=0 git push "${REPO_URL}" "${SHA}:refs/heads/${GITCODE_BRANCH}" 2>&1); then
    printf '%s\n' "${out}" | mask
    if is_image_repo "${out}"; then skip_image_repo; fi
    if printf '%s' "${out}" | grep -qiE 'non-fast-forward|fetch first|\[rejected\]'; then
      # 镜像语义：GitHub 是唯一真相源，GitCode 只需跟它一致。先把差异说清楚再强制对齐，
      # 用 --force-with-lease 钉住刚才读到的 sha，防止这中间有人又推了东西被无声覆盖。
      EXTRA='?'
      if git fetch -q --no-tags "${REPO_URL}" "refs/heads/${GITCODE_BRANCH}" 2>/dev/null; then
        EXTRA=$(git rev-list --count FETCH_HEAD "^${SHA}" 2>/dev/null || echo '?')
      fi
      echo "::warning::GitCode 的 ${GITCODE_BRANCH} 上有 ${EXTRA} 个这边没有的提交（分叉或历史被重写），按镜像语义强制对齐到 ${SHA:0:7}"
      if ! out=$(GIT_TERMINAL_PROMPT=0 git push \
          "--force-with-lease=refs/heads/${GITCODE_BRANCH}:${CUR}" \
          "${REPO_URL}" "${SHA}:refs/heads/${GITCODE_BRANCH}" 2>&1); then
        printf '%s\n' "${out}" | mask
        if is_image_repo "${out}"; then skip_image_repo; fi
        explain_failure "${out}"
        exit 1
      fi
    else
      explain_failure "${out}"
      exit 1
    fi
  fi
  printf '%s\n' "${out}" | mask
fi

# ---- 2. tag（TAG 留空时跳过，用于「只同步分支」的手动补跑）----
# 本地有指向本次提交的 tag 对象就推它（保留 annotated 语义）；否则把提交直接推到
# refs/tags/ 下，效果是轻量 tag，指向的提交一定是对的。宁可丢注释，也不能让镜像上的
# tag 指到别的提交——客户端的版本判断全看 tag。
if [ -n "${TAG}" ]; then
  TAG_REF_SHA="$(git rev-parse -q --verify "refs/tags/${TAG}^{commit}" 2>/dev/null || true)"
  if [ "${TAG_REF_SHA}" = "${SHA}" ]; then
    SRC="refs/tags/${TAG}"
  else
    SRC="${SHA}"
    if [ -n "${TAG_REF_SHA}" ]; then
      echo "::warning::本地 ${TAG} 指向 ${TAG_REF_SHA:0:7}，与本次构建 ${SHA:0:7} 不一致，按提交建轻量 tag"
    else
      echo "::warning::本地没有 ${TAG} 的 tag 对象，按提交 ${SHA:0:7} 建轻量 tag"
    fi
  fi
  echo "== 推送 tag ${TAG}"
  if ! out=$(GIT_TERMINAL_PROMPT=0 git push --force "${REPO_URL}" "${SRC}:refs/tags/${TAG}" 2>&1); then
    printf '%s\n' "${out}" | mask
    if is_image_repo "${out}"; then skip_image_repo; fi
    explain_failure "${out}"
    exit 1
  fi
  printf '%s\n' "${out}" | mask
else
  echo "== 未指定 TAG，只同步分支"
fi

# ---- 3. 回读校验 ----
GOT_BRANCH="$(remote_sha "refs/heads/${GITCODE_BRANCH}" || true)"
if [ "${GOT_BRANCH}" != "${SHA}" ]; then
  echo "::error::回读不一致：gitcode ${GITCODE_BRANCH} = ${GOT_BRANCH:-（空）}，期望 ${SHA}"
  exit 1
fi
if [ -n "${TAG}" ]; then
  GOT_TAG="$(remote_tag_commit "${TAG}" || true)"
  if [ "${GOT_TAG}" != "${SHA}" ]; then
    echo "::error::回读不一致：gitcode tag ${TAG} = ${GOT_TAG:-（空）}，期望 ${SHA}"
    exit 1
  fi
  echo "== 已同步：gitcode.com/${GITCODE_OWNER}/${GITCODE_REPO} ${GITCODE_BRANCH}=${SHA:0:7} tag=${TAG}"
else
  echo "== 已同步：gitcode.com/${GITCODE_OWNER}/${GITCODE_REPO} ${GITCODE_BRANCH}=${SHA:0:7}"
fi
