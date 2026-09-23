import { deserializeBundle, serializeBundle } from './timePipeline'
import type { PipelineBundle, PipelineStore } from './types'

/**
 * 浏览器端管线存储：localStorage 持久化，回放时直接读取已保存的帧。
 * 任何读取/写入异常都向上抛出并带原因，不静默吞掉。
 */
export class LocalStoragePipelineStore implements PipelineStore {
  constructor(private storage: Storage = localStorage) {}

  has(key: string): boolean {
    return this.storage.getItem(key) !== null
  }

  save(key: string, bundle: PipelineBundle): void {
    try {
      this.storage.setItem(key, serializeBundle(bundle))
    } catch (e) {
      // QuotaExceededError 等：必须让调用方知道管线没存上
      throw new Error(`管线落盘失败（localStorage 写入异常）: ${(e as Error).message}`)
    }
  }

  load(key: string): PipelineBundle | null {
    const text = this.storage.getItem(key)
    if (text === null) return null
    return deserializeBundle(text)
  }
}

/** 测试 / 非持久场景用的内存存储 */
export class InMemoryPipelineStore implements PipelineStore {
  private map = new Map<string, PipelineBundle>()

  has(key: string): boolean {
    return this.map.has(key)
  }

  save(key: string, bundle: PipelineBundle): void {
    // 存一份序列化/反序列化后的克隆，模拟真实落盘往返
    this.map.set(key, deserializeBundle(serializeBundle(bundle)))
  }

  load(key: string): PipelineBundle | null {
    const bundle = this.map.get(key)
    return bundle ? structuredClone(bundle) : null
  }
}
