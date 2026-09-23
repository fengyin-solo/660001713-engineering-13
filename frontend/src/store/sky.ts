import { ref, computed } from 'vue'
import { defineStore } from 'pinia'
import { STARS, CONSTELLATIONS } from '../data/stars'
import type { Star } from '../types'
import {
  DEFAULT_CONFIG,
  type FrameDiff,
  type PipelineConfig,
  type PipelineLogger,
  type SkyFrame,
} from '../pipeline/types'
import { equatorialToHorizontal, localSiderealTime } from '../pipeline/astronomy'
import { TimePipeline } from '../pipeline/pipeline'
import { BrowserFrameStorage, consoleLogger } from '../pipeline/storage'

/** 回放/对比 UI 用的固定步长选项（毫秒） */
const STEP_OPTIONS = [
  { label: '1 小时', ms: 3600 * 1000 },
  { label: '6 小时', ms: 6 * 3600 * 1000 },
  { label: '12 小时', ms: 12 * 3600 * 1000 },
  { label: '1 天', ms: 24 * 3600 * 1000 },
]

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
  const logs = ref<{ time: string; level: string; msg: string }[]>([])
  const pipelineConfig = ref<PipelineConfig>({ ...DEFAULT_CONFIG, latitude: latitude.value })
  const pipelineReady = ref(false)
  const pipelineFrameCount = ref(0)
  const isBuilding = ref(false)
  const isPlaying = ref(false)
  const currentFrame = ref<SkyFrame | null>(null)
  const frameDiff = ref<FrameDiff | null>(null)
  const compareIndex = ref<number | null>(null)
  let pipeline: TimePipeline | null = null
  let playTimer: ReturnType<typeof setInterval> | null = null
  const PLAY_INTERVAL_MS = 400

  const logger: PipelineLogger = (level, msg) => {
    consoleLogger(level, msg)
    logs.value.unshift({ time: new Date().toLocaleTimeString(), level, msg })
    if (logs.value.length > 80) logs.value.length = 80
  }

  const localSidereal = computed(() => localSiderealTime(viewDate.value))
  // 旧模板里引用的名字保留
  const localSiderealTimeStore = localSidereal

  const filteredStars = computed(() => {
    if (!searchQuery.value) return []
    const q = searchQuery.value.toLowerCase()
    return STARS.filter(s => s.name.toLowerCase().includes(q)).slice(0, 5)
  })

  /**
   * 实时投影（未回放时）：与管线共用同一份天文纯函数，
   * 保证"实时直接推进"和"逐帧回放"在同一时刻必然得到相同位置。
   */
  function projectStar(ra: number, dec: number, cx: number, cy: number, scale: number): [number, number] {
    const lst = localSidereal.value
    const { alt, az } = equatorialToHorizontal(ra, dec, latitude.value, lst)

    if (alt < -0.1) return [-999, -999] // below horizon

    const r = (Math.PI / 2 - alt) * scale * 0.45
    const x = cx + panX.value + r * Math.sin(az)
    const y = cy + panY.value - r * Math.cos(az)
    return [x, y]
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
    for (const star of STARS) {
      const [sx, sy] = projectStar(star.ra, star.dec, cx, cy, scale)
      const dist = Math.hypot(sx - x, sy - y)
      if (dist < minDist) { minDist = dist; closest = star }
    }
    selectedStar.value = closest
  }

  // ---------------- 时间管线 ----------------

  /** 构建（或复用）管线：按固定步长逐帧产出星体位置并本地保存 */
  async function buildPipeline(force = false) {
    if (isBuilding.value) return
    isBuilding.value = true
    stopPlayback()
    try {
      const p = new TimePipeline(
        pipelineConfig.value,
        STARS,
        new BrowserFrameStorage(logger),
        logger,
      )
      const result = await p.build(force)
      pipeline = p
      pipelineReady.value = true
      pipelineFrameCount.value = result.manifest.frameCount
      logger('info', result.rebuilt
        ? `管线已构建并保存 ${result.manifest.frameCount} 帧`
        : `复用已保存管线 ${result.manifest.frameCount} 帧（未重算）`)
      await loadFrame(0)
    } catch (e) {
      pipelineReady.value = false
      logger('error', `管线构建失败: ${(e as Error).message}`)
    } finally {
      isBuilding.value = false
    }
  }

  /** 回放读取：只加载已保存帧，不重新计算 */
  async function loadFrame(index: number) {
    if (!pipeline) {
      logger('warn', '管线尚未构建，无法回放帧；请先构建时间管线')
      return
    }
    try {
      currentFrame.value = await pipeline.readFrame(index)
      if (compareIndex.value !== null) await refreshDiff()
    } catch (e) {
      currentFrame.value = null
      isPlaying.value = false
      if (playTimer) { clearInterval(playTimer); playTimer = null }
      logger('error', `回放中断: ${(e as Error).message}`)
    }
  }

  function startPlayback() {
    if (!pipelineReady.value) {
      logger('warn', '管线未就绪，无法开始回放')
      return
    }
    if (isPlaying.value) return
    if (currentFrame.value && currentFrame.value.index >= pipelineFrameCount.value - 1) {
      void loadFrame(0)
    }
    isPlaying.value = true
    logger('info', '开始逐帧回放（读取已保存帧，不重算）')
    playTimer = setInterval(() => {
      const cur = currentFrame.value
      if (!pipelineReady.value) { stopPlayback(); return }
      if (!cur || cur.index >= pipelineFrameCount.value - 1) {
        stopPlayback()
        return
      }
      void loadFrame(cur.index + 1)
    }, PLAY_INTERVAL_MS)
  }

  function pausePlayback() {
    if (!isPlaying.value) return
    isPlaying.value = false
    if (playTimer) { clearInterval(playTimer); playTimer = null }
    logger('info', '回放已暂停')
  }

  function stopPlayback() {
    if (playTimer || isPlaying.value) logger('info', '回放已停止')
    isPlaying.value = false
    if (playTimer) { clearInterval(playTimer); playTimer = null }
  }

  async function stepFrame(delta: number) {
    if (!pipelineReady.value || !currentFrame.value) return
    pausePlayback()
    const next = Math.min(pipelineFrameCount.value - 1, Math.max(0, currentFrame.value.index + delta))
    if (next !== currentFrame.value.index) await loadFrame(next)
  }

  function setCompareIndex(i: number | null) {
    compareIndex.value = i
    if (i === null) frameDiff.value = null
    else void refreshDiff()
  }

  async function refreshDiff() {
    if (!pipeline || !currentFrame.value || compareIndex.value === null) {
      frameDiff.value = null
      return
    }
    const manifest = await pipeline.getManifest()
    const meta = manifest.frames[compareIndex.value]
    if (!meta) {
      logger('warn', `对比目标帧 #${compareIndex.value} 不存在`)
      frameDiff.value = null
      return
    }
    const d = await pipeline.diff(new Date(meta.epochMs), new Date(currentFrame.value.epochMs))
    if (d) {
      frameDiff.value = d
      logger('info', `已对比帧 #${d.indexA} 与帧 #${d.indexB}（回放读取，未重算）`)
    }
  }

  /** 页面加载时尝试复用构建期预生成 / 上次保存的管线；取不到只记录原因 */
  async function initPipeline() {
    try {
      const p = new TimePipeline(
        pipelineConfig.value,
        STARS,
        new BrowserFrameStorage(logger),
        logger,
      )
      const result = await p.build(false)
      pipeline = p
      pipelineReady.value = true
      pipelineFrameCount.value = result.manifest.frameCount
      logger('info', `已加载可复用管线 ${result.manifest.frameCount} 帧（回放无需重算）`)
      await loadFrame(0)
    } catch (e) {
      // 预生成管线缺失属于正常情况（例如 dev 模式未先构建），只说明原因
      logger('info', `暂无可复用管线: ${(e as Error).message}`)
    }
  }

  return {
    viewDate, zoom, panX, panY, showLabels, showConstLines, showGrid,
    selectedStar, searchQuery, latitude,
    localSiderealTime: localSiderealTimeStore, filteredStars,
    projectStar, starRadius, spectralColor, selectStar,
    STARS, CONSTELLATIONS,
    // pipeline
    logs, pipelineConfig, STEP_OPTIONS,
    pipelineReady, pipelineFrameCount, isBuilding, isPlaying,
    currentFrame, frameDiff, compareIndex,
    buildPipeline, initPipeline, loadFrame,
    startPlayback, pausePlayback, stopPlayback, stepFrame,
    setCompareIndex,
  }
})
