<template>
  <div class="flex h-screen">
    <!-- Sidebar -->
    <div class="w-72 bg-gray-900 p-4 flex flex-col gap-4 overflow-y-auto">
      <h1 class="text-xl font-bold text-blue-400">天文星图渲染器</h1>

      <!-- Search -->
      <div>
        <input v-model="store.searchQuery" placeholder="搜索天体..." class="w-full bg-gray-800 rounded px-3 py-2 text-sm" />
        <div v-if="store.filteredStars.length" class="mt-1">
          <div v-for="s in store.filteredStars" :key="s.name"
            @click="store.selectedStar = s"
            class="bg-gray-800 p-2 rounded mt-1 cursor-pointer hover:bg-gray-700 text-sm">
            {{ s.name }} <span class="text-gray-400">mag {{ s.mag }}</span>
          </div>
        </div>
      </div>

      <!-- Replayable time pipeline -->
      <div class="border border-blue-900 rounded-lg p-3 flex flex-col gap-2">
        <label class="text-blue-300 text-xs font-semibold">可回放时间管线（帧位置本地保存）</label>

        <div class="grid grid-cols-2 gap-2">
          <div>
            <label class="text-gray-400 text-[10px]">起始时刻</label>
            <input type="datetime-local" v-model="rangeStartStr" class="w-full bg-gray-800 rounded px-2 py-1 text-xs" />
          </div>
          <div>
            <label class="text-gray-400 text-[10px]">结束时刻</label>
            <input type="datetime-local" v-model="rangeEndStr" class="w-full bg-gray-800 rounded px-2 py-1 text-xs" />
          </div>
        </div>

        <div class="flex items-center gap-2">
          <label class="text-gray-400 text-[10px] whitespace-nowrap">步长</label>
          <select v-model.number="stepMinutes" class="flex-1 bg-gray-800 rounded px-2 py-1 text-xs">
            <option :value="15">15 分钟</option>
            <option :value="60">1 小时</option>
            <option :value="360">6 小时</option>
            <option :value="1440">1 天</option>
          </select>
          <button @click="build" :disabled="store.building"
            class="bg-blue-700 hover:bg-blue-600 disabled:opacity-50 rounded px-2 py-1 text-xs whitespace-nowrap">
            {{ store.building ? '构建中…' : '构建/载入' }}
          </button>
        </div>

        <div v-if="store.pipeline" class="flex flex-col gap-2">
          <div class="flex gap-2">
            <button @click="store.stepReplay(-1)" class="flex-1 bg-gray-700 hover:bg-gray-600 rounded py-1 text-xs">◀ 上一帧</button>
            <button @click="store.togglePlay" class="flex-1 bg-blue-700 hover:bg-blue-600 rounded py-1 text-xs">
              {{ store.playing ? '暂停' : '播放' }}
            </button>
            <button @click="store.stepReplay(1)" class="flex-1 bg-gray-700 hover:bg-gray-600 rounded py-1 text-xs">下一帧 ▶</button>
          </div>

          <div>
            <label class="text-gray-400 text-[10px]">帧 {{ store.currentFrameIndex + 1 }} / {{ store.pipeline.frames.length }}</label>
            <input type="range" min="0" :max="store.pipeline.frames.length - 1" step="1"
              :value="store.currentFrameIndex"
              @input="onScrub" class="w-full" />
            <label class="text-gray-300 text-[10px]">帧时刻: {{ frameTimeLabel }}</label>
          </div>

          <div class="flex gap-2">
            <button v-if="store.baselineFrameIndex === null" @click="store.setBaselineHere"
              class="flex-1 bg-amber-800 hover:bg-amber-700 rounded py-1 text-xs">
              以此帧为对比基准
            </button>
            <button v-else @click="store.clearBaseline"
              class="flex-1 bg-amber-900 hover:bg-amber-800 rounded py-1 text-xs">
              清除对比基准
            </button>
            <button @click="store.exitReplay"
              class="flex-1 bg-gray-700 hover:bg-gray-600 rounded py-1 text-xs">退出回放</button>
          </div>

          <div v-if="store.currentDiff" class="text-[10px] text-amber-200 bg-gray-800 rounded p-2 max-h-32 overflow-y-auto">
            <div class="font-semibold mb-1">
              两时刻差异（基准帧 {{ store.baselineFrameIndex! + 1 }} → 当前帧 {{ store.currentFrameIndex + 1 }}）
            </div>
            <div v-for="d in topMovers" :key="d.index" class="flex justify-between">
              <span>{{ d.name }}</span>
              <span :class="d.bothVisible ? 'text-amber-300' : 'text-gray-500'">
                {{ d.bothVisible ? d.angularDeg.toFixed(2) + '°' : '有不可见时刻' }}
              </span>
            </div>
          </div>
        </div>

        <!-- 数据缺失/取不到时刻的原因在此说明，不静默跳过 -->
        <div v-if="store.notice" class="text-[10px] text-yellow-300 bg-yellow-900/30 rounded p-2 leading-relaxed">
          {{ store.notice }}
        </div>
      </div>

      <!-- Time Travel (free mode: direct advance, recomputed) -->
      <div>
        <label class="text-gray-400 text-xs">时间旅行（自由选时刻，实时现算）</label>
        <input type="datetime-local" v-model="dateStr" @input="updateDate"
          class="w-full bg-gray-800 rounded px-3 py-2 text-sm" />
      </div>

      <!-- Location -->
      <div>
        <label class="text-gray-400 text-xs">纬度: {{ store.latitude.toFixed(1) }}°</label>
        <input type="range" v-model.number="store.latitude" min="-90" max="90" step="0.1"
          @input="store.onLatitudeChanged" class="w-full" />
      </div>

      <!-- Zoom -->
      <div>
        <label class="text-gray-400 text-xs">缩放: {{ store.zoom.toFixed(1) }}x</label>
        <input type="range" v-model.number="store.zoom" min="0.3" max="3" step="0.1" class="w-full" />
      </div>

      <!-- Toggles -->
      <div class="flex flex-col gap-2">
        <label class="flex items-center gap-2 text-sm">
          <input type="checkbox" v-model="store.showLabels" /> 星名标签
        </label>
        <label class="flex items-center gap-2 text-sm">
          <input type="checkbox" v-model="store.showConstLines" /> 星座连线
        </label>
        <label class="flex items-center gap-2 text-sm">
          <input type="checkbox" v-model="store.showGrid" /> 坐标网格
        </label>
      </div>

      <!-- Star Info -->
      <div v-if="store.selectedStar" class="bg-gray-800 rounded-xl p-3">
        <h3 class="text-amber-400 font-bold">{{ store.selectedStar.name }}</h3>
        <div class="text-xs text-gray-300 mt-2 space-y-1">
          <p>赤经: {{ store.selectedStar.ra.toFixed(2) }}h</p>
          <p>赤纬: {{ store.selectedStar.dec.toFixed(2) }}°</p>
          <p>视星等: {{ store.selectedStar.mag }}</p>
          <p>光谱型: {{ store.selectedStar.spectral }}</p>
        </div>
      </div>

      <!-- Constellation list -->
      <div class="text-xs">
        <h4 class="text-gray-400 mb-1">可见星座</h4>
        <div v-for="c in store.CONSTELLATIONS" :key="c.name" class="py-1 text-gray-300">
          {{ c.nameCn }} <span class="text-gray-500">({{ c.name }})</span>
        </div>
      </div>

      <div class="text-xs text-gray-500 mt-auto">
        LST: {{ store.localSiderealTime.toFixed(2) }}h
        <span v-if="store.reusedCache" class="text-blue-400">（位置读取自本地管线）</span>
      </div>
    </div>

    <!-- Sky Canvas -->
    <div class="flex-1 relative">
      <StarCanvas />
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed } from 'vue'
import { useSkyStore } from './store/sky'
import StarCanvas from './components/StarCanvas.vue'

