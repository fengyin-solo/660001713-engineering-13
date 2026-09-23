import type { Star } from '../types'
import type {
  FrameDiff,
  PipelineConfig,
  PipelineLogger,
  PipelineManifest,
  SkyFrame,
  StarDiff,
} from './types'
import { PIPELINE_VERSION, starSignature } from './types'
import { computeFrame, frameTimes } from './astronomy'
import { consoleLogger, type FrameStorage, manifestMatches } from './storage'

/** 回放因帧缺失中断时抛出，调用方据此记录原因而不是静默跳过 */
export class MissingFrameError extends Error {
  constructor(public readonly index: number, public readonly time: string) {
    super(`管线帧 #${index}（${time}）缺失或损坏，回放中断`)
    this.name = 'MissingFrameError'
  }
}

export interface BuildResult {
  manifest: PipelineManifest
  rebuilt: boolean
  reason?: string
}

/**
 * 可回放的时间管线。
 *
 * 构建：按 stepMs 逐帧做"时间推进 + 投影"，每一帧的星体位置本地保存，
 *      最后再写清单（清单存在即代表整段管线完整）。
 * 回放：只从存储读取已保存帧，绝不重新计算星体位置。
 * 直接推进：用同一个 computeFrame 在任意时刻现算一帧，供与回放结果逐星对比。
 */
export class TimePipeline {
  readonly signature: string
  private manifest: PipelineManifest | null = null

  constructor(
    public readonly config: PipelineConfig,
    private readonly stars: Star[],
    private readonly storage: FrameStorage,
    private readonly logger: PipelineLogger = consoleLogger,
  ) {
    this.signature = starSignature(stars)
  }

  /**
   * 准备管线：已有且可用的已保存管线直接复用（不重算）；
   * 否则按固定步长逐帧构建并本地保存。
   */
  async build(force = false): Promise<BuildResult> {
    const existing = await this.storage.loadManifest()
    if (!force && manifestMatches(existing, this.config, this.stars, this.logger)) {
      this.manifest = existing
      return { manifest: existing, rebuilt: false }
    }

    let reason: string | undefined
    if (!existing) reason = '本地不存在管线清单，全新构建'
    else if (force) reason = '强制重建'
    this.logger('info', `开始构建时间管线（${reason ?? '已保存管线失效'}）：存储=${this.storage.id}`)

    await this.storage.reset()
    const times = frameTimes(this.config)
    if (times.length === 0) {
      throw new Error('时间范围内没有任何帧，请检查 startTime/endTime/stepMs')
    }

    const frames: PipelineManifest['frames'] = []
    for (let index = 0; index < times.length; index++) {
      const frame = computeFrame(index, times[index], this.config, this.stars)
      // 先逐帧落盘，保证每一帧都可被回放单独读取
      await this.storage.writeFrame(frame, this.signature)
      frames.push({ index, time: frame.time, epochMs: frame.epochMs })
      this.logger('info', `已保存帧 #${index} ${frame.time}（${frame.stars.length} 颗星）`)
    }

    const manifest: PipelineManifest = {
      version: PIPELINE_VERSION,
      createdAt: new Date().toISOString(),
      config: { ...this.config },
      starSignature: this.signature,
      frameCount: frames.length,
      frames,
    }
    // 清单最后写：清单在 = 管线完整
    await this.storage.writeManifest(manifest)
    this.manifest = manifest
    this.logger('info', `时间管线构建完成，共 ${frames.length} 帧（步长 ${this.config.stepMs}ms）`)
    return { manifest, rebuilt: true, reason }
  }

  async getManifest(): Promise<PipelineManifest> {
    if (this.manifest) return this.manifest
    const loaded = await this.storage.loadManifest()
    if (!manifestMatches(loaded, this.config, this.stars, this.logger)) {
      throw new Error('管线数据缺失或与当前配置/星表不匹配，请先构建管线')
    }
    this.manifest = loaded
    return loaded
  }

