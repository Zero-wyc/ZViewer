#!/usr/bin/env bash
# Git Bash 下的"启动-探活-回收"小工具，被 bilibili-parity.sh / bilibili-smoke.sh 共用。
#
# 两个坑都踩过，且都会让测试**悄悄测错东西**：
#
#   1. `cmd &` 之后 $! 是**包装用的 bash 子进程**，不是 exe 本身。
#      taskkill $! 只会杀掉包装壳，node.exe / zviewerd.exe 继续活着占住端口。
#   2. 本机 netstat 看不到这些监听套接字（TIME_WAIT 能看到，LISTENING 看不到），
#      既没法预检端口占用，也没法按端口反查 PID。
#
# 于是残留进程会安静地占着老端口：新进程 bind 失败退出，而健康检查仍被**旧进程**
# 应答 —— 对拍拿到的是上一版构建的输出，差异看起来像代码缺陷，极难定位。
# 曾经为此怀疑到 resolver 的每一个字段。
#
# 现在的策略：端口每轮随机（旧进程不可能冒充），进程按 ppid 树收集后按 WINPID 强杀。

# 随机端口：20000~39999。避开常见开发端口，也避开上一轮可能的残留。
pick_port() {
  echo $(( 20000 + RANDOM % 20000 ))
}

# descendants <msys_pid>：直接子进程的 msys pid。
descendants() {
  ps -W 2>/dev/null | awk -v p="$1" 'NR>1 && $2==p {print $1}'
}

# tree_pids <msys_pid>：全部子孙的 msys pid（不含自身）。
tree_pids() {
  local frontier="$1" all="" next c p
  while [ -n "$frontier" ]; do
    next=""
    for p in $frontier; do
      for c in $(descendants "$p"); do next="$next $c"; done
    done
    all="$all $next"
    frontier="$next"
  done
  echo $all
}

# winpid_of <msys_pid>：ps 表第 4 列即 Windows PID。
winpid_of() {
  ps -W 2>/dev/null | awk -v p="$1" 'NR>1 && $1==p {print $4; exit}'
}

# kill_tree <msys_pid>：先杀子孙再杀自身，全部按 WINPID。
kill_tree() {
  local root=$1 p w
  for p in $(tree_pids "$root") $root; do
    w=$(winpid_of "$p")
    if [ -n "$w" ] && [ "$w" != "0" ]; then
      taskkill //F //T //PID "$w" >/dev/null 2>&1
    fi
  done
}

# wait_ready <port> <name> <logfile> <anchor>
#
# 判定顺序刻意是"先日志、后健康检查"：日志文件是本轮新建的，只有我们自己的进程会
# 往里写；健康检查却可能被占着端口的老进程应答。先看锚点行能排除冒名者。
wait_ready() {
  local port=$1 name=$2 log=$3 anchor=$4 i
  for i in $(seq 1 80); do
    if grep -q "$anchor" "$log" 2>/dev/null; then
      if curl -s -o /dev/null -m 1 "http://127.0.0.1:$port/health"; then
        return 0
      fi
    fi
    sleep 0.25
  done
  echo "!! $name 启动失败（端口 $port）。日志尾部："
  tail -8 "$log" 2>/dev/null
  return 1
}
