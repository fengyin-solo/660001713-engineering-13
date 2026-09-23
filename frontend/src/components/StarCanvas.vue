<template>
  <canvas ref="canvasRef" class="w-full h-full bg-black cursor-crosshair"
    @click="onClick" @wheel.prevent="onWheel" />
</template>

<script setup lang="ts">
import { ref, onMounted, onUnmounted } from 'vue'
import { useSkyStore } from '../store/sky'
import { normalizedToScreen } from '../pipeline/astronomy'

const store = useSkyStore()
const canvasRef = ref<HTMLCanvasElement | null>(null)
let animId = 0

/** 回放每帧停留 450ms（固定节奏推进，位置全部读取自已保存的管线帧） */
const FRAME_INTERVAL_MS = 450
let lastStepAt = 0

function framePos(index: number, cx: number, cy: number, scale: number): [number, number] {
  const frame = store.currentFrame
  if (frame) return store.frameStarScreen(index, cx, cy, scale)
  const star = store.STARS[index]
  return store.projectStar(star.ra, star.dec, cx, cy, scale)
}

function draw(now: number) {
  animId = requestAnimationFrame(draw)

  // 回放节拍：到点顺序读取下一帧（不重算）
  if (store.playing) {
    if (!lastStepAt) lastStepAt = now
    if (now - lastStepAt >= FRAME_INTERVAL_MS) {
      lastStepAt = now
      store.stepReplay(1)
    }
  } else {
    lastStepAt = 0
  }

  const canvas = canvasRef.value
  if (!canvas) return
  const ctx = canvas.getContext('2d')!
  const w = canvas.width = canvas.offsetWidth * 2
  const h = canvas.height = canvas.offsetHeight * 2
  const cx = w / 2, cy = h / 2
  const scale = Math.min(w, h) * store.zoom
  const frame = store.currentFrame
  const baseline = store.baselineFrame

  // background
  ctx.fillStyle = '#000814'
  ctx.fillRect(0, 0, w, h)

  // random background stars
  const rng = (seed: number) => { let s = seed; return () => { s = (s * 16807) % 2147483647; return s / 2147483647 } }
  const r = rng(42)
  for (let i = 0; i < 300; i++) {
    ctx.fillStyle = `rgba(255,255,255,${r() * 0.4})`
    ctx.beginPath()
    ctx.arc(r() * w, r() * h, r() * 1.5, 0, Math.PI * 2)
    ctx.fill()
  }

  // grid（回放态网格也使用当前帧时刻重投 —— 网格不落盘；星体位置才是管线复用对象）
  if (store.showGrid) {
    ctx.strokeStyle = 'rgba(100,100,200,0.15)'
    ctx.lineWidth = 1
    for (let dec = -60; dec <= 60; dec += 30) {
      ctx.beginPath()
      for (let ra = 0; ra <= 24; ra += 0.5) {
        const [x, y] = store.projectStar(ra, dec, cx, cy, scale)
        if (x < -500) continue
        ra === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)
      }
      ctx.stroke()
    }
    for (let ra = 0; ra < 24; ra += 2) {
      ctx.beginPath()
      for (let dec = -90; dec <= 90; dec += 5) {
        const [x, y] = store.projectStar(ra, dec, cx, cy, scale)
        if (x < -500) continue
        dec === -90 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)
      }
      ctx.stroke()
    }
  }

  // constellation lines
  if (store.showConstLines) {
    ctx.strokeStyle = 'rgba(100,180,255,0.4)'
    ctx.lineWidth = 1.5
    for (const c of store.CONSTELLATIONS) {
      for (const [i, j] of c.lines) {
        const [x1, y1] = framePos(i, cx, cy, scale)
        const [x2, y2] = framePos(j, cx, cy, scale)
        if (x1 < -500 || x2 < -500) continue
        ctx.beginPath()
        ctx.moveTo(x1, y1)
        ctx.lineTo(x2, y2)
        ctx.stroke()
      }
    }
  }

  // stars —— 回放态位置来自管线帧（读取），自由态按当前时刻现算
  for (let i = 0; i < store.STARS.length; i++) {
    const star = store.STARS[i]
    const [x, y] = framePos(i, cx, cy, scale)
    if (x < -500 || x > w + 500 || y < -500 || y > h + 500) continue
    const radius = store.starRadius(star.mag)
    const color = store.spectralColor(star.spectral)

    // glow
    const gradient = ctx.createRadialGradient(x, y, 0, x, y, radius * 3)
    gradient.addColorStop(0, color)
    gradient.addColorStop(1, 'transparent')
    ctx.fillStyle = gradient
    ctx.beginPath()
    ctx.arc(x, y, radius * 3, 0, Math.PI * 2)
    ctx.fill()

    // core
    ctx.fillStyle = color
    ctx.beginPath()
    ctx.arc(x, y, radius, 0, Math.PI * 2)
    ctx.fill()

    // label
    if (store.showLabels && star.mag < 2.5) {
      ctx.fillStyle = 'rgba(200,200,255,0.7)'
      ctx.font = `${10 * store.zoom}px system-ui`
      ctx.fillText(star.name, x + radius + 4, y + 4)
    }
  }

  // 两时刻差异：从基准帧位置指向当前帧位置的位移向量
  if (frame && baseline && store.currentDiff) {
    const deltaByIdx = new Map(store.currentDiff.deltas.map(d => [d.index, d]))
    for (let i = 0; i < store.STARS.length; i++) {
      const delta = deltaByIdx.get(i)
      const curFs = frame.stars[i]
      const baseFs = baseline.stars[i]
      if (!delta || !delta.bothVisible || !curFs.visible || !baseFs.visible) continue
      const [x1, y1] = normalizedToScreen(baseFs, cx, cy, scale, store.panX, store.panY)
      const [x2, y2] = normalizedToScreen(curFs, cx, cy, scale, store.panX, store.panY)
      if (x1 < -500 || x2 < -500) continue
      const intensity = Math.min(1, delta.angularDeg / 15)
      ctx.strokeStyle = `rgba(255,${Math.round(120 - 120 * intensity)},60,0.85)`
      ctx.lineWidth = 2
      ctx.beginPath()
      ctx.moveTo(x1, y1)
      ctx.lineTo(x2, y2)
      ctx.stroke()
      // 箭头头部
      const ang = Math.atan2(y2 - y1, x2 - x1)
      const ah = 6
      ctx.beginPath()
      ctx.moveTo(x2, y2)
      ctx.lineTo(x2 - ah * Math.cos(ang - 0.4), y2 - ah * Math.sin(ang - 0.4))
      ctx.lineTo(x2 - ah * Math.cos(ang + 0.4), y2 - ah * Math.sin(ang + 0.4))
      ctx.closePath()
      ctx.fillStyle = `rgba(255,${Math.round(120 - 120 * intensity)},60,0.85)`
      ctx.fill()
    }
  }

  // horizon
  ctx.strokeStyle = 'rgba(0,200,100,0.3)'
  ctx.lineWidth = 2
  ctx.beginPath()
  for (let az = 0; az <= 360; az += 5) {
    const azRad = az * Math.PI / 180
    const r = (Math.PI / 2) * scale * 0.45
    const x = cx + store.panX + r * Math.sin(azRad)
    const y = cy + store.panY - r * Math.cos(azRad)
    az === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)
  }
  ctx.closePath()
  ctx.stroke()

  // constellation labels
  if (store.showLabels) {
    ctx.fillStyle = 'rgba(100,180,255,0.8)'
    ctx.font = `bold ${12 * store.zoom}px system-ui`
    for (const c of store.CONSTELLATIONS) {
      const [x, y] = framePos(c.stars[0], cx, cy, scale)
      if (x < -500) continue
      ctx.fillText(c.nameCn, x - 20, y - 15 * store.zoom)
    }
  }

  // 回放状态角标
  if (frame) {
    ctx.fillStyle = 'rgba(147,197,253,0.9)'
    ctx.font = '13px system-ui'
    ctx.fillText(
      `管线回放 帧 ${store.currentFrameIndex + 1}/${store.pipeline?.frames.length ?? 0}` +
      `${store.playing ? ' ▶' : ' ⏸'}`,
      16, 24,
    )
  }
}

function onClick(e: MouseEvent) {
  const canvas = canvasRef.value!
  const rect = canvas.getBoundingClientRect()
  const x = (e.clientX - rect.left) * 2
  const y = (e.clientY - rect.top) * 2
  const cx = canvas.width / 2, cy = canvas.height / 2
  const scale = Math.min(canvas.width, canvas.height) * store.zoom
  store.selectStar(x, y, cx, cy, scale)
}

function onWheel(e: WheelEvent) {
  store.zoom = Math.max(0.3, Math.min(3, store.zoom + (e.deltaY > 0 ? -0.1 : 0.1)))
}

onMounted(() => { animId = requestAnimationFrame(draw) })
onUnmounted(() => cancelAnimationFrame(animId))
</script>
