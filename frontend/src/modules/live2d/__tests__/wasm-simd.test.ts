import assert from 'node:assert/strict'
import { test } from 'node:test'
import { supportsWasmSimd } from '../core/wasm-simd.ts'

// 这条用例的价值不在「当前机器支持 SIMD」，而在于**探测模块本身是合法的**。
//
// 之前那段字节序少了一个结果类型、函数体长度也多写了一个字节，模块根本
// validate 不过，于是任何浏览器都被判成「不支持摄像头动捕」——真机上表现为
// 开关点一下就弹错误，而代码里看不出任何问题。

test('SIMD 探测模块本身必须合法', () => {
  // Node 18+ 的 V8 一定支持 wasm SIMD（MediaPipe 的运行前提之一）。
  // 这里若为 false，说明探测用的字节序列写错了，而不是环境不行。
  assert.equal(supportsWasmSimd(), true)
})

test('不支持 wasm 的环境下安全返回 false', () => {
  const original = globalThis.WebAssembly
  // 模拟老浏览器：没有 WebAssembly
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  delete (globalThis as any).WebAssembly
  try {
    assert.equal(supportsWasmSimd(), false)
  } finally {
    globalThis.WebAssembly = original
  }
})
