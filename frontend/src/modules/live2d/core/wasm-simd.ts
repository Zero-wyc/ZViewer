// wasm SIMD 能力探测。
//
// 单独一个文件而不是塞进 face-tracker：face-tracker 依赖 i18n 与 MediaPipe
// 的类型，测试进程里加载不了；而这段字节序**恰恰是最需要单测锁住的东西**
// ——它一旦写错，表现是「所有浏览器都说不支持动捕」，而错误现场在 UI 上
// 完全看不出来（见下方历史问题）。

/**
 * 手工拼一个最小模块：
 * `(func (result v128) (i8x16.abs (i8x16.splat (i32.const 0))))`
 *
 * 只有真正实现 SIMD 的引擎才 validate 通过；不支持的老引擎会拒绝 0xFD
 * 前缀的指令。
 *
 * 逐段核对：
 *   00 61 73 6D 01 00 00 00   magic + version
 *   01 05 01 60 00 01 7B      type: 1 个函数 () -> v128
 *   03 02 01 00               function: 1 个，用 0 号类型
 *   0A 0A 01 08               code: 段长 10，1 个函数体，体长 8
 *   00                        无局部变量
 *   41 00                     i32.const 0
 *   FD 0F                     i8x16.splat
 *   FD 60                     i8x16.abs
 *   0B                        end
 *
 * **历史问题**：早先这里是 `01 04 01 60 00 00`（无返回值）+ 体长 7 却写了
 * 8 个字节，模块本身不合法，`WebAssembly.validate` 恒为 false。用户点开动捕
 * 得到的一律是「浏览器不支持摄像头动捕」，而 Chrome 明明支持。
 */
const SIMD_PROBE = new Uint8Array([
  0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 10, 1, 8,
  0, 65, 0, 253, 15, 253, 96, 11,
])

export function supportsWasmSimd(): boolean {
  if (typeof WebAssembly === 'undefined' || !WebAssembly.validate) return false
  return WebAssembly.validate(SIMD_PROBE)
}
