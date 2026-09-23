import type { Star, Constellation } from '../types'
import catalog from './stars.json'

// 星表数据以 JSON 保存，供运行时与构建期管线校验脚本（Node/esbuild）共用
export const STARS: Star[] = catalog.stars as Star[]
export const CONSTELLATIONS: Constellation[] = catalog.constellations as Constellation[]
