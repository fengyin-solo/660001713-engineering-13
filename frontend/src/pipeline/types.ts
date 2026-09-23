import type { Star } from '../types'
import type { FrameStar } from './astronomy'

/** 一条可回放时间管线的配置：时间范围 + 固定步长 + 视图参数 */
export interface PipelineConfig {
  /** 起始时刻 Unix 毫秒 */
  startMs: number
  /** 结束时刻 Unix 毫秒（含） */
  endMs: number
  /** 帧间固定步长（毫秒） */
  stepMs: number
  /** 纬度（度） */
  latitude: number
  /** 缩放（记录用；帧的归一化坐标与缩放无关，重绘时再线性映射） */
  zoom: number
  /** 星表指纹，星表变化后旧缓存自动失效 */
  catalogSignature: string
  /** 星的数量（与星表指纹双重校验） */
  starCount: number
}

/** 管线中的一帧：某一时刻全部星体的位置结果 */
export interface SkyFrame {
  /** 该帧时刻 Unix 毫秒 */
  timeMs: number
  /** 帧序号，从 0 开始连续递增 */
  index: number
  /** 本地恒星时（小时），与星体位置一起落盘，回放时直接展示无需重算 */
  lstHours: number
  stars: FrameStar[]
}

/** 序列化后落盘的完整管线 */
export interface PipelineBundle {
  version: number
  config: PipelineConfig
  frames: SkyFrame[]
  createdAt: string
}

/** 单颗星在两帧之间的变化 */
export interface StarDelta {
  index: number
  name: string
  /** 高度角变化（弧度） */
  altDelta: number
  /** 方位角变化（弧度） */
  azDelta: number
  /** 归一化坐标位移长度（与星盘尺度成正比） */
  normDistance: number
  /** 球面角距离（度），用于直观比较移动幅度 */
  angularDeg: number
  /** 两帧是否都可见；有一帧不可见时无法连线对比 */
  bothVisible: boolean
}

/** 两帧逐星差异对比结果 */
export interface FrameDeltaDiff {
  fromTimeMs: number
  toTimeMs: number
  fromIndex: number
  toIndex: number
  deltas: StarDelta[]
}

/** 按时刻取帧的结果类型 —— 取不到时必须带 reason，不允许静默返回 undefined */
export type FrameLookupResult =
  | { found: true; frame: SkyFrame }
  | { found: false; reason: string }

export type FrameReplayResult =
  | { ok: true; frame: SkyFrame }
  | { ok: false; reason: string }

/** 管线持久化存储接口（浏览器 localStorage / 构建期文件系统各自实现） */
export interface PipelineStore {
  save(key: string, bundle: PipelineBundle): void
  load(key: string): PipelineBundle | null
  has(key: string): boolean
}

export type { Star }
