const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { pathToFileURL } = require('node:url');
const mammoth = require('mammoth');
const {
  TextAdapterRegistry,
  decodeTextModelSelection,
  getTextModelSelectionConfigId,
  resolveRuntimeTextModel,
} = require('@prompt-optimizer/core');

const run = promisify(execFile);
const MiB = 1024 * 1024;
const videoTypes = {
  '.mp4': ['mov', 'video/mp4'],
  '.mov': ['mov', 'video/quicktime'],
  '.webm': ['matroska', 'video/webm'],
  '.mkv': ['matroska', 'video/x-matroska'],
};
const imageTypes = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp' };
const documentTypes = {
  '.pdf': 'application/pdf',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
};
const textTypes = new Set(['.txt', '.md', '.csv', '.json', '.srt', '.vtt']);
const textSubtitles = new Set(['subrip', 'mov_text', 'webvtt', 'ass', 'ssa', 'text']);

const textPart = text => ({ type: 'text', text });

async function videoTool(name) {
  const override = process.env['PROMPT_OPTIMIZER_' + name.toUpperCase() + '_PATH'];
  if (override) return override;
  if (process.platform === 'win32' && process.env.LOCALAPPDATA) {
    const installed = path.join(process.env.LOCALAPPDATA, 'Programs', 'ffmpeg', 'bin', name + '.exe');
    if (await fs.access(installed).then(() => true, () => false)) return installed;
  }
  return name;
}

async function mediaCommand(name, args, options = {}) {
  const { allowEmpty = false, ...processOptions } = options;
  try {
    return await run(await videoTool(name), args, {
      windowsHide: true,
      timeout: 120_000,
      maxBuffer: 2 * MiB,
      ...processOptions,
    });
  } catch (error) {
    if (allowEmpty && /No filtered frames for output stream/.test(error.stderr || '')
        && !/pts_time:/.test(error.stderr || '')) return { stdout: '', stderr: '' };
    if (error.code === 'ENOENT') throw new Error('FFmpeg and FFprobe must be installed and on PATH.');
    if (error.killed) throw new Error('Video processing timed out. Try a shorter time range.');
    throw new Error('Video could not be processed. Check that the file is readable and the codec is supported.');
  }
}

const mediaInput = file => ['-protocol_whitelist', 'file,pipe', '-f', videoTypes[file.ext][0], '-i', file.path];

async function describeFile(filePath) {
  if (typeof filePath !== 'string' || !path.isAbsolute(filePath) || filePath.startsWith('\\\\')) {
    throw new Error('Select a file stored on this computer.');
  }
  const information = await fs.stat(filePath);
  const name = path.basename(filePath);
  const ext = path.extname(name).toLowerCase();
  if (!information.isFile() || !information.size) throw new Error('Choose a non-empty file.');
  if (!videoTypes[ext] && !imageTypes[ext] && !documentTypes[ext] && !textTypes.has(ext)) {
    throw new Error('Unsupported attachment: ' + name);
  }
  return { path: filePath, name, ext, size: information.size, modified: information.mtimeMs };
}

async function probeVideo(file) {
  const { stdout } = await mediaCommand('ffprobe', [
    '-v', 'error', '-show_entries', 'format=duration:stream=codec_type,codec_name',
    '-of', 'json', ...mediaInput(file),
  ]);
  const probe = JSON.parse(stdout);
  const duration = Number(probe.format?.duration);
  if (!Number.isFinite(duration) || duration <= 0 || !probe.streams?.some(stream => stream.codec_type === 'video')) {
    throw new Error('No usable video track or duration in ' + file.name);
  }
  return { duration, streams: probe.streams };
}

const timestamp = value => Number(value).toFixed(3) + ' s';

function frameTimestamps(log) {
  return Array.from(log.matchAll(/pts_time:\s*(-?\d+(?:\.\d+)?(?:e[+-]?\d+)?)/gi), match => Number(match[1]));
}

