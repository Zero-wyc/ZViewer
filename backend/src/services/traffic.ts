/**
 * 服务端网络流量统计（OS 级网卡计数器，尽力而为）
 *
 * - Linux：读取 /proc/net/dev（所有非 lo 接口的累计 rx/tx 字节）
 * - Windows：解析 `netstat -e` 的累计收发字节数（中英文输出均可）
 * - macOS：解析 `netstat -ib`
 * - 其他平台 / 读取失败：返回 null，前端隐藏服务端流量区块
 *
 * 累计值是操作系统启动以来的网卡总流量；速度由两次采样的差值计算。
 */
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface NetworkStats {
  /** 累计下载字节数（网卡接收） */
  rxBytes: number;
  /** 累计上传字节数（网卡发送） */
  txBytes: number;
  /** 下载速度（B/s，两次采样差值） */
  rxSpeed: number;
  /** 上传速度（B/s） */
  txSpeed: number;
}

interface NicSample {
  rx: number;
  tx: number;
}

let lastSample: (NicSample & { at: number }) | null = null;
let lastSpeed = { rxSpeed: 0, txSpeed: 0 };

export async function getNetworkStats(): Promise<NetworkStats | null> {
  const now = Date.now();
  const sample = await readNicBytes();
  if (!sample) return null;

  let rxSpeed = 0;
  let txSpeed = 0;
  if (
    lastSample &&
    sample.rx >= lastSample.rx &&
    sample.tx >= lastSample.tx
  ) {
    const dt = (now - lastSample.at) / 1000;
    if (dt > 0.2) {
      rxSpeed = Math.max(0, (sample.rx - lastSample.rx) / dt);
      txSpeed = Math.max(0, (sample.tx - lastSample.tx) / dt);
      lastSpeed = { rxSpeed, txSpeed };
    } else {
      // 采样间隔过短，沿用上次速度
      rxSpeed = lastSpeed.rxSpeed;
      txSpeed = lastSpeed.txSpeed;
    }
  } else {
    // 计数器回绕/重置（如网卡重启），速度置零
    lastSpeed = { rxSpeed: 0, txSpeed: 0 };
  }
  lastSample = { rx: sample.rx, tx: sample.tx, at: now };

  return { rxBytes: sample.rx, txBytes: sample.tx, rxSpeed, txSpeed };
}

async function readNicBytes(): Promise<NicSample | null> {
  const platform = os.platform();
  try {
    if (platform === 'linux') return readLinuxProc();
    if (platform === 'win32') return await readWindowsNetstat();
    if (platform === 'darwin') return await readDarwinNetstat();
  } catch (err) {
    console.error('[traffic] 读取网卡流量失败:', err);
  }
  return null;
}

/** Linux：/proc/net/dev，跳过 lo 回环接口 */
function readLinuxProc(): NicSample | null {
  const raw = fs.readFileSync('/proc/net/dev', 'utf8');
  let rx = 0;
  let tx = 0;
  let matched = false;
  for (const line of raw.split('\n').slice(2)) {
    const [iface, data] = line.split(':');
    if (!data) continue;
    const name = iface.trim();
    if (!name || name === 'lo') continue;
    const cols = data.trim().split(/\s+/);
    const rxB = Number(cols[0]);
    const txB = Number(cols[8]);
    if (Number.isFinite(rxB) && Number.isFinite(txB)) {
      rx += rxB;
      tx += txB;
      matched = true;
    }
  }
  return matched ? { rx, tx } : null;
}

/** Windows：`netstat -e` 的「字节 / Bytes」行（累计值） */
async function readWindowsNetstat(): Promise<NicSample | null> {
  const { stdout } = await execFileAsync('netstat', ['-e'], {
    timeout: 4000,
    windowsHide: true,
  });
  // 输出结构固定：接口统计标题 → 空行 → 已接收/已发送表头 → 空行 → 字节数行
  // 中英文系统表头文字不同，因此直接找第一条「两个纯数字」的行
  for (const line of stdout.split('\n')) {
    const m = line.trim().match(/^([\d.,\s]+)\s+([\d.,\s]+)$/);
    if (!m) continue;
    const rx = Number(m[1].replace(/[.,\s]/g, ''));
    const tx = Number(m[2].replace(/[.,\s]/g, ''));
    if (Number.isFinite(rx) && Number.isFinite(tx) && rx + tx > 0) {
      return { rx, tx };
    }
  }
  return null;
}

/** macOS：`netstat -ib`，跳过 lo* 回环接口（Ibytes 第 7 列 / Obytes 第 10 列，0 起始） */
async function readDarwinNetstat(): Promise<NicSample | null> {
  const { stdout } = await execFileAsync('netstat', ['-ib'], {
    timeout: 4000,
    windowsHide: true,
  });
  let rx = 0;
  let tx = 0;
  let matched = false;
  for (const line of stdout.split('\n').slice(1)) {
    const cols = line.trim().split(/\s+/);
    if (cols.length < 10) continue;
    const name = cols[0];
    if (!name || name.startsWith('lo')) continue;
    const rxB = Number(cols[6]);
    const txB = Number(cols[9]);
    if (Number.isFinite(rxB) && Number.isFinite(txB)) {
      rx += rxB;
      tx += txB;
      matched = true;
    }
  }
  return matched ? { rx, tx } : null;
}
