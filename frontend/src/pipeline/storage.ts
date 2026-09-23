import type {
  PipelineConfig,
  PipelineLogger,
  PipelineManifest,
  SkyFrame,
  StoredFrame,
} from './types'
import { PIPELINE_VERSION, starSignature } from './types'
import type { Star } from '../types'

/**
 * 帧存储抽象：管线构建（写入）与回放（读取）只依赖此接口。
 * - 构建期（Node）：文件存储，帧逐帧落盘到 public/time-pipeline/
 * - 运行时（浏览器）：localStorage 缓存；缺失时回退到构建期预生成的 JSON
 */
export interface FrameStorage {
  readonly id: string
  loadManifest(): Promise<PipelineManifest | null>
  readFrame(index: number): Promise<SkyFrame | null>
  writeManifest(manifest: PipelineManifest): Promise<void> | void
  writeFrame(frame: SkyFrame, signature: string): Promise<void> | void
  /** 标记一次全新构建开始（清空旧内容），失败要抛出而不是静默跳过 */
  reset(): Promise<void> | void
}

const MANIFEST_KEY = 'sky-pipeline-manifest'
const frameKey = (i: number) => `sky-pipeline-frame-${i}`

export const consoleLogger: PipelineLogger = (level, msg) => {
  const line = `[time-pipeline] ${msg}`
  if (level === 'error') console.error(line)
  else if (level === 'warn') console.warn(line)
  else // eslint-disable-next-line no-console
    console.log(line)
}

/** 校验清单是否与当前配置、星表一致；不一致一律视为"取不到" */
export function manifestMatches(
  manifest: PipelineManifest | null,
  config: PipelineConfig,
  stars: Star[],
  logger: PipelineLogger = consoleLogger,
): manifest is PipelineManifest {
  if (!manifest) {
    logger('warn', '管线清单缺失，本地没有可回放的已保存帧')
    return false
  }
  if (manifest.version !== PIPELINE_VERSION) {
    logger('warn', `管线版本不匹配（落盘 v${manifest.version} / 当前 v${PIPELINE_VERSION}），旧帧不可用`)
    return false
  }
  const sig = starSignature(stars)
  if (manifest.starSignature !== sig) {
    logger('warn', `星表签名不一致（落盘 ${manifest.starSignature} / 当前 ${sig}），旧帧已失效`)
    return false
  }
  const c = manifest.config
  if (
    c.startTime !== config.startTime ||
    c.endTime !== config.endTime ||
    c.stepMs !== config.stepMs ||
    c.latitude !== config.latitude ||
    c.width !== config.width ||
    c.height !== config.height ||
    c.zoom !== config.zoom ||
    c.panX !== config.panX ||
    c.panY !== config.panY
  ) {
    logger('warn', '管线参数（时间范围/步长/纬度/视口）与当前配置不一致，已保存帧不可复用')
    return false
  }
  return true
}

/** 浏览器运行时存储：优先 localStorage，缺失帧回退到构建期预生成的静态 JSON */
export class BrowserFrameStorage implements FrameStorage {
  readonly id = 'browser-localStorage+prebuilt'
  private base: string

  constructor(private readonly logger: PipelineLogger = consoleLogger) {
    this.base = `${import.meta.env.BASE_URL}time-pipeline/`
  }

  async loadManifest(): Promise<PipelineManifest | null> {
    try {
      const raw = localStorage.getItem(MANIFEST_KEY)
      if (raw) return JSON.parse(raw) as PipelineManifest
    } catch (e) {
      this.logger('warn', `读取本地清单失败: ${(e as Error).message}`)
    }
    try {
      const resp = await fetch(`${this.base}manifest.json`)
      if (!resp.ok) {
        this.logger('info', `没有构建期预生成管线（HTTP ${resp.status}），需要时将在浏览器本地构建`)
        return null
      }
      return (await resp.json()) as PipelineManifest
    } catch (e) {
      this.logger('warn', `读取预生成清单异常: ${(e as Error).message}`)
      return null
    }
  }

  async readFrame(index: number): Promise<SkyFrame | null> {
    try {
      const raw = localStorage.getItem(frameKey(index))
      if (raw) {
        const stored = JSON.parse(raw) as StoredFrame
        return stored.frame
      }
    } catch (e) {
      this.logger('warn', `读取本地帧 #${index} 失败: ${(e as Error).message}`)
    }
    try {
      const resp = await fetch(`${this.base}frame-${index}.json`)
      if (!resp.ok) {
        this.logger('warn', `帧 #${index} 取不到: 本地未缓存且预生成文件返回 HTTP ${resp.status}`)
        return null
      }
      const stored = (await resp.json()) as StoredFrame
      return stored.frame
    } catch (e) {
      this.logger('warn', `读取帧 #${index} 异常: ${(e as Error).message}`)
      return null
    }
  }

  writeManifest(manifest: PipelineManifest): void {
    localStorage.setItem(MANIFEST_KEY, JSON.stringify(manifest))
  }

  writeFrame(frame: SkyFrame, signature: string): void {
    const stored: StoredFrame = { signature, frame }
    localStorage.setItem(frameKey(frame.index), JSON.stringify(stored))
  }

  reset(): void {
    const raw = localStorage.getItem(MANIFEST_KEY)
    if (raw) {
      try {
        const manifest = JSON.parse(raw) as PipelineManifest
        for (const f of manifest.frames) localStorage.removeItem(frameKey(f.index))
      } catch {
        /* 清单损坏时直接移除即可 */
      }
    }
    localStorage.removeItem(MANIFEST_KEY)
  }
}