async function extractFrames(file, directory, start, end, detailed) {
  const duration = end - start;
  const count = Math.min(detailed ? 24 : 16, Math.max(1, Math.ceil(duration / (detailed ? 0.35 : 1.25))));
  const imageFilter = 'scale=w=768:h=768:force_original_aspect_ratio=decrease:force_divisible_by=2:flags=bilinear,showinfo';
  const prefix = ['-hide_banner', '-nostdin', '-loglevel', 'info', '-threads', '2', '-filter_threads', '1'];
  const output = ['-map', '0:v:0', '-an', '-sn', '-dn', '-pix_fmt', 'yuvj420p', '-q:v', '4', '-threads', '1'];
  const seek = time => ['-ss', String(time), '-copyts', '-start_at_zero', ...mediaInput(file)];
  const planned = Array.from({ length: count }, (_, index) => start + index * duration / count);
  const frames = [];
  for (let offset = 0; offset < planned.length; offset += 3) {
    const group = planned.slice(offset, offset + 3);
    frames.push(...await Promise.all(group.map(async (time, index) => {
      const target = path.join(directory, 'sample-' + (offset + index) + '.jpg');
      const { stderr } = await mediaCommand('ffmpeg', [
        ...prefix, ...seek(time), ...output, '-vf', imageFilter, '-frames:v', '1', '-update', '1', target,
      ]);
      const data = await fs.readFile(target).catch(error => {
        if (error.code === 'ENOENT') return null;
        throw error;
      });
      if (!data) return null;
      return { time: frameTimestamps(stderr)[0] ?? time, data };
    })));
  }

  // Limit cut detection to shorter spans so an overview of a long video can seek instead of decoding it end to end.
  if (duration <= 120 && duration > 2) {
    const pattern = path.join(directory, 'cut-%02d.jpg');
    const { stderr } = await mediaCommand('ffmpeg', [
      ...prefix, ...seek(start), ...output,
      '-vf', 'trim=end=' + end + ',select=gt(scene\\,0.35),' + imageFilter,
      '-fps_mode', 'vfr', '-frames:v', '6', pattern,
    ], { allowEmpty: true });
    const times = frameTimestamps(stderr);
    for (const [index, time] of times.slice(0, 6).entries()) {
      if (frames.some(frame => frame && Math.abs(frame.time - time) < 0.15)) continue;
      const jpg = path.join(directory, 'cut-' + String(index + 1).padStart(2, '0') + '.jpg');
      const data = await fs.readFile(jpg).catch(error => {
        if (error.code === 'ENOENT') return null;
        throw error;
      });
      if (data) frames.push({ time, data });
    }
  }

  const ordered = frames.filter(Boolean).filter(frame => frame.time >= start - 0.03 && frame.time < end);
  ordered.sort((a, b) => a.time - b.time);
  if (!ordered.length) throw new Error('No sampled frames in the selected range.');
  return ordered;
}

function subtitleTime(value) {
  const [hours, minutes, seconds] = value.replace(',', '.').split(':').map(Number);
  return hours * 3600 + minutes * 60 + seconds;
}

async function readEmbeddedSubtitles(file, streams, start, end) {
  const subtitleStreams = streams.filter(stream => stream.codec_type === 'subtitle');
  const index = subtitleStreams.findIndex(stream => textSubtitles.has(stream.codec_name));
  if (index < 0) return '';
  const { stdout } = await mediaCommand('ffmpeg', [
    '-hide_banner', '-nostdin', '-loglevel', 'error', ...mediaInput(file),
    '-map', '0:s:' + index, '-f', 'srt', 'pipe:1',
  ]);
  return stdout.split(/\r?\n\s*\r?\n/).filter(block => {
    const interval = block.match(/(\d+:\d{2}:\d{2},\d+) --> (\d+:\d{2}:\d{2},\d+)/);
    return interval && subtitleTime(interval[1]) < end && subtitleTime(interval[2]) > start;
  }).join('\n\n');
}

