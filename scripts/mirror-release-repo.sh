#!/usr/bin/env bash
#
# 把 GitHub 上**已经发布好**的产物仓库（默认 Zero-wyc/ZviewerRelease）整棵树推到
# GitCode 同名仓库——不重新构建、不重新上传附件，只补一次镜像。
#
# 流程照 scripts/sync-gitcode-code.sh 那套来，逐条对应：
#   1. 先 ls-remote 预检：地址错、token 失效、没有权限，在动 90MB 之前就报清楚；
#   2. 幂等：GitCode 上已是这个版本（tag 对得上、三个包字节数也对得上）直接跳过，
#      连克隆都不做——重复点「Run workflow」不产生任何流量；
#   3. 推送失败按原因给结论（镜像仓只读 / 认证失败 / 超时 / 浅克隆），不是甩一整段 git 报错；
#   4. 推完回读：refs/heads 必须精确等于刚推的 commit，再逐个文件核对字节数。
#
# 为什么单独有这条路径：发版工作流里 `prepare` 有一条硬闸「该版本已有 Release 就报错」，
# 所以产物仓库推送一旦超时或失败，重跑整个 workflow 是不通的。而 GitHub 那份产物已经是
# 唯一真相源，force 覆盖一次就够，不必再算 130MB×3。
#
# 用法：
#   GITCODE_TOKEN=xxx bash scripts/mirror-release-repo.sh
#   GITCODE_TOKEN=xxx TAG=v5.2.1 bash scripts/mirror-release-repo.sh   # 校验并同步指定版本
#   GITCODE_TOKEN=xxx FORCE=1 bash scripts/mirror-release-repo.sh      # 跳过「已同步就跳过」
#
# 环境变量：
#   GITCODE_TOKEN       必需，对 GitCode 产物仓库有写权限的私人令牌
#   TAG                 可选，期望的版本号；留空则取 GitHub 侧 latest.json 的 tag
#   FORCE               可选，1 = 不做幂等短路，无条件重推
#   TARGET_REPO         可选，两边的仓库名，默认 Zero-wyc/ZviewerRelease
#   TARGET_BRANCH       可选，默认 main
#   SOURCE_URL          可选，GitHub 侧克隆地址（默认按 TARGET_REPO 拼）
#   MANIFEST_URL        可选，GitHub 侧 latest.json 地址（默认 raw.githubusercontent）
#   RELEASE_REPO_TOKEN  可选，GitHub 侧 PAT；不给我就走匿名克隆（仓库是公开的）
#   MIRROR_PUSH_URL     可选，GitCode 推送地址（默认按 TARGET_REPO 拼）
#   MIRROR_RAW_BASE     可选，回读用的接口前缀，默认 api.gitcode.com 的仓库文件接口
#   VERIFY_MIRROR       可选，默认 1：推完回读 refs 与三个包的字节数

set -euo pipefail

# shellcheck source=lib/mirror-push.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib/mirror-push.sh"

GITCODE_TOKEN="${GITCODE_TOKEN:?缺少 GITCODE_TOKEN}"
TAG="${TAG:-}"
FORCE="${FORCE:-0}"
TARGET_REPO="${TARGET_REPO:-Zero-wyc/ZviewerRelease}"
TARGET_BRANCH="${TARGET_BRANCH:-main}"
VERIFY_MIRROR="${VERIFY_MIRROR:-1}"
# 文件接口有缓存，推完成功后轮询到新 tag 出现为止；默认 12 次 × 10s ≈ 2 分钟。
VERIFY_POLL_ATTEMPTS="${VERIFY_POLL_ATTEMPTS:-12}"
VERIFY_POLL_SECONDS="${VERIFY_POLL_SECONDS:-10}"
FILES="zviewer-linux-x64.tar.gz zviewer-windows-x64.zip zviewer-windows-x64-GUI.zip"

if [ -n "${RELEASE_REPO_TOKEN:-}" ]; then
  SOURCE_URL="${SOURCE_URL:-https://x-access-token:${RELEASE_REPO_TOKEN}@github.com/${TARGET_REPO}.git}"
