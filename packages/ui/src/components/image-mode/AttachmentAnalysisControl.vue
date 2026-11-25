<template>
  <NSpace :size="8">
    <NButton size="small" secondary data-testid="video-direct-open" @click="open('direct')">
      {{ t('workspace.attachmentAnalysis.direct') }}
    </NButton>
    <NButton size="small" secondary data-testid="agent-attachments-open" @click="open('general')">
      {{ t('workspace.attachmentAnalysis.general') }}
    </NButton>
  </NSpace>

  <NModal
    v-model:show="visible"
    preset="card"
    :title="t(mode === 'direct' ? 'workspace.attachmentAnalysis.direct' : 'workspace.attachmentAnalysis.general')"
    :mask-closable="!busy"
    :close-on-esc="!busy"
    :closable="!busy"
    :style="{ width: 'min(740px, calc(100vw - 24px))', maxHeight: '90vh', overflowY: 'auto' }"
  >
    <NSpace vertical :size="14">
      <TextModelSelector
        v-model="model"
        :options="modelOptions"
        :placeholder="t('imageWorkspace.input.modelPlaceholder')"
        :disabled="busy"
        data-testid="attachment-analysis-model"
      />

      <NText v-if="capabilities" depth="3">
        {{ t('workspace.attachmentAnalysis.destination', { host: capabilities.destination }) }}
      </NText>
      <NAlert v-if="mode === 'direct' && capabilities && !capabilities.video" type="warning" :show-icon="false">
        {{ t('workspace.attachmentAnalysis.directUnavailable') }}
      </NAlert>
      <NCheckbox v-if="mode === 'direct' && capabilities?.video" v-model:checked="confirmVideo" :disabled="busy">
        {{ t('workspace.attachmentAnalysis.confirmVideo') }}
      </NCheckbox>

      <input
        ref="fileInput"
        type="file"
        class="attachment-file-input"
        :accept="extensions"
        :multiple="mode === 'general'"
        :disabled="busy"
        data-testid="attachment-analysis-files"
        @change="pickFiles"
      />
      <button
        type="button"
        class="attachment-drop"
        :class="{ 'attachment-drop--active': dragActive }"
        :disabled="busy"
        @click="fileInput?.click()"
        @dragover.prevent="handleDragOver"
        @dragleave="dragActive = false"
        @drop.prevent="dropFiles"
      >
        {{ t(mode === 'direct' ? 'workspace.attachmentAnalysis.dropVideo' : 'workspace.attachmentAnalysis.dropFiles') }}
      </button>

      <ul v-if="files.length" class="attachment-list">
        <li v-for="(file, index) in files" :key="fileKey(file)" class="attachment-item">
          <span class="attachment-name">
            {{ file.name }}
            <small>{{ plannedHandling(file) }}</small>
          </span>
          <NButton size="tiny" quaternary :disabled="busy" @click="removeFile(index)">
            {{ t('workspace.attachmentAnalysis.remove') }}
          </NButton>
        </li>
      </ul>

      <template v-if="mode === 'general'">
        <template v-if="hasVideo">
          <NCheckbox v-model:checked="speechOnly" :disabled="busy">
            {{ t('workspace.attachmentAnalysis.speechOnly') }}
          </NCheckbox>
          <NCheckbox v-if="!speechOnly" v-model:checked="includeSpeech" :disabled="busy">
            {{ t('workspace.attachmentAnalysis.includeSpeech') }}
          </NCheckbox>
          <NCheckbox v-if="capabilities?.transcription && (speechOnly || includeSpeech)" v-model:checked="cloudTranscription" :disabled="busy">
            {{ t('workspace.attachmentAnalysis.cloudTranscription') }}
          </NCheckbox>
          <div v-if="videoCount === 1" class="attachment-time-range">
            <NInputNumber v-model:value="start" :min="0" :step="0.5" :disabled="busy" :placeholder="t('workspace.attachmentAnalysis.start')" data-testid="attachment-range-start" />
            <NInputNumber v-model:value="end" :min="0" :step="0.5" :disabled="busy" :placeholder="t('workspace.attachmentAnalysis.end')" data-testid="attachment-range-end" />
          </div>
        </template>
        <NCheckbox
          v-if="hasWord && !speechOnly && capabilities?.documents !== 'none' && capabilities"
          v-model:checked="preserveLayout"
          :disabled="busy"
        >
          {{ t('workspace.attachmentAnalysis.preserveLayout') }}
        </NCheckbox>
      </template>

      <NInput
        v-model:value="question"
        type="textarea"
        :disabled="busy"
        :maxlength="16000"
        :autosize="{ minRows: 3, maxRows: 8 }"
        :placeholder="t('workspace.attachmentAnalysis.question')"
        data-testid="attachment-analysis-question"
      />
      <NAlert v-if="errorMessage" type="error" data-testid="attachment-analysis-error">{{ errorMessage }}</NAlert>
      <NAlert v-if="invalidRange" type="warning" :show-icon="false">
        {{ t('workspace.attachmentAnalysis.invalidRange') }}
      </NAlert>
      <NButton type="primary" :loading="busy" :disabled="!canSubmit" data-testid="attachment-analysis-submit" @click="analyze">
        {{ t(busy ? 'workspace.attachmentAnalysis.processing' : 'workspace.attachmentAnalysis.submit') }}
      </NButton>

      <section v-if="result" ref="answerPanel" class="attachment-result">
        <NAlert type="info" :show-icon="false">
          <ul class="attachment-summaries">
            <li v-for="(item, index) in result.summaries" :key="index">
              {{ item.name }} · {{ summarize(item) }}
            </li>
          </ul>
        </NAlert>
        <pre class="attachment-answer" data-testid="attachment-analysis-answer">{{ result.answer }}</pre>
        <NButton size="small" :disabled="busy" @click="useResult">{{ t('workspace.attachmentAnalysis.useResult') }}</NButton>
      </section>
    </NSpace>
  </NModal>
