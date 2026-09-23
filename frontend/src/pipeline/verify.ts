import { computeFrame, getFrameAt, pipelineKey, replayFrame, structuralProblems, validateConfig, buildPipeline } from './timePipeline'
import type { FrameStar } from './astronomy'
import type { PipelineBundle, PipelineConfig, PipelineStore } from './types'
import type { Star } from '../types'

/**
 * 构建期管线校验：
 * 1. 按时间范围 + 固定步长构建整条管线并本地保存；
 * 2. 重新从存储中读回（回放只读，不重算），检查帧序连续、无缺失；
 * 3. 对固定检查时刻，用「逐帧/按时刻回放」取帧，与「直接推进现算」逐星比对。
 * 任何不一致、缺帧、时刻取不到都会在 errors 中给出具体时刻，由调用方令构建失败。
 */

export interface StarMismatch {
  index: number
  name: string
  field: 'visible' | 'nx' | 'ny' | 'alt' | 'az'
  replayed: number | boolean
  direct: number | boolean
  error: number
}

export interface CheckpointReport {
  timeMs: number
  iso: string
  frameIndex: number | null
  status: 'match' | 'mismatch' | 'missing'
  maxAbsError: number
  reason?: string
  mismatches: StarMismatch[]
}

export interface VerifyOptions {
  config: PipelineConfig
  stars: Star[]
  store: PipelineStore
  /** 固定检查时刻（Unix 毫秒），必须落在步长网格上 */
  checkpoints: number[]
  /** 逐星位置比对容差（弧度/归一化坐标），默认 1e-9 */
  tolerance?: number
}

export interface VerifyResult {
  ok: boolean
  reusedExisting: boolean
  key: string
  frameCount: number
  /** 全量逐帧顺序回放的校验结果 */
  fullReplay: { framesChecked: number; problems: string[] }
  checkpoints: CheckpointReport[]
  errors: string[]
  bundle: PipelineBundle
}

function iso(timeMs: number): string {
  return new Date(timeMs).toISOString()
}

/** 比较回放帧与直接推进帧的每一颗星，返回超出容差的差异 */
export function compareFrames(
  replayed: { timeMs: number; lstHours: number; stars: FrameStar[] },
  direct: { timeMs: number; lstHours: number; stars: FrameStar[] },
  tolerance: number,
): StarMismatch[] {
  const mismatches: StarMismatch[] = []
  if (Math.abs(replayed.lstHours - direct.lstHours) > tolerance) {
    mismatches.push({
      index: -1, name: '(帧元数据 LST)', field: 'alt',
      replayed: replayed.lstHours, direct: direct.lstHours,
      error: Math.abs(replayed.lstHours - direct.lstHours),
    })
  }
  const count = Math.min(replayed.stars.length, direct.stars.length)
  for (let i = 0; i < count; i++) {
    const a = replayed.stars[i]
    const b = direct.stars[i]
    if (a.visible !== b.visible) {
      mismatches.push({ index: i, name: a.name, field: 'visible', replayed: a.visible, direct: b.visible, error: 1 })
      continue
    }
    const fields: ('nx' | 'ny' | 'alt' | 'az')[] = ['nx', 'ny', 'alt', 'az']
    for (const field of fields) {
      const va = a[field]
      const vb = b[field]
      const err = Math.abs(va - vb)
      if (err > tolerance) {
        mismatches.push({ index: i, name: a.name, field, replayed: va, direct: vb, error: err })
      }
    }
  }
  if (replayed.stars.length !== direct.stars.length) {
    mismatches.push({
      index: -1,
      name: '(星体数量)',
      field: 'visible',
      replayed: replayed.stars.length,
      direct: direct.stars.length,
      error: Math.abs(replayed.stars.length - direct.stars.length),
    })
  }
  return mismatches
}