else
  SOURCE_URL="${SOURCE_URL:-https://github.com/${TARGET_REPO}.git}"
fi
MIRROR_PUSH_URL="${MIRROR_PUSH_URL:-https://Zero-wyc:${GITCODE_TOKEN}@gitcode.com/${TARGET_REPO}.git}"
MIRROR_RAW_BASE="${MIRROR_RAW_BASE:-https://api.gitcode.com/api/v5/repos/${TARGET_REPO}/raw}"
MANIFEST_URL="${MANIFEST_URL:-https://raw.githubusercontent.com/${TARGET_REPO}/${TARGET_BRANCH}/latest.json}"

tag_of() { sed -nE 's/.*"tag"[[:space:]]*:[[:space:]]*"([^"]+)".*/\1/p' <<<"$1" | head -1; }

# 清单里某个包的声明字节数。优先 jq（CI 的 ubuntu 镜像自带），退回 node（仓库里到处
# 都有），都没有就返回空——幂等判断会退化成「只比 tag」，不会误判成已同步。
manifest_size() {
  if command -v jq >/dev/null 2>&1; then
    jq -r --arg n "$1" '.assets[]? | select(.name == $n) | .size' <<<"$2" 2>/dev/null | head -1
  elif command -v node >/dev/null 2>&1; then
    node -e '
      let s = "";
      process.stdin.on("data", d => s += d).on("end", () => {
        try {
          const hit = (JSON.parse(s).assets || []).find(a => a.name === process.argv[1]);
          if (hit) console.log(hit.size);
        } catch (e) {}
      });
    ' "$1" <<<"$2"
  fi
}

# 远端文件总字节：只用 1KB 的 Range 请求读 Content-Range，不整包下载。
remote_size() {
  curl -fsS -m 30 -r 0-1023 -o /dev/null -D - "${MIRROR_RAW_BASE}/$1?ref=${TARGET_BRANCH}" 2>/dev/null \
    | tr -d '\r' | awk -F'/' 'tolower($1) ~ /content-range/ {print $2; exit}'
}

remote_manifest() {
  curl -fsS -m 20 "${MIRROR_RAW_BASE}/latest.json?ref=${TARGET_BRANCH}" 2>/dev/null || true
}

remote_sha() {
  git ls-remote "${MIRROR_PUSH_URL}" "refs/heads/${TARGET_BRANCH}" 2>/dev/null | awk '{print $1; exit}'
}

# ---- 1. 预检：先确认 GitCode 侧可达且有写权限 ----
# 目的很实际：别把 90MB 传完才发现 token 过期。ls-remote 的报错也比 push 清楚得多。
echo "== 预检 gitcode.com/${TARGET_REPO}（${TARGET_BRANCH}）"
if ! probe=$(GIT_TERMINAL_PROMPT=0 git ls-remote "${MIRROR_PUSH_URL}" 2>&1 >/dev/null); then
  printf '%s\n' "${probe}" | mask_url
  echo "::error::连不上 GitCode 的 ${TARGET_REPO}：确认仓库地址、GITCODE_TOKEN 是否有效、账号是否有该仓库的写权限。"
  exit 1
fi

# ---- 2. 解析要同步的版本：读 GitHub 侧清单，不为此克隆仓库 ----
echo "== 读取 GitHub 侧 latest.json"
GH_MANIFEST=$(curl -fsS -m 20 "${MANIFEST_URL}" 2>/dev/null || true)
if [ -z "${GH_MANIFEST}" ]; then
  if [ -z "${TAG}" ]; then
    echo "::error::读不到 ${MANIFEST_URL}，也不知道要同步哪个版本；请显式给 TAG"
    exit 1
  fi
  echo "::warning::读不到 ${MANIFEST_URL}，按指定的 TAG=${TAG} 继续（仓库私有或网络受限时正常）"
else
  GH_TAG=$(tag_of "${GH_MANIFEST}")
  if [ -n "${TAG}" ] && [ "${TAG}" != "${GH_TAG}" ]; then
    echo "::error::GitHub 侧产物仓库是 ${GH_TAG:-未知}，不是要同步的 ${TAG}。先确认发版 job 已成功，或换个 TAG。"
    exit 1
  fi
  TAG="${GH_TAG}"
