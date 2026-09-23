import type { Star } from '../types/index'

/** 单颗星在某个时刻的投影结果（已落盘的可复用中间结果） */
export interface FrameStar {
  name: string
  /** 本地恒星时（小时，0-24），时间推进的结果 */
  lst: number
  /** 地平高度（弧度，<0 表示地平线下） */
  alt: number
  /** 地平方位角（弧度） */
  az: number
  visible: boolean
  /** 画布像素坐标；不可见时为 null */
  x: number | null
  y: number | null
}

/** 管线按固定时间步长产出的一帧 */
export interface SkyFrame {
  /** 帧序号，从 0 开始且必须连续 */
  index: number
  /** 该帧对应的时刻（ISO 字符串） */
  time: string
  /** 该帧对应的 epoch 毫秒，便于比较与排序 */
  epochMs: number
  lst: number
  stars: FrameStar[]
}

/** 时间管线的固定参数；参数任一变化都使已落盘帧失效 */
export interface PipelineConfig {
  startTime: string
  endTime: string
  /** 时间步长（毫秒） */
  stepMs: number
  latitude: number
  width: number
  height: number
  zoom: number
  panX: number
  panY: number
}

/** 管线清单，与帧一起本地保存 */
export interface PipelineManifest {
  version: number
  createdAt: string
  config: PipelineConfig
  /** 星表签名：星数 + 逐星名称/坐标指纹，星表变化时旧帧失效 */
  starSignature: string
  frameCount: number
  frames: { index: number; time: string; epochMs: number }[]
}

export type PipelineLogger = (level: 'info' | 'warn' | 'error', msg: string) => void

export const PIPELINE_VERSION = 1

/** 构建期与运行时共用的默认管线参数 */
export const DEFAULT_CONFIG: PipelineConfig = {
  startTime: '2024-01-01T00:00:00.000Z',
  endTime: '2024-01-03T00:00:00.000Z',
  stepMs: 6 * 3600 * 1000, // 6 小时一帧
  latitude: 39.9,
  width: 1200,
  height: 800,
  zoom: 1,
  panX: 0,
  panY: 0,
}

/** 帧序列化为文件/存储项时的包裹格式 */
export interface StoredFrame {
  signature: string
  frame: SkyFrame
}

/** 两颗星在两个时刻之间的差异项 */
export interface StarDiff {
  name: string
  visibleBefore: boolean
  visibleAfter: boolean
  altDeltaDeg: number
  azDeltaDeg: number
  /** 画布位移（像素），任一侧不可见时为 null */
  pixelDist: number | null
}

export interface FrameDiff {
  indexA: number
  indexB: number
  timeA: string
  timeB: string
  stars: StarDiff[]
}

/** 星表指纹：任何星名或坐标变化都会改变签名，使旧帧被判定为缺失/失效 */
export function starSignature(stars: Pick<Star, 'name' | 'ra' | 'dec'>[]): string {
  let h = 2166136261
  const feed = (s: string) => {
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i)
      h = Math.imul(h, 16777619)
    }
  }
  feed(`n=${stars.length};`)
  for (const s of stars) {
    feed(`${s.name}|${s.ra.toFixed(6)}|${s.dec.toFixed(6)};`)
  }
  return `v${PIPELINE_VERSION}-${(h >>> 0).toString(16)}-${stars.length}`
}