export function verifyTimePipeline(options: VerifyOptions): VerifyResult {
  const { config, stars, store, checkpoints, tolerance = 1e-9 } = options
  const errors: string[] = []
  const key = pipelineKey(config)

  const configProblem = validateConfig(config)
  if (configProblem) {
    return fail(errors, `管线配置非法: ${configProblem}`, empty(key, config, 0))
  }

  // 1) 构建（已有同键数据时记录复用情况，但构建流程要求落盘最新结果，仍重建覆盖）
  const reusedExisting = store.has(key)
  let bundle: PipelineBundle
  try {
    bundle = buildPipeline(config, stars)
    store.save(key, bundle)
  } catch (e) {
    return fail(errors, `构建/保存管线失败: ${(e as Error).message}`, empty(key, config, 0))
  }

  // 2) 从本地存储重新读回 —— 回放走的是读取路径而不是重算
  let loaded: PipelineBundle | null
  try {
    loaded = store.load(key)
  } catch (e) {
    return fail(errors, `管线数据读取失败（本地数据可能已损坏）: ${(e as Error).message}`, empty(key, config, bundle.frames.length, bundle))
  }
  if (!loaded) {
    return fail(errors, `管线数据缺失: 保存后按键 ${key} 仍读取不到任何数据`, empty(key, config, bundle.frames.length, bundle))
  }
  const diskBundle: PipelineBundle = loaded

  const structureProblems = structuralProblems(diskBundle)
  if (structureProblems.length > 0) {
    for (const p of structureProblems) errors.push(`帧结构问题: ${p}`)
  }

  // 3a) 全量逐帧顺序回放：帧序不能缺失，且每帧与直接推进一致
  const fullProblems: string[] = []
  let framesChecked = 0
  for (let i = 0; i < diskBundle.frames.length; i++) {
    const replayed = replayFrame(diskBundle, i)
    if (!replayed.ok) {
      fullProblems.push(`第 ${i} 帧回放失败: ${replayed.reason}`)
      continue
    }
    const frame = replayed.frame
    const direct = computeFrame(stars, frame.timeMs, i, config.latitude)
    const mismatches = compareFrames(frame, direct, tolerance)
    framesChecked++
    if (mismatches.length > 0) {
      const worst = mismatches.reduce((m, x) => (x.error > m.error ? x : m))
      fullProblems.push(
        `第 ${i} 帧 ${iso(frame.timeMs)} 回放与直接推进不一致（${mismatches.length} 处，最大误差 ${worst.error.toExponential(3)}，星体: ${worst.name} ${worst.field}）`,
      )
    }
  }
  for (const p of fullProblems) errors.push(p)

  // 3b) 固定时刻：按时刻取帧（回放）对比直接推进
  const reports: CheckpointReport[] = checkpoints.map(timeMs => {
    const lookup = getFrameAt(diskBundle, timeMs)
    if (!lookup.found) {
      const reason = `检查时刻 ${iso(timeMs)} 取不到帧: ${lookup.reason}`
      errors.push(reason)
      return { timeMs, iso: iso(timeMs), frameIndex: null, status: 'missing', maxAbsError: Infinity, reason: lookup.reason, mismatches: [] }
    }
    const replayedFrame = lookup.frame
    // 同时验证「逐帧顺序回放」在该序号也能取到同一帧
    const sequential = replayFrame(diskBundle, replayedFrame.index)
    if (!sequential.ok) {
      errors.push(`检查时刻 ${iso(timeMs)} 顺序回放失败: ${sequential.reason}`)
      return { timeMs, iso: iso(timeMs), frameIndex: replayedFrame.index, status: 'missing', maxAbsError: Infinity, reason: sequential.reason, mismatches: [] }
    }
    const direct = computeFrame(stars, timeMs, replayedFrame.index, config.latitude)
    const mismatches = compareFrames(sequential.frame, direct, tolerance)
    const maxAbsError = mismatches.reduce((m, x) => Math.max(m, x.error), 0)
    if (mismatches.length > 0) {
      errors.push(
        `检查时刻 ${iso(timeMs)}（第 ${replayedFrame.index} 帧）回放结果与直接推进不一致: ` +
        `${mismatches.length} 处差异，最大误差 ${maxAbsError.toExponential(3)}，首处: 星体「${mismatches[0].name}」${mismatches[0].field} ` +
        `回放=${String(mismatches[0].replayed)} 直接=${String(mismatches[0].direct)}`,
      )
    }
    return {
      timeMs,
      iso: iso(timeMs),
      frameIndex: replayedFrame.index,
      status: mismatches.length > 0 ? 'mismatch' : 'match',
      maxAbsError,
      mismatches,
    }
  })

  return {
    ok: errors.length === 0,
    reusedExisting,
    key,
    frameCount: diskBundle.frames.length,
    fullReplay: { framesChecked, problems: fullProblems },
    checkpoints: reports,
    errors,
    bundle: diskBundle,
  }
}

function empty(key: string, config: PipelineConfig, frameCount: number, bundle?: PipelineBundle): VerifyResult {
  return {
    ok: false,
    reusedExisting: false,
    key,
    frameCount,
    fullReplay: { framesChecked: 0, problems: [] },
    checkpoints: [],
    errors: [],
    bundle: bundle ?? { version: 0, config, frames: [], createdAt: '' },
  }
}

function fail(errors: string[], message: string, result: VerifyResult): VerifyResult {
  errors.push(message)
  return { ...result, errors: [...errors] }
}
