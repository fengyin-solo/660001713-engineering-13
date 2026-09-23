// 用 esbuild JS API 打包并执行管线校验脚本。
// 不直接调用 .bin/esbuild，避免拷贝 node_modules 跨平台时原生二进制不匹配。
import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const outfile = path.join(root, 'node_modules/.cache/verify-pipeline.mjs')

await build({
  entryPoints: [path.join(root, 'scripts/verify-pipeline.ts')],
  bundle: true,
  platform: 'node',
  format: 'esm',
  outfile,
  logLevel: 'info',
})

await import(outfile)