const store = useSkyStore()
const dateStr = ref(new Date().toISOString().slice(0, 16))
function updateDate() { store.viewDate = new Date(dateStr.value) }

// 管线回放控制
function toLocalInput(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

const now = Date.now()
const rangeStartStr = ref(toLocalInput(new Date(now - 12 * 3600_000)))
const rangeEndStr = ref(toLocalInput(new Date(now + 12 * 3600_000)))
const stepMinutes = ref(60)

function build() {
  const startMs = new Date(rangeStartStr.value).getTime()
  const endMs = new Date(rangeEndStr.value).getTime()
  if (!(endMs > startMs) || Number.isNaN(startMs) || Number.isNaN(endMs)) {
    store.notice = '时间范围无效：请检查起始/结束时刻（结束需晚于起始）'
    return
  }
  const stepMs = stepMinutes.value * 60_000
  if (stepMs <= 0 || stepMs > endMs - startMs) {
    store.notice = `步长无效：步长 ${stepMinutes.value} 分钟必须为正且不大于时间跨度`
    return
  }
  store.buildReplay(startMs, endMs, stepMs)
}

function onScrub(e: Event) {
  const index = Number((e.target as HTMLInputElement).value)
  const bundle = store.pipeline
  if (!bundle) return
  const result = bundle.frames[index]
  if (!result) {
    store.notice = `第 ${index} 帧缺失，无法跳转`
    return
  }
  store.seekReplay(result.timeMs)
}

const frameTimeLabel = computed(() => {
  const frame = store.currentFrame
  return frame ? new Date(frame.timeMs).toLocaleString() : '—'
})

// 两时刻对比中移动最明显的 8 颗星
const topMovers = computed(() => {
  const diff = store.currentDiff
  if (!diff) return []
  return [...diff.deltas]
    .sort((a, b) => b.angularDeg - a.angularDeg)
    .slice(0, 8)
})
</script>
