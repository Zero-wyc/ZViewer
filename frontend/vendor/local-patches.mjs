/**
 * mediabunny vendored 副本的本地补丁（程序化，可自动重放）。
 *
 * fetch-mediabunny.mjs 抓取的是 pristine 上游源码（固定 commit SHA），
 * 抓取完成后自动调用本文件的 applyLocalPatches() 重放全部本地补丁，
 * 因此「重新抓取」是一条完全可复现的命令：
 *
 *   node fetch-mediabunny.mjs   （抓取 + 自动打补丁）
 *   node local-patches.mjs      （单独重打补丁）
 *   node local-patches.mjs --check （只校验补丁是否在位，不改文件）
 *
 * 匹配逻辑行尾无关：读入时统一 \r\n → \n，替换后写回 LF
 * （git 侧 autocrlf 负责 index 归一化，无需关心工作区行尾）。
 *
 * 每个补丁 = { file, find, replace }：find 必须在目标文件中恰好出现一次
 * （已应用的文件包含 replace，直接跳过，幂等）。find/replace 都不存在
 * 视为上游漂移，报错退出 —— 这是刻意的：fetch 固定了 SHA，出现这种情况
 * 说明有人改了 REF，必须人工重估补丁。
 */
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve as presolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = presolve(SCRIPT_DIR, 'mediabunny', 'dist', 'modules', 'src');

export const LOCAL_PATCHES = [
  {
    file: 'codec.js',
    title: 'DTS: 注册为已知音频编码',
    find: "    'ac3',\n    'eac3',\n];",
    replace:
      "    'ac3',\n    'eac3',\n    'dts', // [本地补丁] 见 matroska/ebml.js / matroska/matroska-demuxer.js 中的 DTS 补丁说明\n];",
  },
  {
    file: 'codec.js',
    title: "DTS: getMseCodec 映射为 'dtsc'",
    find:
      "    else if (codec === 'eac3') {\n        return 'ec-3';\n    }\n    else if (PCM_AUDIO_CODECS.includes(codec)) {",
    replace:
      "    else if (codec === 'eac3') {\n        return 'ec-3';\n    }\n    // [本地补丁] DTS：MSE/WebCodecs 的 DTS codec string 为 'dtsc'，\n    // 与 playsvideo 的 AUDIO_CODEC_MAP.dts 保持一致。\n    else if (codec === 'dts') {\n        return 'dtsc';\n    }\n    else if (PCM_AUDIO_CODECS.includes(codec)) {",
  },
  {
    file: 'codec.js',
    title: "DTS: getCodecString 映射为 'dtsc'",
    find:
      "    else if (codec === 'eac3') {\n        return 'ec-3';\n    }\n    else if (codec && PCM_AUDIO_CODECS.includes(codec)) {",
    replace:
      "    else if (codec === 'eac3') {\n        return 'ec-3';\n    }\n    // [本地补丁] DTS：codec string 为 'dtsc'\n    else if (codec === 'dts') {\n        return 'dtsc';\n    }\n    else if (codec && PCM_AUDIO_CODECS.includes(codec)) {",
  },
  {
    file: 'matroska/ebml.js',
    title: 'DTS: Matroska CodecID 映射 A_DTS',
    find: "    'ac3': 'A_AC3',\n    'eac3': 'A_EAC3',\n    'pcm-u8': 'A_PCM/INT/LIT',",
    replace:
      "    'ac3': 'A_AC3',\n    'eac3': 'A_EAC3',\n    // [本地补丁] 增加 DTS 支持：mediabunny 上游（含 kzahel@integration）不识别 A_DTS，\n    // 导致含 DTS 音轨的 MKV 被解封装成\"只有视频\"，playsvideo 也就拿不到音频去转码。\n    'dts': 'A_DTS',\n    'pcm-u8': 'A_PCM/INT/LIT',",
  },
  {
    file: 'matroska/matroska-demuxer.js',
    title: 'DTS: A_DTS 音轨透传解码',
    find:
      "                                this.currentTrack.info.codec = 'eac3';\n                                this.currentTrack.info.codecDescription = this.currentTrack.codecPrivate;\n                            }\n                            else if (this.currentTrack.codecId === 'A_PCM/INT/LIT') {",
    replace:
      "                                this.currentTrack.info.codec = 'eac3';\n                                this.currentTrack.info.codecDescription = this.currentTrack.codecPrivate;\n                            }\n                            // [本地补丁] DTS：Matroska 里 DTS 音轨的 CodecID 为 A_DTS，\n                            // 各 SimpleBlock 即一个完整的 DTS 帧，无需额外解析，直接透传即可。\n                            // mediabunny 只需\"取出原始 DTS 包\"，解码/转码由 playsvideo 交给 ffmpeg.wasm。\n                            else if (codecIdWithoutSuffix === CODEC_STRING_MAP.dts) {\n                                this.currentTrack.info.codec = 'dts';\n                                if (this.currentTrack.codecPrivate) {\n                                    this.currentTrack.info.codecDescription = this.currentTrack.codecPrivate;\n                                }\n                            }\n                            else if (this.currentTrack.codecId === 'A_PCM/INT/LIT') {",
  },
  {
    file: 'isobmff/isobmff-boxes.js',
    title: 'FLAC: MP4 AudioSampleEntry 读真实位深（修复 24-bit FLAC 被 Chromium 拒绝）',
    find:
      "    let contents;\n    let sampleSizeInBits = 16;\n    const isPcmCodec = PCM_AUDIO_CODECS.includes(trackData.track.source._codec);",
    replace:
      "    let contents;\n    let sampleSizeInBits = 16;\n    const isPcmCodec = PCM_AUDIO_CODECS.includes(trackData.track.source._codec);\n    if (trackData.track.source._codec === 'flac' &&\n        trackData.info.decoderConfig.description) {\n        // FLAC's STREAMINFO stores the actual sample depth in a 5-bit field.\n        // Keeping the old 16-bit fallback makes Chromium reject 24-bit FLAC\n        // when the generated FLACSpecificBox declares 24 bits.\n        const descriptionBitstream = new Bitstream(toUint8Array(trackData.info.decoderConfig.description));\n        descriptionBitstream.skipBits(103 + 64);\n        sampleSizeInBits = descriptionBitstream.readBits(5) + 1;\n    }",
  },
];

