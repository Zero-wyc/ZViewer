#!/usr/bin/env bash
#
# 跨境 git push 的统一封装：有进度、会超时、会重试、输出脱敏。
#
# 为什么需要它：往 GitCode 推产物是一次几十到上百 MB 的单次上传，
# 而且 zip 已经压缩过、git 做不了 delta，每次都是全量。跨境链路一旦抖动，
# 旧写法（`out=$(git push ...)` 收进变量）会同时失去三样东西：
#   1. 进度——日志里只有最后一行，看不出卡在上传还是卡在等对端；
#   2. 上限——git 默认 http.lowSpeedLimit=0，停滞时永不超时，能挂到 job 上限
#      （实测 v5.2.1 卡了 26 分半）；
#   3. 重试——一次抖动就得人工重跑整个发版。
#
# 由 publish-release-repo.sh 与 mirror-release-repo.sh 共同 source，不单独执行。
#
# 可调环境变量：
#   MIRROR_PUSH_TIMEOUT      单次 push 的硬超时秒数，默认 600
#   MIRROR_PUSH_ATTEMPTS     最多尝试次数，默认 2
#   MIRROR_PUSH_LOW_SPEED_LIMIT  低于该速率（字节/秒）视为卡住，默认 1024
#   MIRROR_PUSH_LOW_SPEED_TIME   上述低速持续多少秒后断开，默认 60

MIRROR_PUSH_TIMEOUT="${MIRROR_PUSH_TIMEOUT:-600}"
MIRROR_PUSH_ATTEMPTS="${MIRROR_PUSH_ATTEMPTS:-2}"
MIRROR_PUSH_LOW_SPEED_LIMIT="${MIRROR_PUSH_LOW_SPEED_LIMIT:-1024}"
MIRROR_PUSH_LOW_SPEED_TIME="${MIRROR_PUSH_LOW_SPEED_TIME:-60}"

# 上一次 push 的完整输出（已脱敏），失败原因从这里判断。
PUSH_LOG=''

# git 的报错里会带完整 URL（含 token），任何输出都必须先过这一层。
# -u 关掉行缓冲，否则进度行要等缓冲区满才出现，等于没有进度。
mask_url() { sed -u -E 's#https://[^@[:space:]]*@#https://***@#g'; }

# push_mirror_force <仓库目录> <推送地址> <分支> <给人看的名称>
# 成功返回 0；所有尝试都失败返回 1，详细输出留在 PUSH_LOG。
push_mirror_force() {
  local dir="$1" url="$2" branch="$3" label="$4"
  local attempt log rc

  for ((attempt = 1; attempt <= MIRROR_PUSH_ATTEMPTS; attempt++)); do
    log="$(mktemp)"
    echo "== ${label}：第 ${attempt}/${MIRROR_PUSH_ATTEMPTS} 次推送" \
      "（硬超时 ${MIRROR_PUSH_TIMEOUT}s，低于 ${MIRROR_PUSH_LOW_SPEED_LIMIT}B/s 持续 ${MIRROR_PUSH_LOW_SPEED_TIME}s 即断开）"

    # 关掉 -e：这里要自己看退出码，而不是让脚本直接退出。
    # GIT_TERMINAL_PROMPT=0：两个推送地址都已经内嵌 token，任何交互式提问都只会在
    # CI 里静默挂死，不如直接失败。
    set +e
    GIT_TERMINAL_PROMPT=0 timeout "${MIRROR_PUSH_TIMEOUT}" git -C "${dir}" \
      -c "http.lowSpeedLimit=${MIRROR_PUSH_LOW_SPEED_LIMIT}" \
      -c "http.lowSpeedTime=${MIRROR_PUSH_LOW_SPEED_TIME}" \
      -c http.postBuffer=524288000 \
      push --progress --force "${url}" "HEAD:refs/heads/${branch}" 2>&1 \
      | mask_url | tee "${log}"
    rc=${PIPESTATUS[0]}
    set -e

    PUSH_LOG="$(cat "${log}")"
    rm -f "${log}"

    if [ "${rc}" -eq 0 ]; then
      return 0
    fi

    # 区分「被超时/低速掐断」与「对端拒绝」，前者值得重试，后者重试也没用。
    if [ "${rc}" -eq 124 ] || printf '%s' "${PUSH_LOG}" | grep -qiE 'low speed limit|timed out|timeout'; then
      echo "::warning::${label} 第 ${attempt} 次推送超时或速率过低（退出码 ${rc}），这条链路当时传不动"
    else
      echo "::warning::${label} 第 ${attempt} 次推送失败（退出码 ${rc}）"
    fi

    if [ "${attempt}" -lt "${MIRROR_PUSH_ATTEMPTS}" ]; then
      echo "== 退避 $((attempt * 15))s 后重试"
      sleep $((attempt * 15))
    fi
  done
  return 1
}
