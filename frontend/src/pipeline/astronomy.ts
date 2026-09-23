import type { Star } from '../types'
import type { FrameStar, PipelineConfig, SkyFrame } from './types'

/**
 * 时间推进：由 Date 计算本地恒星时（小时）。
 * 纯函数，不依赖任何响应式状态，时间管线的"直接推进"与"逐帧回放"共用此实现。
 */
export function localSiderealTime(date: Date): number {
  const jd = date.getTime() / 86400000 + 2440587.5
  const T = (jd - 2451545.0) / 36525.0
  let lst = 280.46061837 + 360.98564736629 * (jd - 2451545.0) + T * T * (0.000387933 - T / 38710000)
  lst = ((lst % 360) + 360) % 360
  return lst / 15 // 换算成小时
}

/** 赤道坐标（ra 小时 / dec 度）→ 地平坐标（弧度） */
export function equatorialToHorizontal(
  raHours: number,
  decDeg: number,
  latitudeDeg: number,
  lstHours: number,
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
 * 投影：在给定管线参数与时刻下，把一颗星投到画布像素坐标。
 * 返回 alt < -0.1（地平线下）时 visible=false、x/y=null。
 * 这是时间管线产出并落盘的核心中间结果。
 */
export function projectAt(
  star: Pick<Star, 'ra' | 'dec'>,
  date: Date,
  config: Pick<PipelineConfig, 'latitude' | 'width' | 'height' | 'zoom' | 'panX' | 'panY'>,
): { lst: number; alt: number; az: number; visible: boolean; x: number | null; y: number | null } {
  const lst = localSiderealTime(date)
  const { alt, az } = equatorialToHorizontal(star.ra, star.dec, config.latitude, lst)
  const visible = alt >= -0.1
  if (!visible) return { lst, alt, az, visible: false, x: null, y: null }

  const cx = config.width / 2
  const cy = config.height / 2
  const scale = Math.min(config.width, config.height) * config.zoom
  const r = (Math.PI / 2 - alt) * scale * 0.45
  const x = cx + config.panX + r * Math.sin(az)
  const y = cy + config.panY - r * Math.cos(az)
  return { lst, alt, az, visible: true, x, y }
}

/**
 * 时间推进：在指定 index（= startTime + index * stepMs）处产出一帧全部星体位置。
 * 这是"直接推进"的单帧计算入口，也是构建管线时逐帧调用的同一个入口。
 */
export function computeFrame(index: number, date: Date, config: PipelineConfig, stars: Star[]): SkyFrame {
  const lst = localSiderealTime(date)
  const out: FrameStar[] = stars.map((star) => {
    const p = projectAt(star, date, config)
    return {
      name: star.name,
      lst: p.lst,
      alt: p.alt,
      az: p.az,
      visible: p.visible,
      x: p.x,
      y: p.y,
    }
  })
  return {
    index,
    time: date.toISOString(),
    epochMs: date.getTime(),
    lst,
    stars: out,
  }
}

/** 由管线配置生成每一帧对应的时刻（包含端点） */
export function frameTimes(config: Pick<PipelineConfig, 'startTime' | 'endTime' | 'stepMs'>): Date[] {
  if (config.stepMs <= 0) throw new Error('stepMs 必须为正数')
  const start = new Date(config.startTime).getTime()
  const end = new Date(config.endTime).getTime()
  if (Number.isNaN(start) || Number.isNaN(end)) {
    throw new Error(`时间范围无效: startTime=${config.startTime}, endTime=${config.endTime}`)
  }
  if (end < start) throw new Error('endTime 不能早于 startTime')
  const times: Date[] = []
  for (let t = start; t <= end; t += config.stepMs) times.push(new Date(t))
  return times
}