fi
echo "== 目标版本：${TAG:-（由克隆到的清单决定）}"

# ---- 3. 幂等：GitCode 已经是这个版本就不动 ----
# tag 一致只说明清单进去了，还要三个包的字节数都对上才算同步完（先传完的大包 +
# 半路断掉的小包，会出现「清单新、附件旧」的中间态，客户端会下到 404）。
if [ "${FORCE}" != "1" ] && [ -n "${TAG}" ] && [ -n "${GH_MANIFEST}" ]; then
  if [ "$(tag_of "$(remote_manifest)")" = "${TAG}" ]; then
    synced=1
    for f in ${FILES}; do
      want=$(manifest_size "${f}" "${GH_MANIFEST}")
      case "${want}" in ''|null)
        synced=0
        echo "::warning::清单里读不到 ${f} 的 size（缺 jq？），跳过幂等判断"
        break ;;
      esac
      got=$(remote_size "${f}")
      if [ "${got}" != "${want}" ]; then
        echo "== ${f} 远端 ${got:-读不到} / 期望 ${want}，需要重推"
        synced=0
        break
      fi
    done
    if [ "${synced}" = "1" ]; then
      echo "== GitCode 上已是 ${TAG}，且三个包字节数一致，无需同步（要强制覆盖用 FORCE=1）"
      exit 0
    fi
  fi
fi

# ---- 4. 克隆 → 重建孤儿提交 ----
# 不能直接拿浅克隆去推：远端会以 `shallow update not allowed` 拒绝（缺祖先对象）。
# 而 --unshallow 要把历次发版留下的孤儿提交全拉一遍（仓库里堆着十几份百兆包），
# 与「快速补同步」的目的相反。所以照 publish-release-repo.sh 的办法：把工作树搬进
# 空仓库，重做一个孤儿提交——树的字节完全一致，历史只保留这一个提交。
OUT="$(mktemp -d)"
trap 'rm -rf "${OUT}"' EXIT

echo "== 克隆 ${TARGET_REPO}@${TARGET_BRANCH}（只取工作树）"
if ! clone_log=$(GIT_TERMINAL_PROMPT=0 git clone -q --depth 1 --branch "${TARGET_BRANCH}" \
    "${SOURCE_URL}" "${OUT}/src" 2>&1); then
  printf '%s\n' "${clone_log}" | mask_url
  echo "::error::克隆 ${TARGET_REPO} 失败：确认仓库地址可访问（私有仓需要 RELEASE_REPO_TOKEN）"
  exit 1
fi

if [ ! -f "${OUT}/src/latest.json" ]; then
  echo "::error::${TARGET_REPO} 的 ${TARGET_BRANCH} 上没有 latest.json"
  exit 1
fi

missing=''
for f in ${FILES}; do
  [ -f "${OUT}/src/${f}" ] || missing="${missing} ${f}"
done
if [ -n "${missing}" ]; then
  echo "::error::产物仓库缺少文件：${missing}"
  exit 1
fi

SRC_MANIFEST=$(cat "${OUT}/src/latest.json")
[ -n "${TAG}" ] || TAG=$(tag_of "${SRC_MANIFEST}")
SRC_SHA=$(sed -nE 's/.*"commit"[[:space:]]*:[[:space:]]*"([^"]+)".*/\1/p' <<<"${SRC_MANIFEST}" | head -1)

mkdir -p "${OUT}/out"
tar -C "${OUT}/src" --exclude=.git -cf - . | tar -C "${OUT}/out" -xf -
git -C "${OUT}/out" init -q -b "${TARGET_BRANCH}"
git -C "${OUT}/out" config user.name "github-actions[bot]"
git -C "${OUT}/out" config user.email "41898282+github-actions[bot]@users.noreply.github.com"
git -C "${OUT}/out" add -A
git -C "${OUT}/out" commit -qm "release: ${TAG}${SRC_SHA:+ (${SRC_SHA:0:7})}"
LOCAL_SHA=$(git -C "${OUT}/out" rev-parse HEAD)
ls -l "${OUT}/out" | sed -n '2,20p'