  /**
   * 回放读取一帧：只读已保存结果，不做任何天文重算。
   * 帧缺失/损坏/签名不符时抛 MissingFrameError，由调用方在日志中说明原因。
   */
  async readFrame(index: number): Promise<SkyFrame> {
    const manifest = await this.getManifest()
    const meta = manifest.frames.find((f) => f.index === index)
    if (!meta) {
      this.logger('error', `帧 #${index} 不在管线帧序内（共 ${manifest.frameCount} 帧，#0..#${manifest.frameCount - 1}）`)
      throw new MissingFrameError(index, '(帧序号越界)')
    }
    const frame = await this.storage.readFrame(index)
    if (!frame || frame.index !== index || frame.time !== meta.time || !Array.isArray(frame.stars)) {
      this.logger('error', `帧 #${index}（${meta.time}）数据缺失或损坏，无法回放`)
      throw new MissingFrameError(index, meta.time)
    }
    if (frame.stars.length !== this.stars.length) {
      this.logger(
        'error',
        `帧 #${index}（${meta.time}）星数 ${frame.stars.length} 与星表 ${this.stars.length} 不一致，疑似数据损坏`,
      )
      throw new MissingFrameError(index, meta.time)
    }
    return frame
  }

  /**
   * 逐帧回放整段管线：严格按帧序 #0..#n-1 读取已保存帧。
   * 任一帧缺失即中断并说明是哪个时刻，不静默跳过。
   */
  async replayAll(onFrame?: (frame: SkyFrame) => void): Promise<SkyFrame[]> {
    const manifest = await this.getManifest()
    const out: SkyFrame[] = []
    for (let i = 0; i < manifest.frameCount; i++) {
      const frame = await this.readFrame(i)
      onFrame?.(frame)
      out.push(frame)
    }
    return out
  }

  /**
   * 按时刻取已保存帧（回放语义，不重算）。
   * 时刻必须正好落在步长网格上，否则在日志说明原因并返回 null。
   */
  async readAt(time: Date): Promise<SkyFrame | null> {
    const manifest = await this.getManifest()
    const start = new Date(this.config.startTime).getTime()
    const t = time.getTime()
    if (Number.isNaN(t)) {
      this.logger('warn', `readAt 收到无效时刻，无法取帧`)
      return null
    }
    const offset = t - start
    const index = Math.round(offset / this.config.stepMs)
    const onGrid = Math.abs(offset - index * this.config.stepMs) <= 1
    if (!onGrid) {
      this.logger(
        'warn',
        `时刻 ${time.toISOString()} 不在步长网格上（起点 ${this.config.startTime}，步长 ${this.config.stepMs}ms），回放取不到该帧`,
      )
      return null
    }
    if (index < 0 || index >= manifest.frameCount) {
      this.logger(
        'warn',
        `时刻 ${time.toISOString()} 超出管线范围（帧 #0..#${manifest.frameCount - 1}），取不到帧`,
      )
      return null
    }
    return this.readFrame(index)
  }

  /**
   * 直接推进：在任意时刻现算一帧（不走存储）。
   * 与 readFrame/readAt 的回放路径共用同一个 computeFrame，
   * 构建校验正是比较这两条路径在同一时刻的输出。
   */
  computeAt(time: Date, indexOverride?: number): SkyFrame {
    return computeFrame(indexOverride ?? -1, time, this.config, this.stars)
  }

  /** 对比两个已保存时刻（均为回放读取，不重算） */
  async diff(timeA: Date, timeB: Date): Promise<FrameDiff | null> {
    const [a, b] = await Promise.all([this.readAt(timeA), this.readAt(timeB)])
    if (!a || !b) {
      this.logger('warn', `对比失败：${timeA.toISOString()} 或 ${timeB.toISOString()} 取不到已保存帧`)
      return null
    }
    const byNameB = new Map(b.stars.map((s) => [s.name, s]))
    const stars: StarDiff[] = []
    for (const sa of a.stars) {
      const sb = byNameB.get(sa.name)
      if (!sb) {
        this.logger('warn', `对比时帧 #${b.index} 缺少星体 ${sa.name}，跳过该星并记录`)
        continue
      }
      const wrap = (d: number) => ((d + Math.PI) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI) - Math.PI
      stars.push({
        name: sa.name,
        visibleBefore: sa.visible,
        visibleAfter: sb.visible,
        altDeltaDeg: ((sb.alt - sa.alt) * 180) / Math.PI,
        azDeltaDeg: (wrap(sb.az - sa.az) * 180) / Math.PI,
        pixelDist: sa.x !== null && sa.y !== null && sb.x !== null && sb.y !== null
          ? Math.hypot(sb.x - sa.x, sb.y - sa.y)
          : null,
      })
    }
    return {
      indexA: a.index,
      indexB: b.index,
      timeA: a.time,
      timeB: b.time,
      stars,
    }
  }
}