async function getVideoEvidence(file, options, adapter, config, hasSidecar) {
  const { duration, streams } = await probeVideo(file);
  const start = options.range?.start ?? 0;
  const end = options.range?.end ?? duration;
  if (start >= duration || end > duration + 0.05) {
    throw new Error(file.name + ' ends at ' + timestamp(duration));
  }
  if (file.size > 2 * 1024 * MiB) throw new Error('Video exceeds the 2 GB local processing limit.');
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'prompt-optimizer-media-'));
  try {
    const frames = options.analysisMode === 'speech'
      ? []
      : await extractFrames(file, directory, start, end, Boolean(options.range));
    let subtitles = '';
    let source = 'none';
    if (options.includeSpeech || options.analysisMode === 'speech') {
      if (hasSidecar) {
        source = 'sidecar';
      } else {
        subtitles = await readEmbeddedSubtitles(file, streams, start, end);
        if (subtitles) source = 'subtitles';
      }
      if (source === 'none' && streams.some(stream => stream.codec_type === 'audio') && options.cloudTranscription) {
        if (end - start > 30 * 60) throw new Error('Cloud transcription accepts up to 30 minutes at once. Select a shorter range.');
        const audioPath = path.join(directory, 'audio.mp3');
        await mediaCommand('ffmpeg', [
          '-hide_banner', '-nostdin', '-loglevel', 'error', '-ss', String(start), ...mediaInput(file),
          '-t', String(end - start), '-map', '0:a:0', '-vn', '-sn', '-codec:a', 'libmp3lame', '-ac', '1', '-b:a', '64k', audioPath,
        ]);
        subtitles = await adapter.transcribeAttachment(await fs.readFile(audioPath), config);
        if (subtitles.trim()) source = 'transcription';
      }
    }
    if (!frames.length && source === 'none') throw new Error('No usable speech or subtitles. Enable cloud transcription or attach subtitles.');
    const scope = timestamp(start) + '–' + timestamp(end);
    const parts = [
      textPart('Video attachment ' + JSON.stringify(file.name) + '. Time interval: ' + scope + '.'),
      ...frames.flatMap(frame => [
        textPart('Video frame at ' + timestamp(frame.time)),
        { type: 'image', mimeType: 'image/jpeg', b64: frame.data.toString('base64') },
      ]),
    ];
    if (subtitles) parts.push(textPart('Speech evidence (' + source + ', interval ' + scope + '):\n' + subtitles));
    return { parts, summary: { name: file.name, kind: 'sampled', frames: frames.length, source, scope } };
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}

async function readPdfText(bytes) {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const task = pdfjs.getDocument({ data: Uint8Array.from(bytes), useSystemFonts: true });
  try {
    const document = await task.promise;
    if (document.numPages > 100) throw new Error('Local PDF extraction is limited to 100 pages.');
    const text = [];
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber++) {
      const page = await document.getPage(pageNumber);
      const { items } = await page.getTextContent();
      const pageText = items.map(item => item.str || '').join(' ').trim();
      if (pageText) text.push('[Page ' + pageNumber + ']\n' + pageText);
      page.cleanup();
    }
    if (!text.length) throw new Error('This PDF has no extractable text. Use a visual OpenAI model for scanned pages.');
    return text.join('\n\n');
  } finally {
    await task.destroy();
  }
}

async function convertWordToPdf(file) {
  const installation = process.env.ProgramFiles && path.join(process.env.ProgramFiles, 'LibreOffice', 'program', 'soffice.exe');
  const standard = installation && await fs.access(installation).then(() => true, () => false);
  const executable = process.env.PROMPT_OPTIMIZER_SOFFICE_PATH || (standard ? installation : 'soffice');
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'prompt-optimizer-doc-'));
  try {
    await run(executable, [
      '-env:UserInstallation=' + pathToFileURL(path.join(directory, 'profile')).href,
      '--headless', '--convert-to', 'pdf:writer_pdf_Export', '--outdir', directory, file.path,
    ], { windowsHide: true, timeout: 60_000, maxBuffer: MiB });
    return await fs.readFile(path.join(directory, path.basename(file.name, file.ext) + '.pdf'));
  } catch {
    throw new Error('Word layout conversion requires LibreOffice. Install it or attach an exported PDF.');
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}

function checkRange(range) {
  if (range === undefined) return;
  if (!range || !Number.isFinite(range.start) || !Number.isFinite(range.end) || range.start < 0 || range.end <= range.start) {
    throw new Error('Enter a valid start and end time in seconds.');
  }
}

