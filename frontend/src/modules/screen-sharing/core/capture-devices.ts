/**
 * 摄像头采集的约束与设备枚举。
 *
 * 移植自 Piik `src/client/media/capture-devices.ts`（MIT）。与屏幕采集有三处
 * 关键差异，全部来自「摄像头是物理设备，屏幕是一个可缩放的合成面」：
 *
 *  1. 宽高用 `ideal` 而不是 `max`：屏幕采集要的是「不超过」，摄像头的
 *     驱动只会给几个固定格式，下 `max` 很容易匹配不到而回落到最差的档；
 *  2. `resizeMode: exact 'none'`：让浏览器不要为了凑尺寸去裁剪/拉伸传感器
 *     画面，缩放交给发送端的 `scaleResolutionDownBy`；
 *  3. 没有 `displaySurface`，所以发送端不做帧隔离（`sender-track.ts` 的分支），
 *     摄像头驱动不会像屏幕合成器那样被编码器回灌约束。
 *
 * 本文件不允许运行时 import：测试用 node --experimental-strip-types 直接加载。
 */

/** 一台可选采集设备。`label` 在未授权时为空串，UI 要自己兜底。 */
export interface CaptureDevice {
  id: string
  label: string
}

/** 摄像头独有的约束字段（尚未进 TS 标准库）。 */
type CameraConstraints = MediaTrackConstraints & {
  resizeMode?: ConstrainDOMString
}

/** 摄像头采集尺寸档位：`null` 表示不约束，交给驱动自己决定。 */
export interface CameraSize {
  width: number
  height: number
}

/**
 * 只约束「画面格式」的那部分（尺寸 / 帧率 / 不裁剪），不含设备选择。
 *
 * 换档位时要用它重新下发 `applyConstraints`：那里**绝不能**带上
 * `deviceId` / `facingMode`，否则移动端会因为 facingMode 悄悄切到另一颗
 * 摄像头，或者因为 deviceId 不变而判成「没变化」。
 */
export function cameraTrackConstraints(
  size: CameraSize | null,
  maxFramerate: number
): CameraConstraints {
  return {
    resizeMode: { exact: 'none' },
    ...(size
      ? { width: { ideal: size.width }, height: { ideal: size.height } }
      : {}),
    frameRate: { ideal: maxFramerate, max: maxFramerate },
  }
}

/**
 * 摄像头采集约束。
 *
 * `deviceId` 为空时按 `facingMode: environment` 取后置——桌面端没有这个
 * 概念（会被忽略），移动端默认用后置更接近「给别人看」的用途。Piik 的选择。
 */
export function cameraCaptureConstraints(
  size: CameraSize | null,
  maxFramerate: number,
  deviceId = ''
): CameraConstraints {
  return {
    ...(deviceId
      ? { deviceId: { exact: deviceId } }
      : { facingMode: { ideal: 'environment' } }),
    ...cameraTrackConstraints(size, maxFramerate),
  }
}

/**
 * 去掉 `resizeMode` 的降级约束。
 *
 * Chrome 之外（Safari/Firefox）对 `exact: 'none'` 可能直接 Overconstrained，
 * 那种情况下宁可让浏览器自己裁，也不能整个采集失败。
 */
export function cameraFallbackConstraints(
  constraints: CameraConstraints
): MediaTrackConstraints {
  const { resizeMode: _resizeMode, ...rest } = constraints
  void _resizeMode
  return rest
}

/**
 * 枚举摄像头。
 *
 * `enumerateDevices` 不需要权限、也不会打开设备；但**未授权时 `label` 是空串**
 * ——界面得用「摄像头 1/2」之类的占位，别显示成一片空白。
 */
export async function browserCameras(): Promise<CaptureDevice[]> {
  if (!navigator.mediaDevices?.enumerateDevices) return []
  const devices = await navigator.mediaDevices.enumerateDevices()
  return devices
    .filter(
      (device) =>
        device.kind === 'videoinput' &&
        device.deviceId &&
        device.deviceId !== 'default' &&
        device.deviceId !== 'communications'
    )
    .map((device) => ({ id: device.deviceId, label: device.label }))
}
