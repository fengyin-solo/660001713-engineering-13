<template>
  <div class="flex h-screen">
    <!-- Sidebar -->
    <div class="w-80 bg-gray-900 p-4 flex flex-col gap-4 overflow-y-auto">
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

      <!-- Time Travel (live direct advance) -->
      <div>
        <label class="text-gray-400 text-xs">时间旅行（实时推进，现算）</label>
        <input type="datetime-local" v-model="dateStr" @input="updateDate"
          class="w-full bg-gray-800 rounded px-3 py-2 text-sm" />
      </div>

      <!-- Replayable time pipeline -->
      <div class="border border-blue-800 rounded-lg p-3 flex flex-col gap-2">
        <label class="text-blue-300 text-xs font-bold">可回放时间管线（帧本地保存，回放不重算）</label>

        <div class="grid grid-cols-2 gap-2 text-xs">
          <div>
            <span class="text-gray-400">起始时刻</span>
            <input type="datetime-local" v-model="startStr" class="w-full bg-gray-800 rounded px-2 py-1" />
          </div>
          <div>
            <span class="text-gray-400">结束时刻</span>
            <input type="datetime-local" v-model="endStr" class="w-full bg-gray-800 rounded px-2 py-1" />
          </div>
        </div>
        <div class="grid grid-cols-2 gap-2 text-xs">
          <div>
            <span class="text-gray-400">固定步长</span>
            <select v-model.number="stepMs" class="w-full bg-gray-800 rounded px-2 py-1">
              <option v-for="o in store.STEP_OPTIONS" :key="o.ms" :value="o.ms">{{ o.label }}</option>
            </select>
          </div>
          <div>
            <span class="text-gray-400">纬度: {{ store.latitude.toFixed(1) }}°</span>
            <input type="range" v-model.number="store.latitude" min="-90" max="90" step="0.1" class="w-full" />
          </div>
        </div>

        <button @click="applyAndBuild" :disabled="store.isBuilding"
          class="bg-blue-700 hover:bg-blue-600 disabled:opacity-50 rounded py-1.5 text-sm">
          {{ store.isBuilding ? '构建中…' : '按步长构建 / 复用管线' }}
        </button>

        <div v-if="store.pipelineReady" class="flex flex-col gap-2">
          <div class="flex items-center gap-2">
            <button @click="store.startPlayback()" :disabled="store.isPlaying"
              class="flex-1 bg-green-700 hover:bg-green-600 disabled:opacity-50 rounded py-1 text-xs">▶ 回放</button>
            <button @click="store.pausePlayback()"
              class="flex-1 bg-yellow-700 hover:bg-yellow-600 rounded py-1 text-xs">⏸ 暂停</button>
            <button @click="store.stopPlayback()"
              class="flex-1 bg-gray-700 hover:bg-gray-600 rounded py-1 text-xs">⏹ 停止</button>
          </div>
          <div class="flex items-center gap-2 text-xs text-gray-300">
            <button @click="store.stepFrame(-1)" class="bg-gray-800 rounded px-2 py-1">◀ 上一帧</button>
            <div class="flex-1 text-center" v-if="store.currentFrame">
              帧 #{{ store.currentFrame.index }} / {{ store.pipelineFrameCount - 1 }}
              <input type="range" min="0" :max="store.pipelineFrameCount - 1" step="1"
                :value="store.currentFrame.index"
                @input="onScrub" class="w-full" />
              {{ new Date(store.currentFrame.time).toLocaleString() }}
            </div>
            <button @click="store.stepFrame(1)" class="bg-gray-800 rounded px-2 py-1">下一帧 ▶</button>
          </div>

          <!-- 对比两个时刻 -->
          <div class="text-xs">
            <span class="text-gray-400">对比当前帧与：</span>
            <select :value="store.compareIndex ?? ''" @change="onCompareChange"
              class="w-full bg-gray-800 rounded px-2 py-1 mt-1">
              <option value="">不对比</option>
              <option v-for="i in store.pipelineFrameCount" :key="i - 1" :value="i - 1">帧 #{{ i - 1 }}</option>
            </select>
          </div>
          <div v-if="store.frameDiff" class="text-[11px] bg-gray-800 rounded p-2 max-h-40 overflow-y-auto">
            <p class="text-gray-400 mb-1">
              帧 #{{ store.frameDiff.indexB }} → #{{ store.frameDiff.indexA }}
            </p>
            <div v-for="d in topDiffs" :key="d.name" class="flex justify-between">
              <span>{{ d.name }}</span>
              <span :class="crossed(d) ? 'text-amber-400' : 'text-gray-300'">
                <template v-if="crossed(d)">穿越地平</template>
                <template v-else>Δalt {{ d.altDeltaDeg.toFixed(1) }}°<template v-if="d.pixelDist !== null"> · {{ d.pixelDist.toFixed(0) }}px</template></template>
              </span>
            </div>
          </div>
        </div>
        <p v-else class="text-[11px] text-gray-500">
          未构建管线时只能实时现算；构建后回放与构建校验共用同一份已保存帧。
        </p>
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

      <!-- Pipeline log -->
      <div class="text-[11px]">
        <h4 class="text-gray-400 mb-1">管线日志（缺失/取不到均说明原因）</h4>
        <div class="bg-black/50 rounded p-2 max-h-36 overflow-y-auto flex flex-col gap-0.5">
          <p v-for="(l, i) in store.logs" :key="i"
            :class="l.level === 'error' ? 'text-red-400' : l.level === 'warn' ? 'text-amber-300' : 'text-gray-400'">
            {{ l.time }} {{ l.msg }}
          </p>
          <p v-if="!store.logs.length" class="text-gray-600">暂无日志</p>
        </div>
      </div>

      <div class="text-xs text-gray-500 mt-auto">
        LST: {{ store.localSiderealTime.toFixed(2) }}h
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
const dateStr = ref(toLocalInputValue(new Date()))
function updateDate() { store.viewDate = new Date(dateStr.value) }

// datetime-local 需要本地时间的 YYYY-MM-DDTHH:mm，直接用 toISOString 会带时区偏移
function toLocalInputValue(d: Date) {
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}
const startStr = ref(toLocalInputValue(new Date(store.pipelineConfig.startTime)))
const endStr = ref(toLocalInputValue(new Date(store.pipelineConfig.endTime)))
const stepMs = ref(store.pipelineConfig.stepMs)

function applyAndBuild() {
  const start = new Date(startStr.value)
  const end = new Date(endStr.value)
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end < start) {
    store.logs.unshift({ time: new Date().toLocaleTimeString(), level: 'warn', msg: '时间范围无效，未构建管线' })
    return
  }
  store.pipelineConfig.startTime = start.toISOString()
  store.pipelineConfig.endTime = end.toISOString()
  store.pipelineConfig.stepMs = stepMs.value
  store.pipelineConfig.latitude = store.latitude
  void store.buildPipeline(true)
}

function onScrub(e: Event) {
  const i = Number((e.target as HTMLInputElement).value)
  void store.loadFrame(i)
}

function onCompareChange(e: Event) {
  const v = (e.target as HTMLSelectElement).value
  store.setCompareIndex(v === '' ? null : Number(v))
}

const topDiffs = computed(() => {
  const d = store.frameDiff
  if (!d) return []
  return [...d.stars]
    .sort((a, b) => (b.pixelDist ?? (crossed(b) ? 1e9 : 0)) - (a.pixelDist ?? (crossed(a) ? 1e9 : 0)))
    .slice(0, 12)
})
function crossed(d: { visibleBefore: boolean; visibleAfter: boolean }) {
  return d.visibleBefore !== d.visibleAfter
}
</script>
