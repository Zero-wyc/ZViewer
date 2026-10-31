/**
 * 可中止的连接操作。
 *
 * 关闭一个 PeerConnection 会让它「异步操作链」上的 promise 永远悬着：
 * `createOffer` / `setLocalDescription` / `addIceCandidate` / `replaceTrack`
 * 都不会 settle（https://www.w3.org/TR/webrtc/#dfn-chain-an-asynchronous-operation）。
 *
 * 后果很具体：观众断开后房主的协商队列会永久卡在 `await createOffer()`，
 * 之后这个观众再回来也发不出新 offer，表现为「一直转圈但日志里什么都没报」。
 *
 * 解法不是给 promise 加超时，而是让「关闭」主动 reject 掉正在等待的那一步。
 * 调用方必须在每一条 await 的协商步骤上套这个函数，且关闭时先 abort 再 close。
 *
 * 21 行，原样取自 Piik（MIT）`src/client/webrtc/connection-operation.ts`。
 * 不要「优化」成 Promise.race + 超时：超时会把正常但慢的连接判死。
 */
export async function waitForConnectionOperation<T>(
  signal: AbortSignal,
  operation: () => Promise<T>
): Promise<T> {
  signal.throwIfAborted()
  let abort!: () => void
  const stopped = new Promise<never>((_, reject) => {
    abort = () => reject(signal.reason)
    signal.addEventListener('abort', abort, { once: true })
  })
  try {
    const result = await Promise.race([operation(), stopped])
    signal.throwIfAborted()
    return result
  } finally {
    signal.removeEventListener('abort', abort)
  }
}