</template>

<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { NAlert, NButton, NCheckbox, NInput, NInputNumber, NModal, NSpace, NText } from 'naive-ui'
import TextModelSelector from '../TextModelSelector.vue'
import type { ModelSelectOption } from '../../types/select-options'
import type { AttachmentAnalysisCapabilities, AttachmentAnalysisOptions, AttachmentAnalysisResult } from '../../types/attachment-analysis'

const props = defineProps<{ modelOptions: ModelSelectOption[]; initialModel: string }>()
const emit = defineEmits<{ useResult: [value: string] }>()
const { t } = useI18n()
const api = window.electronAPI?.attachmentAnalysis
const visible = ref(false)
const mode = ref<AttachmentAnalysisOptions['mode']>('general')
const model = ref('')
const capabilities = ref<AttachmentAnalysisCapabilities>()
const files = ref<File[]>([])
const fileInput = ref<HTMLInputElement>()
const question = ref('')
const result = ref<AttachmentAnalysisResult>()
const answerPanel = ref<HTMLElement>()
const history = ref<AttachmentAnalysisOptions['history']>([])
const busy = ref(false)
const errorMessage = ref('')
const dragActive = ref(false)
const confirmVideo = ref(false)
const speechOnly = ref(false)
const includeSpeech = ref(false)
const cloudTranscription = ref(false)
const preserveLayout = ref(false)
const start = ref<number | null>(null)
const end = ref<number | null>(null)

const videoExtensions = '.mp4,.mov,.webm,.mkv'
const documentExtensions = '.pdf,.docx,.txt,.md,.csv,.json,.png,.jpg,.jpeg,.webp,.srt,.vtt'
const extensions = computed(() => mode.value === 'direct' ? videoExtensions : videoExtensions + ',' + documentExtensions)
const extension = (file: File) => file.name.lastIndexOf('.') < 0 ? '' : file.name.slice(file.name.lastIndexOf('.')).toLowerCase()
const isVideo = (file: File) => videoExtensions.split(',').includes(extension(file))
const videoCount = computed(() => files.value.filter(isVideo).length)
const hasVideo = computed(() => videoCount.value > 0)
const hasWord = computed(() => files.value.some(file => extension(file) === '.docx'))
const hasTimes = computed(() => mode.value === 'general' && videoCount.value === 1 && (start.value !== null || end.value !== null))
const invalidRange = computed(() => hasTimes.value && (start.value === null || end.value === null || end.value <= start.value))
const canSubmit = computed(() => Boolean(
  !busy.value && !invalidRange.value && capabilities.value && question.value.trim() && files.value.length &&
  (mode.value !== 'direct' || capabilities.value.video && confirmVideo.value),
))

function messageFor(error: unknown) {
  return error instanceof Error ? error.message : typeof error === 'object' && error && 'message' in error
    ? String(error.message) : t('workspace.attachmentAnalysis.failed')
}

function clearHistory() {
  history.value = []
  result.value = undefined
}

watch([model, visible], async ([key, show], [previousKey], onCleanup) => {
  if (!show) return
  let stale = false
  onCleanup(() => { stale = true })
  const previous = capabilities.value
  capabilities.value = undefined
  if (key !== previousKey) {
    confirmVideo.value = false
    cloudTranscription.value = false
    clearHistory()
  }
  if (!key || !api) return
  try {
    const details = await api.inspect(key)
    if (!stale) {
      if (previous && previous.destination !== details.destination) {
        confirmVideo.value = false
        cloudTranscription.value = false
        clearHistory()
      }
      capabilities.value = details
    }
  } catch (error) {
    if (!stale) errorMessage.value = messageFor(error)
  }
})

function open(next: AttachmentAnalysisOptions['mode']) {
  if (mode.value !== next) {
    files.value = []
    question.value = ''
    start.value = null
    end.value = null
    confirmVideo.value = false
    clearHistory()
  }
  mode.value = next
  if (!model.value) model.value = props.initialModel
  errorMessage.value = ''
  visible.value = true
}

function fileKey(file: File) {
  return JSON.stringify([file.name, file.size, file.lastModified])
}

