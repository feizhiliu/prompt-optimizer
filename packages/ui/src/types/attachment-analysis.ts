export interface AttachmentAnalysisOptions {
  model: string
  expectedDestination: string
  mode: 'direct' | 'general'
  question: string
  confirmVideo: boolean
  analysisMode: 'visual' | 'speech'
  includeSpeech: boolean
  cloudTranscription: boolean
  preserveLayout: boolean
  range?: { start: number; end: number }
  history: Array<{ question: string; answer: string }>
}

export interface AttachmentAnalysisCapabilities {
  video: boolean
  transcription: boolean
  documents: 'all' | 'pdf' | 'none'
  destination: string
}

export interface AttachmentAnalysisResult {
  answer: string
  destination: string
  summaries: Array<{
    name: string
    kind: 'text' | 'nativeText' | 'pages' | 'image' | 'direct' | 'sampled'
    frames?: number
    source?: 'none' | 'sidecar' | 'subtitles' | 'transcription'
    scope?: string
  }>
}

export interface AttachmentAnalysisAPI {
  inspect(key: string): Promise<AttachmentAnalysisCapabilities>
  analyze(options: AttachmentAnalysisOptions, files: File[]): Promise<AttachmentAnalysisResult>
}
