/**
 * 构建期管线校验入口（由 verify-pipeline.mjs 用 esbuild 打包后在 Node 中执行）。
 *
 * 流程：
 *   1. 在固定时间区间上按 1 小时步长构建管线，落盘到本地缓存目录；
 *   2. 重新从磁盘加载（回放只读，不重算）；
 *   3. 全量逐帧顺序回放 + 固定时刻检查点，与「直接推进现算」逐星比对；
 *   4. 帧缺失/时刻取不到/位置不一致 -> 输出原因，进程以非零码退出使构建失败。
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { STARS } from '../src/data/stars'
import { deserializeBundle, makeConfig, serializeBundle } from '../src/pipeline/timePipeline'
import { verifyTimePipeline } from '../src/pipeline/verify'
import type { VerifyResult } from '../src/pipeline/verify'
import type { PipelineBundle, PipelineStore } from '../src/pipeline/types'

const LOG = '[time-pipeline]'

/** 构建期使用的文件系统管线存储：与浏览器端 localStorage 存储共用同一序列化格式 */
class FilePipelineStore implements PipelineStore {
  constructor(private dir: string) {
    mkdirSync(dir, { recursive: true })
  }

  private fileOf(key: string): string {
    // 存储键含 ':' 等字符，文件名做安全替换
    return join(this.dir, `${key.replace(/[^a-z0-9._-]/gi, '_')}.json`)
  }

  has(key: string): boolean {
    return existsSync(this.fileOf(key))
  }

  save(key: string, bundle: PipelineBundle): void {
    mkdirSync(this.dir, { recursive: true })
    writeFileSync(this.fileOf(key), serializeBundle(bundle), 'utf8')
  }

  load(key: string): PipelineBundle | null {
    const file = this.fileOf(key)
    if (!existsSync(file)) return null
    return deserializeBundle(readFileSync(file, 'utf8'))
  }
}

function main(): void {
  const cacheDir = process.env.SKY_PIPELINE_CACHE_DIR
  if (!cacheDir) {
    console.error(`${LOG} 失败: 未指定管线缓存目录（SKY_PIPELINE_CACHE_DIR）`)
    process.exitCode = 1
    return
  }

  // 固定时间区间：2024-03-20 00:00 UTC（春分前后）起 24 小时，步长 1 小时，共 25 帧
  const startMs = Date.UTC(2024, 2, 20, 0, 0, 0)
  const endMs = Date.UTC(2024, 2, 21, 0, 0, 0)
  const stepMs = 60 * 60 * 1000
  const latitude = 39.9
  const zoom = 1

  // 固定检查时刻（均为步长整数倍）：00/03/06/12/18 时及区间终点
  const checkpointOffsets = [0, 3, 6, 12, 18, 24]
  const checkpoints = checkpointOffsets.map(h => startMs + h * stepMs)

  const config = makeConfig(startMs, endMs, stepMs, latitude, zoom, STARS)
  const store = new FilePipelineStore(cacheDir)

  console.log(`${LOG} 缓存目录: ${cacheDir}`)
  try {
    const cached = readdirSync(cacheDir).filter(f => f.endsWith('.json'))
    console.log(`${LOG} 缓存目录现有管线文件: ${cached.length ? cached.join(', ') : '(空)'}`)
  } catch (e) {
    console.log(`${LOG} 缓存目录尚不可读，将在构建时创建: ${(e as Error).message}`)
  }
  console.log(
    `${LOG} 区间 ${new Date(startMs).toISOString()} ~ ${new Date(endMs).toISOString()}，` +
    `步长 ${stepMs / 3600000}h，纬度 ${latitude}°，星表 ${STARS.length} 颗`,
  )

  let result: VerifyResult
  try {
    result = verifyTimePipeline({ config, stars: STARS, store, checkpoints, tolerance: 1e-9 })
  } catch (e) {
    console.error(`${LOG} 校验执行异常: ${(e as Error).stack || (e as Error).message}`)
    process.exitCode = 1
    return
  }

  console.log(`${LOG} 存储键: ${result.key}`)
  console.log(`${LOG} 本次${result.reusedExisting ? '检测到旧管线，已重建覆盖' : '为新管线，已构建并落盘'}`)
  console.log(`${LOG} 管线帧数: ${result.frameCount}`)
  console.log(`${LOG} 全量逐帧顺序回放: 校验 ${result.fullReplay.framesChecked} 帧，问题 ${result.fullReplay.problems.length} 处`)
  for (const p of result.fullReplay.problems) console.log(`${LOG}   - ${p}`)

  for (const cp of result.checkpoints) {
    if (cp.status === 'match') {
      console.log(`${LOG} 检查时刻 ${cp.iso}（第 ${cp.frameIndex} 帧）: 一致（最大误差 ${cp.maxAbsError.toExponential(2)}）`)
    } else if (cp.status === 'missing') {
      console.error(`${LOG} 检查时刻 ${cp.iso}: 取不到帧，原因: ${cp.reason}`)
    } else {
      console.error(`${LOG} 检查时刻 ${cp.iso}（第 ${cp.frameIndex} 帧）: 不一致，最大误差 ${cp.maxAbsError.toExponential(3)}`)
      for (const m of cp.mismatches.slice(0, 10)) {
        console.error(
          `${LOG}   星体[${m.index}] ${m.name} 字段 ${m.field}: 回放=${String(m.replayed)} 直接推进=${String(m.direct)} 误差=${m.error.toExponential(3)}`,
        )
      }
    }
  }

  if (!result.ok) {
    console.error(`${LOG} 校验失败，共 ${result.errors.length} 个问题（构建中止）:`)
    for (const err of result.errors) console.error(`${LOG}   ✗ ${err}`)
    process.exitCode = 1
    return
  }

  console.log(`${LOG} 校验通过: 帧序完整无缺失，全部检查时刻的逐帧回放结果与直接推进一致`)
}

main()