function addFiles(added: File[]) {
  if (busy.value || !added.length) return
  errorMessage.value = ''
  const valid = extensions.value.split(',')
  if (added.some(file => !valid.includes(extension(file)))) {
    errorMessage.value = t('workspace.attachmentAnalysis.unsupportedFile')
    return
  }
  const combined = mode.value === 'direct' ? added : [...files.value, ...added]
  const unique = Array.from(new Map(combined.map(file => [fileKey(file), file])).values())
  const limit = mode.value === 'direct' ? 1 : 6
  if (unique.length > limit) {
    errorMessage.value = t('workspace.attachmentAnalysis.fileCount', { count: limit })
    return
  }
  files.value = unique
  clearHistory()
}

function pickFiles(event: Event) {
  const input = event.target as HTMLInputElement
  addFiles(Array.from(input.files || []))
  input.value = ''
}

function handleDragOver(event: DragEvent) {
  if (busy.value || !event.dataTransfer?.types.includes('Files')) return
  event.dataTransfer.dropEffect = 'copy'
  dragActive.value = true
}

function dropFiles(event: DragEvent) {
  dragActive.value = false
  addFiles(Array.from(event.dataTransfer?.files || []))
}

function removeFile(index: number) {
  files.value = files.value.filter((_, i) => i !== index)
  clearHistory()
}

function plannedHandling(file: File) {
  const prefix = 'workspace.attachmentAnalysis.'
  const ext = extension(file)
  if (mode.value === 'direct') return t(prefix + 'kind.direct')
  if (isVideo(file)) {
    const key = speechOnly.value ? 'speech' : includeSpeech.value ? 'framesSpeech' : 'frames'
    return t(prefix + 'plan.' + key)
  }
  if (['.png', '.jpeg', '.jpg', '.webp'].includes(ext)) return t(prefix + 'kind.image')
  const documents = capabilities.value?.documents || 'none'
  if (!speechOnly.value && documents !== 'none') {
    if (ext === '.pdf' || ext === '.docx' && preserveLayout.value) return t(prefix + 'kind.pages')
    if (ext === '.docx' && documents === 'all') return t(prefix + 'kind.nativeText')
  }
  return t(prefix + 'kind.text')
}

function summarize(item: AttachmentAnalysisResult['summaries'][number]) {
  const prefix = 'workspace.attachmentAnalysis.'
  if (item.kind !== 'sampled') return t(prefix + 'kind.' + item.kind)
  return t(prefix + 'sampled', {
    frames: item.frames ?? 0,
    source: t(prefix + 'speech.' + (item.source || 'none')),
    scope: item.scope,
  })
}

async function analyze() {
  if (!api || !canSubmit.value) return
  const prompt = question.value.trim()
  const range = hasTimes.value && start.value !== null && end.value !== null
    ? { start: start.value, end: end.value } : undefined
  busy.value = true
  errorMessage.value = ''
  try {
    const analyzed = await api.analyze({
      mode: mode.value,
      model: model.value,
      expectedDestination: capabilities.value?.destination || '',
      question: prompt,
      confirmVideo: confirmVideo.value,
      analysisMode: speechOnly.value && hasVideo.value ? 'speech' : 'visual',
      includeSpeech: includeSpeech.value && hasVideo.value,
      cloudTranscription: Boolean(cloudTranscription.value && capabilities.value?.transcription && hasVideo.value && (speechOnly.value || includeSpeech.value)),
      preserveLayout: Boolean(preserveLayout.value && hasWord.value && !speechOnly.value && capabilities.value?.documents !== 'none'),
      history: history.value.slice(-2).map(turn => ({ question: turn.question, answer: turn.answer })),
      range,
    }, [...files.value])
    result.value = analyzed
    history.value = [...history.value.slice(-1), { question: prompt, answer: analyzed.answer }]
    await nextTick()
    answerPanel.value?.scrollIntoView({ block: 'nearest' })
  } catch (error) {
    errorMessage.value = messageFor(error)
  } finally {
    busy.value = false
  }
}

function useResult() {
  if (!result.value) return
  emit('useResult', result.value.answer)
  visible.value = false
}
</script>

<style scoped>
.attachment-file-input { display: none; }
.attachment-drop { width: 100%; padding: 16px 12px; border: 1px dashed var(--n-border-color); border-radius: 8px; background: transparent; color: inherit; font: inherit; cursor: pointer; }
.attachment-drop:hover, .attachment-drop--active, .attachment-drop:focus-visible { border-color: currentColor; }
.attachment-drop:disabled { cursor: default; opacity: 0.6; }
.attachment-list, .attachment-summaries { margin: 0; padding: 0; list-style: none; }
.attachment-item { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 6px 0; }
.attachment-name { min-width: 0; overflow-wrap: anywhere; }
.attachment-name small { display: block; opacity: 0.7; }
.attachment-time-range { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; }
.attachment-result { display: flex; flex-direction: column; align-items: stretch; gap: 12px; }
.attachment-result > :last-child { align-self: flex-start; }
.attachment-answer { margin: 0; border-top: 1px solid var(--n-border-color); padding-top: 12px; white-space: pre-wrap; overflow-wrap: anywhere; font: inherit; user-select: text; }
</style>
