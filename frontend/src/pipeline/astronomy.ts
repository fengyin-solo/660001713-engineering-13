import type { Star } from '../types'

/**
 * 时间管线的纯天文计算层。
 * 这里不依赖任何框架/存储/UI，浏览器运行时与构建期校验脚本共用同一份实现，
 * 以保证「逐帧回放读取」与「直接推进现算」走的是完全相同的数学过程。
 */

/** 与缩放/平移/画布尺寸无关的视图参数（决定星体位置的全部输入） */
export interface ViewParams {
  /** 纬度，单位度 */
  latitude: number
  /** 缩放系数，仅影响投影尺度 */
  zoom: number
}

/** 单颗星在某一帧的位置结果。归一化坐标与画布尺寸/平移无关，可直接落盘复用 */
export interface FrameStar {
  /** 星表下标 */
  index: number
  name: string
  /** 是否位于地平线上方（与旧渲染逻辑一致，alt < -0.1 rad 视为不可见） */
  visible: boolean
  /** 地平高度（弧度） */
  alt: number
  /** 地平方位角（弧度，北=0，向东计量） */
  az: number
  /** 归一化屏幕坐标：屏幕坐标 = 归一化坐标 * 缩放基准尺度 + (cx+panX, cy+panY) */
  nx: number
  ny: number
}

/** 旧渲染逻辑的地平截止角（弧度） */
export const BELOW_HORIZON_ALT = -0.1

/** 星盘投影相对基准尺度的系数，与原 projectStar 保持一致 */
export const PROJECTION_R_FACTOR = 0.45

/** 不可见星体在归一化坐标中使用的哨兵值（与旧代码的 -999 对应） */
export const SENTINEL = -999

/** Unix 毫秒时间戳 → 儒略日 */
export function julianDate(timeMs: number): number {
  return timeMs / 86400000 + 2440587.5
}

/**
 * 本地恒星时（小时，0-24）。公式与原 store 中完全一致。
 * @param timeMs Unix 毫秒时间戳
 * @param longitudeDeg 经度（度），默认 0（UTC 子午线）。原应用未使用经度
 */
export function localSiderealTime(timeMs: number, longitudeDeg = 0): number {
  const jd = julianDate(timeMs)
  const T = (jd - 2451545.0) / 36525.0
  let lst = 280.46061837 + 360.98564736629 * (jd - 2451545.0) + T * T * (0.000387933 - T / 38710000)
  lst = ((lst % 360) + 360) % 360
  return (lst + longitudeDeg) / 15
}

/** 赤道坐标（RA 小时 / Dec 度）→ 地平坐标（弧度） */
export function equatorialToHorizontal(
  raHours: number,
  decDeg: number,
  lstHours: number,
  latitudeDeg: number,
): { alt: number; az: number } {
  const ha = (lstHours - raHours) * 15 * Math.PI / 180
  const decRad = decDeg * Math.PI / 180
  const latRad = latitudeDeg * Math.PI / 180

  const alt = Math.asin(
    Math.sin(decRad) * Math.sin(latRad) + Math.cos(decRad) * Math.cos(latRad) * Math.cos(ha),
  )
  const az = Math.atan2(
    -Math.cos(decRad) * Math.sin(ha),
    Math.sin(decRad) * Math.cos(latRad) - Math.cos(decRad) * Math.sin(latRad) * Math.cos(ha),
  )
  return { alt, az }
}

/**
 * 计算单颗星在某时刻的归一化投影位置。
 *
 * 归一化坐标把「时间推进 + 投影」与「缩放/平移/画布重绘」解耦：
 *   x = nx * scale + cx + panX,  y = ny * scale + cy + panY
 * 其中 scale = min(w, h) * zoom。
 * zoom 不影响星下点/方位/可见性，因此同一纬度下整条时间线只需计算一次。
 */
export function projectNormalized(
  star: Star,
  index: number,
  timeMs: number,
  latitudeDeg: number,
): FrameStar {
  const lst = localSiderealTime(timeMs, 0)
  const { alt, az } = equatorialToHorizontal(star.ra, star.dec, lst, latitudeDeg)
  const visible = alt >= BELOW_HORIZON_ALT
  if (!visible) {
    return { index, name: star.name, visible, alt, az, nx: SENTINEL, ny: SENTINEL }
  }
  const r = (Math.PI / 2 - alt) * PROJECTION_R_FACTOR
  return {
    index,
    name: star.name,
    visible,
    alt,
    az,
    nx: r * Math.sin(az),
    ny: -r * Math.cos(az),
  }
}

/** 归一化坐标 → 实际画布像素坐标 */
export function normalizedToScreen(
  fs: FrameStar,
  cx: number,
  cy: number,
  scale: number,
  panX = 0,
  panY = 0,
): [number, number] {
  return [cx + panX + fs.nx * scale, cy + panY + fs.ny * scale]
}