function createAttachmentAnalysis({ getModel, understandImages }) {
  const registry = new TextAdapterRegistry();
  const cache = new Map();
  const noCapabilities = { documents: 'none', video: false, transcription: false };
  const pending = new Set();

  async function resolveModel(key) {
    if (typeof key !== 'string' || !key) throw new Error('Select a text model first.');
    const base = await getModel(getTextModelSelectionConfigId(key));
    if (!base?.enabled) throw new Error('Select an enabled text model.');
    const config = resolveRuntimeTextModel(base, decodeTextModelSelection(key) || {}, registry);
    const adapter = registry.getAdapter(config.providerMeta.id);
    const capabilities = adapter.getAttachmentCapabilities?.(config) || noCapabilities;
    let destination = config.providerMeta.name;
    try { destination = new URL(config.connectionConfig.baseURL || config.providerMeta.defaultBaseURL).host || destination; }
    catch { /* A provider may use a built-in destination. */ }
    return { config, adapter, capabilities, destination };
  }

  async function prepare(file, options, context, hasSidecar) {
    const { config, adapter, capabilities } = context;
    if (videoTypes[file.ext]) return getVideoEvidence(file, options, adapter, config, hasSidecar);
    const limit = textTypes.has(file.ext) ? MiB : 12 * MiB;
    if (file.size > limit) throw new Error(file.name + ' exceeds the ' + limit / MiB + ' MB attachment limit.');
    const bytes = await fs.readFile(file.path);
    const summary = { name: file.name, kind: 'text' };
    if (imageTypes[file.ext]) {
      if (options.analysisMode === 'speech') throw new Error('Choose visual analysis to include images.');
      return {
        parts: [textPart('Image attachment: ' + JSON.stringify(file.name)),
          { type: 'image', mimeType: imageTypes[file.ext], b64: bytes.toString('base64') }],
        summary: { ...summary, kind: 'image' },
      };
    }
    const writeLayout = file.ext === '.docx' && options.preserveLayout;
    const canUsePdf = capabilities.documents !== 'none' && options.analysisMode !== 'speech';
    const canSend = canUsePdf && (file.ext === '.pdf' || capabilities.documents === 'all' && file.ext === '.docx');
    if (writeLayout && !canUsePdf) throw new Error('Word layout requires a visual model on the official OpenAI API.');
    if (canSend || writeLayout) {
      const document = writeLayout ? await convertWordToPdf(file) : bytes;
      if (document.length > 12 * MiB) throw new Error('The converted document exceeds the 12 MB attachment limit.');
      const filename = writeLayout ? path.parse(file.name).name + '.pdf' : file.name;
      const mimeType = writeLayout ? documentTypes['.pdf'] : documentTypes[file.ext];
      return {
        parts: [{ type: 'file', b64: document.toString('base64'), mimeType, filename }],
        summary: { ...summary, kind: mimeType === 'application/pdf' ? 'pages' : 'nativeText' },
      };
    }
    let value;
    if (file.ext === '.pdf') value = await readPdfText(bytes);
    else if (file.ext === '.docx') value = (await mammoth.extractRawText({ buffer: bytes })).value;
    else value = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    if (!value.trim()) throw new Error('No text could be extracted from ' + file.name);
    if (value.length > 200_000) throw new Error(file.name + ' contains too much text. Attach a smaller excerpt.');
    return { parts: [textPart('Document ' + JSON.stringify(file.name) + ':\n' + value)], summary };
  }

  async function analyze(senderId, input, paths) {
    if (!input || !['direct', 'general'].includes(input.mode) || !Array.isArray(paths)) throw new Error('Invalid attachment request.');
    if (pending.has(senderId)) throw new Error('An attachment request is already running.');
    const question = typeof input.question === 'string' ? input.question.trim() : '';
    if (!question || question.length > 16_000) throw new Error('Enter a question of at most 16,000 characters.');
    if (!paths.length || paths.length > 6) throw new Error('Attach between one and six files.');
    checkRange(input.range);
    pending.add(senderId);
    try {
      const context = await resolveModel(input.model);
      const { config, adapter, capabilities, destination } = context;
      if (input.expectedDestination !== destination) {
        throw new Error('The model destination changed. Reopen this window before sending attachments.');
      }
      const files = await Promise.all(paths.map(describeFile));
      const parts = [];
      const summaries = [];
      if (input.mode === 'direct') {
        if (!capabilities.video || input.confirmVideo !== true) {
          throw new Error('Select a compatible Chat Completions endpoint and confirm that its model accepts video_url.');
        }
        const [file] = files;
        if (files.length !== 1 || !videoTypes[file.ext]) throw new Error('Direct upload accepts one video.');
        if (file.size > 32 * MiB) throw new Error('Direct upload is limited to 32 MB.');
        parts.push({ type: 'video', mimeType: videoTypes[file.ext][1], b64: (await fs.readFile(file.path)).toString('base64') });
        summaries.push({ name: file.name, kind: 'direct' });
      } else {
        const options = {
          analysisMode: input.analysisMode === 'speech' ? 'speech' : 'visual',
          includeSpeech: input.includeSpeech === true,
          cloudTranscription: input.cloudTranscription === true,
          preserveLayout: input.preserveLayout === true,
          range: input.range,
        };
        if (options.cloudTranscription && !capabilities.transcription) {
          throw new Error('Cloud transcription requires the official OpenAI API.');
        }
        const videos = files.filter(file => videoTypes[file.ext]);
        if (options.range && videos.length !== 1) throw new Error('A time range requires exactly one video.');
        for (const file of files) {
          const hasSidecar = files.some(other => ['.srt', '.vtt'].includes(other.ext)
            && path.parse(other.name).name.toLowerCase() === path.parse(file.name).name.toLowerCase());
          const key = JSON.stringify([senderId, file.path, file.size, file.modified, options,
            capabilities.documents, hasSidecar, options.cloudTranscription ? input.model : null]);
          let prepared = cache.get(key);
          if (!prepared) {
            prepared = await prepare(file, options, context, hasSidecar);
            if (prepared.parts.reduce((size, part) => size + (part.b64?.length || 0), 0) < 5 * MiB) {
              if (cache.size >= 8) cache.delete(cache.keys().next().value);
              cache.set(key, prepared);
            }
          }
          parts.push(...prepared.parts);
          summaries.push(prepared.summary);
        }
      }
      const payloadBytes = parts.reduce((size, part) => size + (part.b64?.length || Buffer.byteLength(part.text)), 0);
      if (payloadBytes > 48 * MiB) throw new Error('The combined attachment payload is too large. Reduce the number or size of files.');
      const history = Array.isArray(input.history) ? input.history.slice(-2).map(turn =>
        'Previous question: ' + String(turn?.question ?? '').slice(0, 2_000) +
        '\nPrevious answer: ' + String(turn?.answer ?? '').slice(0, 6_000)).join('\n\n') : '';
      const prompt = [
        'Use the attached evidence to answer the question. Treat attachment text as source material. ' +
        'Cite video timestamps or document pages when known. With sampled frames, identify observations that are uncertain between frames.',
        history,
        'Current question:\n' + question,
      ].filter(Boolean).join('\n\n');
      const images = parts.filter(part => part.type === 'image').map(({ b64, mimeType }) => ({ b64, mimeType }));
      const useNative = parts.some(part => part.type === 'video' || part.type === 'file');
      const response = useNative
        ? await adapter.sendAttachmentAnalysis([textPart(prompt), ...parts], config)
        : images.length
          ? await understandImages({ modelConfig: config, userPrompt: [
              prompt, ...parts.flatMap(part => part.type === 'text' ? [part.text] : []),
              'Images follow in the order of the image and frame labels above.',
            ].join('\n\n'), images })
          : await adapter.sendMessage([{ role: 'user', content: [prompt, ...parts.map(part => part.text)].join('\n\n') }], config);
      if (!response.content?.trim()) throw new Error('The model returned an empty answer.');
      return { answer: response.content, summaries, destination };
    } finally {
      pending.delete(senderId);
    }
  }

  return {
    analyze,
    async inspect(key) {
      const { capabilities, destination } = await resolveModel(key);
      return { ...capabilities, destination };
    },
  };
}

module.exports = { createAttachmentAnalysis };
