import { ref, computed } from 'vue'
import { defineStore } from 'pinia'
import { STARS, CONSTELLATIONS } from '../data/stars'
import type { Star } from '../types'
import {
  localSiderealTime,
  normalizedToScreen,
  type FrameStar,
} from '../pipeline/astronomy'
import {
  buildPipeline,
  diffFrames,
  getFrameAt,
  makeConfig,
  pipelineKey,
  replayFrame,
} from '../pipeline/timePipeline'
import type { FrameDeltaDiff, PipelineBundle } from '../pipeline/types'
import { LocalStoragePipelineStore } from '../pipeline/storage'

export const useSkyStore = defineStore('sky', () => {
  const viewDate = ref(new Date())
  const zoom = ref(1.0)
  const panX = ref(0)
  const panY = ref(0)
  const showLabels = ref(true)
  const showConstLines = ref(true)
  const showGrid = ref(true)
  const selectedStar = ref<Star | null>(null)
  const searchQuery = ref('')
  const latitude = ref(39.9) // Beijing default

  // ---- 可回放时间管线状态 ----
  /** 当前已构建/加载的管线（帧位置已落盘，回放只读不算） */
  const pipeline = ref<PipelineBundle | null>(null)
  const playing = ref(false)
  const currentFrameIndex = ref(0)
  /** 对比基准帧序号；非 null 时画布叠加两帧位移向量 */
  const baselineFrameIndex = ref<number | null>(null)
  /** 给用户看的日志/错误信息：管线数据缺失或时刻取不到时在此说明，不静默跳过 */
  const notice = ref('')
  /** 本次管线是否复用了本地已保存数据（true = 回放直接读取，未重算） */
  const reusedCache = ref(false)
  const building = ref(false)

  const pipelineStore = new LocalStoragePipelineStore()

  const localSiderealTimeNow = computed(() => localSiderealTime(viewDate.value.getTime(), 0))

  /** 当前回放帧；不在回放态时为 null */
  const currentFrame = computed(() => {
    const bundle = pipeline.value
    if (!bundle) return null
    const result = replayFrame(bundle, currentFrameIndex.value)
    if (!result.ok) {
      // 帧缺失：记录原因并停止，避免静默渲染错误帧
      notice.value = `当前帧无法回放: ${result.reason}`
      playing.value = false
      return null
    }
    return result.frame
  })

  /** 对比基准帧 */
  const baselineFrame = computed(() => {
    const bundle = pipeline.value
    if (!bundle || baselineFrameIndex.value === null) return null
    const result = replayFrame(bundle, baselineFrameIndex.value)
    if (!result.ok) {
      notice.value = `对比基准帧无法读取: ${result.reason}`
      return null
    }
    return result.frame
  })

  /** 当前帧相对基准帧的逐星差异 */
  const currentDiff = computed<FrameDeltaDiff | null>(() => {
    const bundle = pipeline.value
    if (!bundle || baselineFrameIndex.value === null) return null
    try {
      return diffFrames(bundle, baselineFrameIndex.value, currentFrameIndex.value)
    } catch (e) {
      notice.value = `时刻对比失败: ${(e as Error).message}`
      return null
    }
  })

  const filteredStars = computed(() => {
    if (!searchQuery.value) return []
    const q = searchQuery.value.toLowerCase()
    return STARS.filter(s => s.name.toLowerCase().includes(q)).slice(0, 5)
  })

  /**
   * 单颗星的屏幕投影（自由浏览态：按当前时刻现算，时间旅行直接选时刻的路径）。
   * 回放态请用 frameStarScreen 直接读已保存帧，不经过此函数。
   */
  function projectStar(ra: number, dec: number, cx: number, cy: number, scale: number): [number, number] {
    const ha = (localSiderealTimeNow.value - ra) * 15 * Math.PI / 180
    const decRad = dec * Math.PI / 180
    const latRad = latitude.value * Math.PI / 180

    const alt = Math.asin(Math.sin(decRad) * Math.sin(latRad) + Math.cos(decRad) * Math.cos(latRad) * Math.cos(ha))
    const az = Math.atan2(-Math.cos(decRad) * Math.sin(ha), Math.sin(decRad) * Math.cos(latRad) - Math.cos(decRad) * Math.sin(latRad) * Math.cos(ha))

    if (alt < -0.1) return [-999, -999] // below horizon

    const r = (Math.PI / 2 - alt) * scale * 0.45
    const x = cx + panX.value + r * Math.sin(az)
    const y = cy + panY.value - r * Math.cos(az)
    return [x, y]
  }

  /** 已保存帧的星位 → 屏幕坐标（纯线性映射，缩放/平移变化不再触发重算） */
  function frameStarToScreen(fs: FrameStar, cx: number, cy: number, scale: number): [number, number] {
    if (!fs.visible) return [-999, -999]
    return normalizedToScreen(fs, cx, cy, scale, panX.value, panY.value)
  }

  /** 画布取当前帧某下标的星位（回放态渲染/点选用） */
  function frameStarScreen(index: number, cx: number, cy: number, scale: number): [number, number] {
    const frame = currentFrame.value
    const fs = frame?.stars[index]
    if (!fs) return [-999, -999]
    return frameStarToScreen(fs, cx, cy, scale)
  }

  function starRadius(mag: number): number {
    return Math.max(1, 5 - mag) * zoom.value
  }

  function spectralColor(spectral: string): string {
    const colors: Record<string, string> = {
      'O': '#9bb0ff', 'B': '#aabfff', 'A': '#cad7ff',
      'F': '#f8f7ff', 'G': '#fff4ea', 'K': '#ffd2a1', 'M': '#ffcc6f'
    }
    return colors[spectral] || '#ffffff'
  }

  function selectStar(x: number, y: number, cx: number, cy: number, scale: number) {
    let closest: Star | null = null
    let minDist = 20
    for (let i = 0; i < STARS.length; i++) {
      const star = STARS[i]
      const [sx, sy] = currentFrame.value
        ? frameStarScreen(i, cx, cy, scale)
        : projectStar(star.ra, star.dec, cx, cy, scale)
      const dist = Math.hypot(sx - x, sy - y)
      if (dist < minDist) { minDist = dist; closest = star }
    }
    selectedStar.value = closest
  }

  // ---- 时间管线操作 ----

  /**
   * 按时间范围 + 固定步长构建可回放管线。
   * 先尝试读取本地已保存的同键管线（回放直接读，不重算）；
   * 缺失或损坏时说明原因并重建。
   */
  function buildReplay(startMs: number, endMs: number, stepMs: number): boolean {
    playing.value = false
    building.value = true
    try {
      const config = makeConfig(startMs, endMs, stepMs, latitude.value, zoom.value, STARS)
      const key = pipelineKey(config)

      let bundle: PipelineBundle | null = null
      // 优先读取本地已保存管线 —— 回放直接读，不重算
      if (pipelineStore.has(key)) {
        try {
          bundle = pipelineStore.load(key)
          if (bundle) {
            reusedCache.value = true
            notice.value = `已从本地管线缓存读取 ${bundle.frames.length} 帧（回放不重算），键: ${key}`
          }
        } catch (e) {
          notice.value = `本地管线数据无法读取（${(e as Error).message}），已改为重新构建`
          bundle = null
        }
      } else {
        notice.value = `本地没有该时间管线的缓存数据（${new Date(startMs).toISOString()} ~ ${new Date(endMs).toISOString()}，步长 ${stepMs / 3600000}h），已现场构建并保存`
      }

      if (!bundle) {
        bundle = buildPipeline(config, STARS)
        reusedCache.value = false
        try {
          pipelineStore.save(key, bundle)
        } catch (e) {
          // 存不上不影响本次回放，但必须说明：下次无法复用、仍会重算
          notice.value = `管线已构建 ${bundle.frames.length} 帧，但本地保存失败: ${(e as Error).message}`
        }
      }

      pipeline.value = bundle
      currentFrameIndex.value = 0
      baselineFrameIndex.value = null
      syncViewDateToFrame()
      return true
    } catch (e) {
      notice.value = `时间管线构建失败: ${(e as Error).message}`
      pipeline.value = null
      return false
    } finally {
      building.value = false
    }
  }

  /** 顺序回放一帧（直接读保存结果，不重算） */
  function stepReplay(delta: number) {
    const bundle = pipeline.value
    if (!bundle) return
    const next = currentFrameIndex.value + delta
    const result = replayFrame(bundle, next)
    if (!result.ok) {
      // 到末尾正常停止；其他取不到的情况说明原因
      if (next >= bundle.frames.length) {
        playing.value = false
        return
      }
      notice.value = result.reason
      playing.value = false
      return
    }
    currentFrameIndex.value = next
    syncViewDateToFrame()
  }

  /** 按固定时刻跳转：时刻取不到（越界/不在步长网格上）时说明原因，不静默 */
  function seekReplay(timeMs: number): boolean {
    const bundle = pipeline.value
    if (!bundle) return false
    const result = getFrameAt(bundle, timeMs)
    if (!result.found) {
      notice.value = result.reason
      return false
    }
    currentFrameIndex.value = result.frame.index
    syncViewDateToFrame()
    return true
  }

  function togglePlay() {
    if (!pipeline.value) {
      notice.value = '尚无时间管线，请先构建一段回放'
      return
    }
    playing.value = !playing.value
  }

  function stopReplay() {
    playing.value = false
  }

  function exitReplay() {
    playing.value = false
    pipeline.value = null
    baselineFrameIndex.value = null
    currentFrameIndex.value = 0
    notice.value = '已退出管线回放，恢复为按当前时刻实时投影'
  }

  /** 把当前帧标记为对比基准（两个时刻的星空对比） */
  function setBaselineHere() {
    baselineFrameIndex.value = currentFrameIndex.value
  }

  function clearBaseline() {
    baselineFrameIndex.value = null
  }

  /** 回放期间调整纬度会使整条管线失效：停止并说明原因，需要重建 */
  function onLatitudeChanged() {
    if (pipeline.value) {
      notice.value = '纬度已变化，已保存管线的星位按旧纬度计算，回放已停止；请按新纬度重新构建管线'
      playing.value = false
      pipeline.value = null
      baselineFrameIndex.value = null
    }
  }

  function syncViewDateToFrame() {
    const frame = currentFrame.value
    if (frame) viewDate.value = new Date(frame.timeMs)
  }

  return {
    viewDate, zoom, panX, panY, showLabels, showConstLines, showGrid,
    selectedStar, searchQuery, latitude,
    localSiderealTime: computed(() =>
      currentFrame.value ? currentFrame.value.lstHours : localSiderealTimeNow.value,
    ),
    filteredStars,
    projectStar, starRadius, spectralColor, selectStar,
    // pipeline
    pipeline, playing, currentFrameIndex, currentFrame, baselineFrame, baselineFrameIndex,
    currentDiff, notice, reusedCache, building,
    buildReplay, stepReplay, seekReplay, togglePlay, stopReplay, exitReplay,
    setBaselineHere, clearBaseline, onLatitudeChanged, frameStarScreen,
    STARS, CONSTELLATIONS
  }
})
