// Node 端帧存储：仅在构建/校验脚本中使用，不进入浏览器 bundle
import { promises as fs, existsSync } from 'node:fs'
import path from 'node:path'
import type { FrameStorage } from '../src/pipeline/storage'
import type { PipelineManifest, SkyFrame, StoredFrame } from '../src/pipeline/types'

export class NodeFileStorage implements FrameStorage {
  readonly id = 'node-file'

  constructor(private readonly dir: string) {}

  private manifestPath() {
    return path.join(this.dir, 'manifest.json')
  }

  private framePath(index: number) {
    return path.join(this.dir, `frame-${index}.json`)
  }

  async loadManifest(): Promise<PipelineManifest | null> {
    const p = this.manifestPath()
    if (!existsSync(p)) return null
    return JSON.parse(await fs.readFile(p, 'utf8')) as PipelineManifest
  }

  async readFrame(index: number): Promise<SkyFrame | null> {
    const p = this.framePath(index)
    if (!existsSync(p)) return null
    const stored = JSON.parse(await fs.readFile(p, 'utf8')) as StoredFrame
    return stored.frame
  }

  async writeManifest(manifest: PipelineManifest): Promise<void> {
    await fs.writeFile(this.manifestPath(), JSON.stringify(manifest, null, 2), 'utf8')
  }

  async writeFrame(frame: SkyFrame, signature: string): Promise<void> {
    const stored: StoredFrame = { signature, frame }
    await fs.writeFile(this.framePath(frame.index), JSON.stringify(stored), 'utf8')
  }

  async reset(): Promise<void> {
    await fs.rm(this.dir, { recursive: true, force: true })
    await fs.mkdir(this.dir, { recursive: true })
  }
}
