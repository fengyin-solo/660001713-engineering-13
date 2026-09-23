#!/usr/bin/env node
/**
 * 时间管线构建校验脚本（npm run verify:pipeline）。
 *
 * 用 esbuild 把 TypeScript 校验入口（含星表 JSON 与管线模块）打包为临时 ESM，
 * 在 Node 中执行；脚本退出码非零时让 npm build 失败。
 *
 * 用法: node scripts/verify-pipeline.mjs [缓存目录]
 */
import { build } from 'esbuild'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = resolve(fileURLToPath(new URL('.', import.meta.url)))
const cacheDir = process.argv[2]
  ? resolve(process.argv[2])
  : resolve(here, '..', '.pipeline-cache')

const tempDir = mkdtempSync(join(tmpdir(), 'sky-pipeline-verify-'))
const outfile = join(tempDir, 'verify-entry.mjs')

try {
  await build({
    entryPoints: [resolve(here, 'verify-entry.ts')],
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node20',
    outfile,
    logLevel: 'warning',
  })

  process.env.SKY_PIPELINE_CACHE_DIR = cacheDir
  await import(`file://${outfile}`)
} catch (e) {
  console.error(`[time-pipeline] 校验脚本打包失败: ${e.message}`)
  process.exitCode = 1
} finally {
  rmSync(tempDir, { recursive: true, force: true })
}
