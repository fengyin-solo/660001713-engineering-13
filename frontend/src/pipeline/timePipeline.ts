import type { Star } from '../types'
import { localSiderealTime, projectNormalized } from './astronomy'
import type {
  FrameDeltaDiff,
  FrameLookupResult,
  FrameReplayResult,
  PipelineBundle,
  PipelineConfig,
  SkyFrame,
  StarDelta,
} from './types'

export const PIPELINE_VERSION = 1

/** 时间落在步长网格上的判定容差（1 毫秒），避免浮点误差导致误判 */
const GRID_EPS_MS = 1

/** 对星表做一个简单稳定的指纹（FNV-1a 32 位），星表内容变化即失效 */
export function catalogSignature(stars: Star[]): string {
  const canonical = JSON.stringify(
    stars.map(s => [s.name, s.ra, s.dec, s.mag, s.spectral]),
  )
  let hash = 0x811c9dc5
  for (let i = 0; i < canonical.length; i++) {
    hash ^= canonical.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}

/** 配置合法性检查，返回错误原因；合法返回 null */
export function validateConfig(config: PipelineConfig): string | null {
  if (!(config.endMs > config.startMs)) {
    return `时间范围无效: start=${new Date(config.startMs).toISOString()} end=${new Date(config.endMs).toISOString()}`
  }
  if (!(config.stepMs > 0)) {
    return `步长无效: stepMs=${config.stepMs}`
  }
  if (config.latitude < -90 || config.latitude > 90) {
    return `纬度超出范围: ${config.latitude}`
  }
  return null
}

/** 理论帧数（含首尾） */
export function expectedFrameCount(config: PipelineConfig): number {
  return Math.round((config.endMs - config.startMs) / config.stepMs) + 1
}

/** 由时间范围/步长/纬度/星表生成管线配置 */
export function makeConfig(
  startMs: number,
  endMs: number,
  stepMs: number,
  latitude: number,
  zoom: number,
  stars: Star[],
): PipelineConfig {
  return {
    startMs,
    endMs,
    stepMs,
    latitude,
    zoom,
    catalogSignature: catalogSignature(stars),
    starCount: stars.length,
  }
}

/**
 * 存储键：同一时间范围/步长/纬度/星表复用同一管线；
 * 纬度变化或星表更新会得到不同的键，旧帧不会被错误复用。
 */
export function pipelineKey(config: PipelineConfig): string {
  return [
    'sky-pipeline',
    `v${PIPELINE_VERSION}`,
    `${config.startMs}`,
    `${config.endMs}`,
    `${config.stepMs}`,
    `lat${config.latitude}`,
    `cat${config.catalogSignature}`,
  ].join(':')
}

/** 计算单帧 —— 管线的核心产出步骤，构建与「直接推进」校验都只认这一个函数 */
export function computeFrame(
  stars: Star[],
  timeMs: number,
  index: number,
  latitude: number,
): SkyFrame {
  return {
    timeMs,
    index,
    lstHours: localSiderealTime(timeMs, 0),
    stars: stars.map((star, i) => projectNormalized(star, i, timeMs, latitude)),
  }
}

/**
 * 按固定步长推进时间，逐帧产出星体位置。
 * 这是管线里唯一「现算」的地方；构建完成后回放只读 frames。
 */
export function buildPipeline(config: PipelineConfig, stars: Star[]): PipelineBundle {
  const problem = validateConfig(config)
  if (problem) throw new Error(`无法构建时间管线: ${problem}`)
  if (config.catalogSignature !== catalogSignature(stars)) {
    throw new Error('无法构建时间管线: 星表指纹与配置不一致（星表已变更）')
  }
  if (config.starCount !== stars.length) {
    throw new Error(`无法构建时间管线: 配置星数 ${config.starCount} 与星表 ${stars.length} 不一致`)
  }

  const count = expectedFrameCount(config)
  const frames: SkyFrame[] = []
  for (let i = 0; i < count; i++) {
    const timeMs = config.startMs + i * config.stepMs
    frames.push(computeFrame(stars, timeMs, i, config.latitude))
  }

  return {
    version: PIPELINE_VERSION,
    config,
    frames,
    createdAt: new Date().toISOString(),
  }
}

/** 校验已加载管线的结构完整性（帧序连续、无缺失、时刻与步长对齐） */
export function structuralProblems(bundle: PipelineBundle): string[] {
  const problems: string[] = []
  const { config, frames } = bundle
  if (bundle.version !== PIPELINE_VERSION) {
    problems.push(`管线版本不匹配: 期望 v${PIPELINE_VERSION}，实际 v${bundle.version}`)
  }
  const expected = expectedFrameCount(config)
  if (frames.length !== expected) {
    problems.push(`帧数缺失: 期望 ${expected} 帧，实际 ${frames.length} 帧`)
  }
  for (let i = 0; i < frames.length; i++) {
    const frame = frames[i]
    if (frame.index !== i) {
      problems.push(`帧序缺失/错乱: 位置 ${i} 的帧序号为 ${frame.index}`)
    }
    const expectedTime = config.startMs + i * config.stepMs
    if (Math.abs(frame.timeMs - expectedTime) > GRID_EPS_MS) {
      problems.push(
        `帧时刻错位: 第 ${i} 帧期望 ${new Date(expectedTime).toISOString()}，实际 ${new Date(frame.timeMs).toISOString()}`,
      )
    }
    if (frame.stars.length !== config.starCount) {
      problems.push(
        `第 ${i} 帧（${new Date(frame.timeMs).toISOString()}）星体数 ${frame.stars.length}，期望 ${config.starCount}`,
      )
    }
  }
  return problems
}

/** 时刻是否落在管线的步长网格上 */
export function isGridTime(timeMs: number, config: PipelineConfig): boolean {
  const offset = timeMs - config.startMs
  return offset >= -GRID_EPS_MS &&
    offset <= config.endMs - config.startMs + GRID_EPS_MS &&
    Math.abs(offset - Math.round(offset / config.stepMs) * config.stepMs) <= GRID_EPS_MS
}

/**
 * 按固定时刻从管线取帧。取不到时返回带原因的结果，绝不静默跳过：
 * - 超出管线时间范围
 * - 时刻不在固定步长网格上（管线只保存整步时刻）
 * - 帧序缺失或时刻对不上（数据损坏）
 */
export function getFrameAt(bundle: PipelineBundle, timeMs: number): FrameLookupResult {
  const { config } = bundle
  if (timeMs < config.startMs - GRID_EPS_MS || timeMs > config.endMs + GRID_EPS_MS) {
    return {
      found: false,
      reason: `时刻 ${new Date(timeMs).toISOString()} 超出管线范围 ${new Date(config.startMs).toISOString()} ~ ${new Date(config.endMs).toISOString()}`,
    }
  }
  const offset = timeMs - config.startMs
  const index = Math.round(offset / config.stepMs)
  if (Math.abs(offset - index * config.stepMs) > GRID_EPS_MS) {
    return {
      found: false,
      reason: `时刻 ${new Date(timeMs).toISOString()} 不在步长 ${config.stepMs}ms 的帧网格上，管线没有该帧（可调小步长重建）`,
    }
  }
  const frame = bundle.frames[index]
  if (!frame) {
    return {
      found: false,
      reason: `时刻 ${new Date(timeMs).toISOString()}（应位于第 ${index} 帧）数据缺失，管线仅含 ${bundle.frames.length} 帧`,
    }
  }
  if (frame.index !== index || Math.abs(frame.timeMs - timeMs) > GRID_EPS_MS) {
    return {
      found: false,
      reason: `第 ${index} 帧数据错位: 帧内时刻 ${new Date(frame.timeMs).toISOString()}，请求时刻 ${new Date(timeMs).toISOString()}`,
    }
  }
  return { found: true, frame }
}

/**
 * 回放：按帧序号读取已保存的帧（直接读取，不重算）。
 * 序号越界或帧缺失时返回原因，不静默。
 */
export function replayFrame(bundle: PipelineBundle, index: number): FrameReplayResult {
  if (!Number.isInteger(index)) {
    return { ok: false, reason: `回放帧序号必须是整数，收到 ${index}` }
  }
  if (index < 0 || index >= bundle.frames.length) {
    return {
      ok: false,
      reason: `回放帧序号 ${index} 越界，管线共 ${bundle.frames.length} 帧（0 ~ ${bundle.frames.length - 1}）`,
    }
  }
  const frame = bundle.frames[index]
  if (!frame) {
    return { ok: false, reason: `第 ${index} 帧缺失，回放数据不完整` }
  }
  if (frame.index !== index) {
    return { ok: false, reason: `回放帧序错乱: 请求第 ${index} 帧，取到帧序号 ${frame.index}` }
  }
  return { ok: true, frame }
}

/**
 * 对比两帧中每颗星的位置差异（用于两个时刻的星空对比）。
 * 任一颗星在任一帧不可见时，标记 bothVisible=false 并给出角度差（球面距离仍可算）。
 */
export function diffFrames(bundle: PipelineBundle, fromIndex: number, toIndex: number): FrameDeltaDiff {
  const a = replayFrame(bundle, fromIndex)
  if (!a.ok) throw new Error(`无法对比: ${a.reason}`)
  const b = replayFrame(bundle, toIndex)
  if (!b.ok) throw new Error(`无法对比: ${b.reason}`)

  const deltas: StarDelta[] = a.frame.stars.map((sa, i) => {
    const sb = b.frame.stars[i]
    const bothVisible = sa.visible && sb.visible
    // 地平坐标系下的单位向量（x 北、y 西、z 上）
    const va = altAzToVector(sa.alt, sa.az)
    const vb = altAzToVector(sb.alt, sb.az)
    const dot = Math.min(1, Math.max(-1, va[0] * vb[0] + va[1] * vb[1] + va[2] * vb[2]))
    let altDelta = sb.alt - sa.alt
    let azDelta = sb.az - sa.az
    // 角度差归一到 [-PI, PI]
    while (azDelta > Math.PI) azDelta -= 2 * Math.PI
    while (azDelta < -Math.PI) azDelta += 2 * Math.PI
    const nxDelta = sb.nx - sa.nx
    const nyDelta = sb.ny - sa.ny
    return {
      index: i,
      name: sa.name,
      altDelta,
      azDelta,
      normDistance: bothVisible ? Math.hypot(nxDelta, nyDelta) : 0,
      angularDeg: (Math.acos(dot) * 180) / Math.PI,
      bothVisible,
    }
  })

  return {
    fromTimeMs: a.frame.timeMs,
    toTimeMs: b.frame.timeMs,
    fromIndex,
    toIndex,
    deltas,
  }
}

function altAzToVector(alt: number, az: number): [number, number, number] {
  return [
    Math.cos(alt) * Math.cos(az),
    Math.cos(alt) * Math.sin(az),
    Math.sin(alt),
  ]
}

/** 序列化为可落盘字符串（localStorage / 文件共用同一格式） */
export function serializeBundle(bundle: PipelineBundle): string {
  return JSON.stringify(bundle)
}

/** 反序列化并做结构校验；损坏或结构不完整时抛出带原因的错误，不静默丢弃 */
export function deserializeBundle(text: string): PipelineBundle {
  let parsed: PipelineBundle
  try {
    parsed = JSON.parse(text) as PipelineBundle
  } catch (e) {
    throw new Error(`管线数据解析失败: ${(e as Error).message}`)
  }
  if (!parsed || typeof parsed !== 'object' || !parsed.config || !Array.isArray(parsed.frames)) {
    throw new Error('管线数据结构无效: 缺少 config 或 frames')
  }
  const problems = structuralProblems(parsed)
  if (problems.length > 0) {
    throw new Error(`管线数据校验失败: ${problems.join('；')}`)
  }
  return parsed
}