# ---- 5. 推送（带超时/重试/进度），失败按原因给结论 ----
echo "== 推送到 GitCode ${TARGET_REPO}@${TARGET_BRANCH}（${LOCAL_SHA:0:7}）"
if ! push_mirror_force "${OUT}/out" "${MIRROR_PUSH_URL}" "${TARGET_BRANCH}" "推送 GitCode 产物仓库"; then
  if printf '%s' "${PUSH_LOG}" | grep -qiE 'image repository|CH\.00905403'; then
    echo "::warning::GitCode 的 ${TARGET_REPO} 是镜像仓（只读），平台拒绝了推送。请到 GitCode「项目设置 → 仓库镜像」关闭 Pull 镜像后再试。"
    exit 0
  elif printf '%s' "${PUSH_LOG}" | grep -qiE 'authentication|403|401|denied|permission'; then
    echo "::error::GitCode 认证/权限失败：确认 Secret GITCODE_TOKEN 未过期，且账号对 ${TARGET_REPO} 有写权限。"
  elif printf '%s' "${PUSH_LOG}" | grep -qiE 'low speed limit|timed out|timeout'; then
    echo "::error::推送超时或速率过低（链路当时传不动）。本脚本幂等，链路恢复后原样重跑即可。"
  elif printf '%s' "${PUSH_LOG}" | grep -qi 'shallow'; then
    echo "::error::本地是浅克隆，缺对象推不上去——孤儿提交那一步被改坏了。"
  else
    echo "::error::GitCode 产物仓库推送失败（已尝试 ${MIRROR_PUSH_ATTEMPTS} 次）"
  fi
  exit 1
fi

if [ "${VERIFY_MIRROR}" != "1" ]; then
  echo "== 已推送（未回读校验）"
  exit 0
fi

# ---- 6. 回读：refs 必须精确等于刚推的 commit，再核对每个包的字节数 ----
GOT_SHA=$(remote_sha || true)
if [ "${GOT_SHA}" != "${LOCAL_SHA}" ]; then
  echo "::error::回读不一致：gitcode ${TARGET_BRANCH} = ${GOT_SHA:-（空）}，期望 ${LOCAL_SHA}"
  exit 1
fi
echo "== refs 已对齐：${GOT_SHA:0:7}"

# 文件接口有缓存，轮询到新 tag 出现为止（最多 ~2 分钟）；推成功但读得慢只告警。
GOT_TAG=''
for _ in $(seq 1 "${VERIFY_POLL_ATTEMPTS}"); do
  GOT_TAG=$(tag_of "$(remote_manifest)")
  [ "${GOT_TAG}" = "${TAG}" ] && break
  sleep "${VERIFY_POLL_SECONDS}"
done
if [ "${GOT_TAG}" != "${TAG}" ]; then
  echo "::warning::文件接口读到的 latest.json 仍是 ${GOT_TAG:-读不到}（期望 ${TAG}），git 侧已推送成功，稍后复查：${MIRROR_RAW_BASE}/latest.json?ref=${TARGET_BRANCH}"
  exit 0
fi

ok=0
bad=0
for f in ${FILES}; do
  want=$(stat -c%s "${OUT}/out/${f}")
  got=$(remote_size "${f}")
  if [ "${got}" = "${want}" ]; then
    echo "   ${f}  ${got} 字节 ✅"
    ok=$((ok + 1))
  else
    echo "   ${f}  远端 ${got:-?} / 期望 ${want} ❌"
    bad=$((bad + 1))
  fi
done
if [ "${bad}" -gt 0 ]; then
  echo "::warning::有 ${bad} 个包字节数对不上，可能还没同步完；稍后用同一命令再跑一次即可"
  exit 0
fi
echo "== 已同步：gitcode.com/${TARGET_REPO} ${TARGET_BRANCH}=${LOCAL_SHA:0:7} tag=${TAG}（${ok} 个文件字节数一致）"