function normalize(content) {
  return content.replace(/\r\n/g, '\n');
}

function countOccurrences(haystack, needle) {
  return haystack.split(needle).length - 1;
}

/** 对单个补丁求状态：'applied'（replace 在位）| 'pristine'（find 在位）| 'drifted' */
function patchState(content, patch) {
  if (countOccurrences(content, patch.replace) === 1) return 'applied';
  if (countOccurrences(content, patch.find) === 1) return 'pristine';
  return 'drifted';
}

/**
 * 重放全部本地补丁。返回应用/跳过的补丁数。
 * @param {{ write?: boolean }} opts  write=false 时只校验不改文件（--check）
 */
export async function applyLocalPatches({ write = true } = {}) {
  let applied = 0;
  let skipped = 0;
  const errors = [];

  // 按 file 分组缓存，减少重复读写
  const cache = new Map();
  const readOnce = async (rel) => {
    if (!cache.has(rel)) {
      cache.set(rel, {
        content: normalize(await readFile(presolve(ROOT, rel), 'utf8')),
        dirty: false,
      });
    }
    return cache.get(rel);
  };

  for (const patch of LOCAL_PATCHES) {
    const entry = await readOnce(patch.file);
    const state = patchState(entry.content, patch);
    if (state === 'applied') {
      skipped++;
      continue;
    }
    if (state === 'pristine') {
      if (write) {
        entry.content = entry.content.replace(patch.find, patch.replace);
        entry.dirty = true;
        applied++;
        console.log(`applied: [${patch.file}] ${patch.title}`);
      } else {
        errors.push(`missing: [${patch.file}] ${patch.title}（补丁未在位）`);
      }
      continue;
    }
    errors.push(
      `drifted: [${patch.file}] ${patch.title} —— find/replace 均未唯一匹配，` +
        '上游内容已变化（或文件被手工改动），请人工重估此补丁'
    );
  }

  if (write) {
    for (const [rel, entry] of cache) {
      if (entry.dirty) await writeFile(presolve(ROOT, rel), entry.content, 'utf8');
    }
  }

  if (errors.length) {
    throw new Error(
      `本地补丁校验失败（${errors.length}/${LOCAL_PATCHES.length} 项异常）:\n` +
        errors.map((e) => `  - ${e}`).join('\n')
    );
  }
  return { applied, skipped, total: LOCAL_PATCHES.length };
}

// CLI 入口
if (process.argv[1] && import.meta.url === new URL(`file:///${process.argv[1].replace(/\\/g, '/')}`).href) {
  const check = process.argv.includes('--check');
  try {
    const { applied, skipped, total } = await applyLocalPatches({ write: !check });
    console.log(
      check
        ? `check OK: ${total}/${total} 补丁在位`
        : `done: applied=${applied} skipped(已在位)=${skipped} / ${total}`
    );
  } catch (e) {
    console.error(e.message);
    process.exitCode = 1;
  }
}
