<template>
  <canvas ref="canvasRef" class="w-full h-full bg-black cursor-crosshair"
    @click="onClick" @wheel.prevent="onWheel" />
</template>

<script setup lang="ts">
import { ref, onMounted, onUnmounted } from 'vue'
import { useSkyStore } from '../store/sky'
import type { SkyFrame } from '../pipeline/types'

const store = useSkyStore()
const canvasRef = ref<HTMLCanvasElement | null>(null)
let animId = 0

interface Placement { visible: boolean; x: number; y: number; scale: number }

/** 回放帧用固定管线视口（1200x800）保存，绘制时线性适配当前画布 */
function framePlacement(frame: SkyFrame, w: number, h: number) {
  const fit = Math.min(w / store.pipelineConfig.width, h / store.pipelineConfig.height)
  const ox = (w - store.pipelineConfig.width * fit) / 2
  const oy = (h - store.pipelineConfig.height * fit) / 2
  return (index: number): Placement => {
    const s = frame.stars[index]
    if (!s.visible || s.x === null || s.y === null) return { visible: false, x: 0, y: 0, scale: fit }
    return { visible: true, x: ox + s.x * fit, y: oy + s.y * fit, scale: fit }
  }
}

function draw() {
  const canvas = canvasRef.value
  if (!canvas) { animId = requestAnimationFrame(draw); return }
  const ctx = canvas.getContext('2d')!
  const w = canvas.width = canvas.offsetWidth * 2
  const h = canvas.height = canvas.offsetHeight * 2
  const cx = w / 2, cy = h / 2
  const scale = Math.min(w, h) * store.zoom

  const frame = store.currentFrame
  const place = frame ? framePlacement(frame, w, h) : null

  // 星位获取：回放时读帧内保存坐标，实时模式才现算投影
  function starPos(starIndex: number, ra: number, dec: number): Placement {
    if (frame && place) return place(starIndex)
    const [x, y] = store.projectStar(ra, dec, cx, cy, scale)
    return { visible: x >= -500, x, y, scale: 1 }
  }

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

  // grid（回放时不重算投影，隐藏网格并避免整片重算）
  if (store.showGrid && !frame) {
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

  // constellation lines（回放时使用帧内保存的两端位置）
  if (store.showConstLines) {
    ctx.strokeStyle = 'rgba(100,180,255,0.4)'
    ctx.lineWidth = 1.5
    for (const c of store.CONSTELLATIONS) {
      for (const [i, j] of c.lines) {
        const s1 = store.STARS[i], s2 = store.STARS[j]
        const p1 = starPos(i, s1.ra, s1.dec)
        const p2 = starPos(j, s2.ra, s2.dec)
        if (!p1.visible || !p2.visible) continue
        ctx.beginPath()
        ctx.moveTo(p1.x, p1.y)
        ctx.lineTo(p2.x, p2.y)
        ctx.stroke()
      }
    }
  }

  // stars
  store.STARS.forEach((star, i) => {
    const p = starPos(i, star.ra, star.dec)
    if (!p.visible || p.x < -500 || p.x > w + 500 || p.y < -500 || p.y > h + 500) return
    const radius = store.starRadius(star.mag) * (frame ? p.scale * 2 : 1)
    const color = store.spectralColor(star.spectral)

    // glow
    const gradient = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, radius * 3)
    gradient.addColorStop(0, color)
    gradient.addColorStop(1, 'transparent')
    ctx.fillStyle = gradient
    ctx.beginPath()
    ctx.arc(p.x, p.y, radius * 3, 0, Math.PI * 2)
    ctx.fill()

    // core
    ctx.fillStyle = color
    ctx.beginPath()
    ctx.arc(p.x, p.y, radius, 0, Math.PI * 2)
    ctx.fill()

    // label
    if (store.showLabels && star.mag < 2.5) {
      ctx.fillStyle = 'rgba(200,200,255,0.7)'
      ctx.font = `${10 * store.zoom}px system-ui`
      ctx.fillText(star.name, p.x + radius + 4, p.y + 4)
    }
  })

  // horizon（与具体星体无关的固定装饰）
  if (!frame) {
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
  }

  // constellation labels（回放时同样读帧内位置）
  if (store.showLabels) {
    ctx.fillStyle = 'rgba(100,180,255,0.8)'
    ctx.font = `bold ${12 * store.zoom}px system-ui`
    store.CONSTELLATIONS.forEach((c) => {
      const starIndex = c.stars[0]
      const midStar = store.STARS[starIndex]
      const p = starPos(starIndex, midStar.ra, midStar.dec)
      if (!p.visible) return
      ctx.fillText(c.nameCn, p.x - 20, p.y - 15 * store.zoom)
    })
  }

  // 回放/对比状态角标
  if (frame) {
    ctx.fillStyle = 'rgba(100,200,255,0.85)'
    ctx.font = '24px system-ui'
    ctx.fillText(`回放帧 #${frame.index} · ${new Date(frame.time).toLocaleString()} · LST ${frame.lst.toFixed(2)}h`, 24, 40)
  }

  animId = requestAnimationFrame(draw)
}

function onClick(e: MouseEvent) {
  // 回放模式下星位来自保存帧，点击选取仍走实时投影，语义不同故关闭
  if (store.currentFrame) return
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

onMounted(() => { void store.initPipeline(); draw() })
onUnmounted(() => cancelAnimationFrame(animId))
</script>
