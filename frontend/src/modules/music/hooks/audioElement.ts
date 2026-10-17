/**
 * 一起听音频元素工具（MediaSession 可靠性与后台播放健壮性）。
 *
 * 从 useListenTogether 原样迁出（纯 DOM/HTMLAudioElement 操作，无 React 依赖）。
 */

/**
 * 把音频元素挂到 body 尾部（display:none）：MediaSession 系统媒体通知
 * （Android 状态栏/锁屏、iOS 控制中心）依赖浏览器对「页面内有媒体元素
 * 在播」的感知——部分安卓浏览器/WebView 对**脱离 DOM** 的媒体元素不建立
 * 媒体会话，通知不出现。挂 DOM 是 MediaSession 可靠生效的前提，
 * 幂等（已在 DOM 中时 appendChild 仅移动，无副作用）。
 */
export function mountMediaElement(el: HTMLAudioElement): void {
  if (el.parentElement) return
  el.setAttribute('aria-hidden', 'true')
  el.setAttribute('data-lt-media', '')
  el.style.display = 'none'
  document.body.appendChild(el)
}

/** 把音频元素从 DOM 移除（与 mountMediaElement 配对；防替换/卸载后残留） */
export function unmountMediaElement(el: HTMLAudioElement): void {
  el.remove()
}

/**
 * 带有界退避重试的播放启动（后台切歌健壮性的核心）。
 *
 * 手机端页面处于后台时，部分浏览器/WebView 对 play() 的首次调用返回
 * NotAllowedError（hidden 态自动播放策略收紧）——静默吞掉会让「通知栏
 * 切歌 / 歌曲结束自动连播 / 观众跟随房主播放」彻底停摆：音频不再播放、
 * 系统媒体通知随之消失，用户感知即「后台无法切下一首」。改为退避重试
 * （1s/2s/3s 共 4 次尝试）：后台定时器被节流时重试只会推迟不会丢失
 * （渲染进程解冻/回前台后立即补跑），给受限环境自愈机会。
 *
 * 安全护栏：重试前校验元素仍在 DOM 且 src 未变——预载升格/退役路径会
 * 接替或移除元素（isConnected=false / src 变化），此时放弃重试，防止
 * 僵尸元素出声。
 */
export function playAudioWithRetry(
  el: HTMLAudioElement,
  onGiveUp?: () => void
): void {
  const startSrc = el.src
  const attempt = (attemptsLeft: number): void => {
    void el.play().catch(() => {
      // 已在播放（前一次调用实际生效）或流加载失败（error 置位，重试无意义）
      if (!el.paused || el.error) return
      if (attemptsLeft <= 0) {
        onGiveUp?.()
        return
      }
      // 元素已被接替/退役（升格换主元素、resetAudioElement 清 src）
      if (!el.isConnected || el.src !== startSrc) return
      window.setTimeout(
        () => attempt(attemptsLeft - 1),
        1000 * (4 - attemptsLeft)
      )
    })
  }
  attempt(3)
}
