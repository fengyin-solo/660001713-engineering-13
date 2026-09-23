/* eslint-disable no-console */
/**
 * 构建期时间管线校验：
 * 1. 按固定参数（DEFAULT_CONFIG）逐帧构建管线，帧逐帧落盘到 public/time-pipeline/
 * 2. 全量逐帧回放：校验帧序连续无缺失、时刻等步长
 * 3. 在几个固定时刻分别走"回放读取"与"直接推进现算"两条路径，逐星比对位置，
 *    任一不一致就让构建失败，并明确指出是哪个时刻、哪颗星
 * 4. 管线数据缺失 / 时刻取不到时必须在日志说明原因、抛出失败，不允许静默跳过
 */
import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { STARS } from '../src/data/stars'
import { DEFAULT_CONFIG } from '../src/pipeline/types'
import { computeFrame, frameTimes } from '../src/pipeline/astronomy'
import { TimePipeline, MissingFrameError } from '../src/pipeline/pipeline'
import { NodeFileStorage } from './nodeStorage'

const failures: string[] = []
function fail(msg: string): never {
  console.error(`\n✗ 时间管线校验失败: ${msg}`)
  process.exit(1)
}
function check(cond: boolean, msg: string) {
  if (cond) {
    console.log(`  ✓ ${msg}`)
  } else {
    failures.push(msg)
    console.error(`  ✗ ${msg}`)
  }
}
const logger = (level: 'info' | 'warn' | 'error', msg: string) =>
  console[level === 'info' ? 'log' : level](`[verify:${level}] ${msg}`)

// 参与比对的固定时刻（均落在步长网格上），以及它们应处的帧序号
const ANCHORS: { time: string; expectIndex: number }[] = [
  { time: '2024-01-01T00:00:00.000Z', expectIndex: 0 },
  { time: '2024-01-01T12:00:00.000Z', expectIndex: 2 },
  { time: '2024-01-02T00:00:00.000Z', expectIndex: 4 },
  { time: '2024-01-03T00:00:00.000Z', expectIndex: 8 },
]
const EPS = 1e-9

const __dirname = path.dirname(fileURLToPath(import.meta.url))
// 打包产物位于 node_modules/.cache/，统一以包根（frontend/）为基准
const projectRoot = __dirname.endsWith(path.join('node_modules', '.cache'))
  ? path.resolve(__dirname, '..', '..')
  : path.resolve(__dirname, '..')

function approxEqual(a: number | null, b: number | null) {
  if (a === null || b === null) return a === b
  return Math.abs(a - b) <= EPS
}

async function main() {
  const outDir = path.join(projectRoot, 'public/time-pipeline')
  console.log(`时间管线构建校验开始 -> ${outDir}`)

  // ---------- 1. 构建管线（时间推进 -> 投影 -> 逐帧落盘） ----------
  // 默认强制重建；设置 SKIP_REBUILD=1 时复用已落盘帧（用于验证"不一致即失败"本身）
  const skipRebuild = process.env.SKIP_REBUILD === '1'
  const pipeline = new TimePipeline(DEFAULT_CONFIG, STARS, new NodeFileStorage(outDir), logger)
  const { manifest, rebuilt } = await pipeline.build(!skipRebuild)
  console.log(`  ✓ 管线就绪: rebuilt=${rebuilt}, 帧数=${manifest.frameCount}`)

  const expectedTimes = frameTimes(DEFAULT_CONFIG)
  check(
    manifest.frameCount === expectedTimes.length,
    `清单帧数 ${manifest.frameCount} == 按步长推导出的 ${expectedTimes.length}`,
  )

  // ---------- 2. 全量逐帧回放：帧序连续、无缺失、时刻等步长 ----------
  console.log('\n[1/3] 全量逐帧回放，检查帧序完整性')
  const replayed = await pipeline.replayAll((f) =>
    logger('info', `回放帧 #${f.index} ${f.time}（${f.stars.length} 颗星）`),
  )
  check(replayed.length === expectedTimes.length, `回放帧数 ${replayed.length} 无缺失`)
  for (let i = 0; i < replayed.length; i++) {
    const f = replayed[i]
    check(f.index === i, `帧序: 第 ${i} 次回放读到的是帧 #${f.index}`)
    check(f.time === expectedTimes[i].toISOString(), `帧 #${i} 时刻 ${f.time} 与步长网格一致`)
    check(f.stars.length === STARS.length, `帧 #${i} 包含全部 ${STARS.length} 颗星`)
  }

  // ---------- 3. 固定时刻：逐帧回放 vs 直接推进 ----------
  console.log('\n[2/3] 固定时刻回放结果与直接推进现算逐星比对')
  for (const anchor of ANCHORS) {
    const date = new Date(anchor.time)
    const replayedFrame = await pipeline.readAt(date)
    check(replayedFrame !== null, `时刻 ${anchor.time} 可从管线回放到帧`)
    if (!replayedFrame) continue
    check(
      replayedFrame.index === anchor.expectIndex,
      `${anchor.time} 回放到帧 #${replayedFrame.index}（期望 #${anchor.expectIndex}）`,
    )

    // 直接推进：同一时刻现算（回放与现算共用 computeFrame，这里仍按两条独立路径生成对象）
    const directFrame = computeFrame(anchor.expectIndex, date, DEFAULT_CONFIG, STARS)
    let mismatch = ''
    for (let s = 0; s < STARS.length; s++) {
      const a = replayedFrame.stars[s]
      const b = directFrame.stars[s]
      if (a.name !== b.name) {
        mismatch = `${anchor.time} 帧 #${anchor.expectIndex} 第 ${s} 颗星名称不符: 回放=${a.name} 现算=${b.name}`
        break
      }
      if (a.visible !== b.visible || !approxEqual(a.x, b.x) || !approxEqual(a.y, b.y)
        || Math.abs(a.alt - b.alt) > EPS || Math.abs(a.az - b.az) > EPS
        || Math.abs(a.lst - b.lst) > EPS) {
        mismatch =
          `${anchor.time} 帧 #${anchor.expectIndex} 星体「${a.name}」位置不一致: ` +
          `回放(visible=${a.visible}, x=${a.x}, y=${a.y}, alt=${a.alt}, az=${a.az}) ` +
          `现算(visible=${b.visible}, x=${b.x}, y=${b.y}, alt=${b.alt}, az=${b.az})`
        break
      }
    }
    if (mismatch) fail(mismatch)
    console.log(`  ✓ ${anchor.time}: 回放帧 #${replayedFrame.index} 与直接推进逐星一致`)
  }

  // ---------- 4. 数据缺失 / 时刻取不到：必须报错说明原因，不许静默跳过 ----------
  console.log('\n[3/3] 缺失数据与非法时刻的处理')
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'sky-pipeline-verify-'))
  try {
    const tmpStorage = new NodeFileStorage(tmp)
    const p2 = new TimePipeline(DEFAULT_CONFIG, STARS, tmpStorage, logger)
    await p2.build()

    // 删掉一帧，回放必须因该时刻失败而不是跳过
    const victim = 3
    const victimTime = expectedTimes[victim].toISOString()
    rmSync(path.join(tmp, `frame-${victim}.json`))
    let threw = false
    try {
      await p2.replayAll()
    } catch (e) {
      threw = e instanceof MissingFrameError && e.index === victim && e.time === victimTime
      console.log(`  ✓ 删除帧 #${victim}（${victimTime}）后回放中断并指出该时刻: ${(e as Error).message}`)
    }
    check(threw, `帧 #${victim} 缺失时回放失败且原因指向 ${victimTime}`)

    // 清单缺失：build 前取不到数据必须说明原因
    rmSync(tmp, { recursive: true, force: true })
    const p3 = new TimePipeline(DEFAULT_CONFIG, STARS, new NodeFileStorage(tmp), logger)
    let manifestThrew = false
    try {
      await p3.getManifest()
    } catch (e) {
      manifestThrew = /缺失/.test((e as Error).message)
      console.log(`  ✓ 清单缺失时给出原因: ${(e as Error).message}`)
    }
    check(manifestThrew, '管线清单缺失时报错说明原因，未静默跳过')

    // 非网格时刻取不到：返回 null 并记录原因（重建一次供该检查）
    await p3.build()
    const offGrid = await p3.readAt(new Date('2024-01-01T01:00:00.000Z'))
    check(offGrid === null, '非步长网格时刻取不到帧时返回 null 并输出警告原因')
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }

  if (failures.length > 0) {
    fail(`共 ${failures.length} 项检查未通过:\n - ${failures.join('\n - ')}`)
  }
  console.log('\n✅ 时间管线校验全部通过：回放与直接推进逐帧一致、帧序完整、缺失处理符合预期')
}

main().catch((e) => {
  console.error(e)
  fail((e as Error).message)
})
