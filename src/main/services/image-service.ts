import { createHash, randomUUID } from 'node:crypto';
import { constants as fsConstants, promises as fs } from 'node:fs';
import path from 'node:path';
import sharp, { type Sharp } from 'sharp';
import type {
  ImageFormat,
  ImageInfo,
  OptimizationResult,
  OptimizationSettings,
  QueueItem,
  SupportedFormat,
  FileIdentity,
} from '../../shared/types.js';
import { settingsSignature } from '../../shared/settings.js';

const MAX_INPUT_BYTES = 500 * 1024 * 1024;
const MAX_INPUT_PIXELS = 100_000_000;
const SUPPORTED_FORMATS = new Set<ImageFormat>(['jpeg', 'png', 'webp', 'avif']);

const EXTENSIONS: Record<ImageFormat, string> = {
  jpeg: 'jpg',
  png: 'png',
  webp: 'webp',
  avif: 'avif',
};

const abortIfRequested = (signal?: AbortSignal): void => {
  if (signal?.aborted) {
    throw new DOMException('Optimization cancelled', 'AbortError');
  }
};

interface SharpMetadataLike {
  format?: string;
  mediaType?: string;
  compression?: string;
}

const supportedFormat = (metadata: SharpMetadataLike): SupportedFormat => {
  if (metadata.format === 'jpg') return 'jpeg';
  if (SUPPORTED_FORMATS.has(metadata.format as ImageFormat)) return metadata.format as ImageFormat;

  // libvips reports AVIF as the HEIF-family container. The media type is the
  // authoritative discriminator; the AV1 fallback covers older libvips builds
  // that omit mediaType without accepting HEIC/HEIF encoded with HEVC.
  if (metadata.format === 'heif' && (metadata.mediaType === 'image/avif' || metadata.compression === 'av1')) return 'avif';
  return 'unknown';
};

const idForPath = (filePath: string): string => createHash('sha1').update(filePath).digest('hex').slice(0, 16);

const noFollowFlag = (fsConstants as typeof fsConstants & { O_NOFOLLOW?: number }).O_NOFOLLOW ?? 0;

function fileIdentity(stat: { dev: number; ino: number; size: number; mtimeMs: number }): FileIdentity {
  return { device: stat.dev, inode: stat.ino, size: stat.size, mtimeMs: stat.mtimeMs };
}

function sameFileIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return left.device === right.device && left.inode === right.inode && left.size === right.size && left.mtimeMs === right.mtimeMs;
}

async function readFileWithIdentity(filePath: string, expectedIdentity: FileIdentity): Promise<{ data: Buffer; identity: FileIdentity }> {
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
  try {
    handle = await fs.open(filePath, fsConstants.O_RDONLY | noFollowFlag);
    const before = await handle.stat();
    if (!before.isFile()) throw new Error('The selected path is not a regular file.');
    const beforeIdentity = fileIdentity(before);
    if (!sameFileIdentity(beforeIdentity, expectedIdentity)) throw new Error('The selected image changed while it was being inspected.');
    const data = await handle.readFile();
    const afterIdentity = fileIdentity(await handle.stat());
    if (!sameFileIdentity(beforeIdentity, afterIdentity)) throw new Error('The selected image changed while it was being inspected.');
    return { data, identity: afterIdentity };
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

export async function readStableFile(filePath: string, expectedIdentity?: FileIdentity): Promise<{ data: Buffer; identity: FileIdentity }> {
  if (!expectedIdentity) throw new Error('The image result does not have a verified file identity. Reoptimize before exporting.');
  return readFileWithIdentity(filePath, expectedIdentity);
}

export async function inspectImage(filePath: string, relativePath = path.basename(filePath)): Promise<ImageInfo> {
  const absolutePath = path.resolve(filePath);
  const stat = await fs.lstat(absolutePath);
  if (stat.isSymbolicLink()) throw new Error('Symbolic-link image paths are not accepted. Choose the original file directly.');
  if (!stat.isFile()) throw new Error('The selected path is not a file.');
  if (stat.size > MAX_INPUT_BYTES) throw new Error(`The file exceeds the 500 MB safety limit.`);

  const source = await readFileWithIdentity(absolutePath, fileIdentity(stat));
  const metadata = await sharp(source.data, { limitInputPixels: MAX_INPUT_PIXELS }).metadata();
  const format = supportedFormat(metadata);
  if (format === 'unknown') {
    throw new Error(`Unsupported image format${metadata.format ? `: ${metadata.format}` : ''}.`);
  }
  if (!metadata.width || !metadata.height) throw new Error('The image has no usable dimensions.');
  if (metadata.width * metadata.height > MAX_INPUT_PIXELS) {
    throw new Error('The image exceeds the 100 megapixel safety limit.');
  }
  if (metadata.pages && metadata.pages > 1) {
    throw new Error('Animated and multi-page images are not supported in v1.0.');
  }

  return {
    id: idForPath(absolutePath),
    path: absolutePath,
    name: path.basename(absolutePath),
    relativePath,
    format,
    bytes: stat.size,
    width: metadata.width,
    height: metadata.height,
    hasAlpha: Boolean(metadata.hasAlpha),
    orientation: metadata.orientation,
    isAnimated: false,
    fileIdentity: source.identity,
  };
}

function outputExtension(format: ImageFormat): string {
  return EXTENSIONS[format];
}

function outputStem(item: QueueItem): string {
  return path.basename(item.name, path.extname(item.name));
}

function qualityCandidates(format: ImageFormat, settings: OptimizationSettings): Array<number | null> {
  // JPEG has no lossless route in Sharp/libvips. A persisted generic
  // "lossless where supported" preference must not make ordinary JPEG work
  // fail; an explicit JPEG conversion is rejected below instead.
  if ((settings.lossless && format !== 'jpeg') || format === 'png') return [null];
  if (settings.quality !== 'auto') return [settings.quality];
  if (settings.profile === 'fast') {
    return [format === 'avif' ? 50 : 80];
  }
  if (settings.profile === 'maximum') {
    if (format === 'avif') return [30, 40, 50, 60, 70, 80, 85, 90, 95];
    return [30, 40, 50, 60, 70, 75, 80, 85, 90, 95, 100];
  }
  if (format === 'avif') return [30, 40, 50, 60, 70, 80, 85, 90, 95];
  return [40, 50, 60, 70, 75, 80, 85, 90, 95];
}

function thresholdFor(item: QueueItem, format: ImageFormat, settings: OptimizationSettings): number {
  if ((settings.lossless && format !== 'jpeg') || format === 'png') return 1;
  if (settings.quality !== 'auto' || settings.profile === 'fast') return 0;
  if (item.format === 'jpeg') return settings.profile === 'maximum' ? 0.96 : 0.95;
  if (item.hasAlpha) return settings.profile === 'maximum' ? 0.995 : 0.99;
  return settings.profile === 'maximum' ? 0.99 : 0.985;
}

function transformFor(input: string | Buffer, settings: OptimizationSettings): Sharp {
  let pipeline = sharp(input, { failOn: 'warning', limitInputPixels: MAX_INPUT_PIXELS }).rotate();
  if (settings.maxWidth || settings.maxHeight) {
    pipeline = pipeline.resize({
      width: settings.maxWidth ?? undefined,
      height: settings.maxHeight ?? undefined,
      fit: 'inside',
      withoutEnlargement: true,
      fastShrinkOnLoad: false,
    });
  }
  if (settings.color === 'srgb') pipeline = pipeline.toColorspace('srgb');
  if (settings.metadata === 'preserve') pipeline = pipeline.withMetadata();
  return pipeline;
}

async function referencePixels(input: string | Buffer, settings: OptimizationSettings): Promise<{ data: Buffer; width: number; height: number }> {
  const rendered = await transformFor(input, { ...settings, metadata: 'strip' }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return { data: rendered.data, width: rendered.info.width, height: rendered.info.height };
}

function luma(data: Buffer, offset: number): number {
  return data[offset] * 0.2126 + data[offset + 1] * 0.7152 + data[offset + 2] * 0.0722;
}

function perceptualScore(reference: Buffer, candidate: Buffer): number {
  const samples = Math.min(reference.length, candidate.length) / 4;
  if (samples === 0) return 0;
  const stride = Math.max(1, Math.floor(samples / 250_000));
  let totalError = 0;
  let count = 0;
  for (let pixel = 0; pixel < samples; pixel += stride) {
    const offset = pixel * 4;
    totalError += Math.abs(luma(reference, offset) - luma(candidate, offset));
    totalError += Math.abs(reference[offset + 3] - candidate[offset + 3]) * 0.35;
    count += 1;
  }
  return Math.max(0, Math.min(1, 1 - totalError / (count * 255 * 1.35)));
}

async function encodeCandidate(
  input: string | Buffer,
  format: ImageFormat,
  quality: number | null,
  settings: OptimizationSettings,
  signal?: AbortSignal,
): Promise<{ data: Buffer; width: number; height: number }> {
  abortIfRequested(signal);
  let pipeline = transformFor(input, settings);
  if (format === 'jpeg') {
    if (quality === null) throw new Error('JPEG does not support lossless output.');
    pipeline = pipeline.jpeg({
      quality,
      mozjpeg: true,
      progressive: true,
      chromaSubsampling: '4:2:0',
    });
  } else if (format === 'png') {
    pipeline = pipeline.png({
      compressionLevel: settings.profile === 'fast' ? 3 : settings.profile === 'maximum' ? 9 : 6,
      effort: settings.profile === 'fast' ? 3 : settings.profile === 'maximum' ? 10 : 7,
    });
  } else if (format === 'webp') {
    pipeline = pipeline.webp(quality === null ? { lossless: true, effort: settings.profile === 'maximum' ? 6 : 4 } : {
      quality,
      effort: settings.profile === 'maximum' ? 6 : settings.profile === 'fast' ? 3 : 5,
      smartSubsample: true,
    });
  } else {
    pipeline = pipeline.avif(quality === null ? { lossless: true, effort: settings.profile === 'maximum' ? 8 : 4 } : {
      quality,
      effort: settings.profile === 'maximum' ? 8 : settings.profile === 'fast' ? 3 : 6,
      chromaSubsampling: '4:2:0',
    });
  }

  const encoded = await pipeline.toBuffer({ resolveWithObject: true });
  if (format !== 'png' || settings.metadata === 'preserve') {
    return { data: encoded.data, width: encoded.info.width, height: encoded.info.height };
  }

  // Sharp/libvips is the safe v1 lossless PNG path. The feasibility study proved
  // Oxipng's size advantage, but the available WASM wrapper keeps a worker/runtime
  // alive under Node's test isolation and is not suitable for this packaged build yet.
  return { data: encoded.data, width: encoded.info.width, height: encoded.info.height };
}

function candidateFormats(item: QueueItem, settings: OptimizationSettings): ImageFormat[] {
  if (settings.outputPolicy === 'preserve') {
    if (item.format === 'unknown') throw new Error('The original format is unsupported.');
    return [item.format];
  }
  if (settings.outputPolicy === 'convert') {
    if (!settings.outputFormat) throw new Error('Choose an output format before converting.');
    if (item.hasAlpha && settings.outputFormat === 'jpeg') throw new Error('JPEG cannot preserve transparency. Choose PNG, WebP, or AVIF.');
    return [settings.outputFormat];
  }
  return item.hasAlpha ? ['png', 'webp', 'avif'] : ['jpeg', 'webp', 'avif'];
}

async function writeAtomic(filePath: string, data: Buffer): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
  try {
    handle = await fs.open(temporaryPath, 'wx', 0o600);
    await handle.writeFile(data);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await fs.link(temporaryPath, filePath);
    await fs.unlink(temporaryPath);
  } finally {
    await handle?.close().catch(() => undefined);
    await fs.rm(temporaryPath, { force: true }).catch(() => undefined);
  }
}

export async function optimizeImage(
  item: QueueItem,
  settings: OptimizationSettings,
  outputDir: string,
  signal?: AbortSignal,
): Promise<OptimizationResult> {
  const startedAt = performance.now();
  const settingsHash = settingsSignature(settings);
  abortIfRequested(signal);
  const formats = candidateFormats(item, settings);
  const source = await readFileWithIdentity(item.path, item.fileIdentity ?? { device: -1, inode: -1, size: -1, mtimeMs: -1 });
  const reference = await referencePixels(source.data, settings);
  const candidates: Array<{ format: ImageFormat; quality: number | null; data: Buffer; width: number; height: number; score: number }> = [];

  for (const format of formats) {
    for (const quality of qualityCandidates(format, settings)) {
      abortIfRequested(signal);
      const encoded = await encodeCandidate(source.data, format, quality, settings, signal);
      const decoded = await sharp(encoded.data).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
      const score = format === 'png' || quality === null ? 1 : perceptualScore(reference.data, decoded.data);
      if (settings.quality === 'auto' && settings.profile !== 'fast' && score < thresholdFor(item, format, settings)) continue;
      candidates.push({ format, quality, data: encoded.data, width: encoded.width, height: encoded.height, score });
    }
  }

  const best = candidates.sort((a, b) => a.data.length - b.data.length)[0];
  if (!best) {
    return {
      status: 'failed',
      settingsHash,
      durationMs: Math.round(performance.now() - startedAt),
      message: 'No candidate met the configured quality threshold.',
    };
  }

  const explicitConversion = settings.outputPolicy === 'convert';
  if (explicitConversion && settings.outputFormat === 'jpeg' && settings.lossless) {
    throw new Error('JPEG does not support lossless output. Choose PNG, WebP, or AVIF, or disable lossless mode.');
  }
  if (!explicitConversion && best.data.length >= item.bytes) {
    return {
      status: 'no-improvement',
      outputPath: item.path,
      outputFormat: item.format === 'unknown' ? undefined : item.format,
      outputBytes: item.bytes,
      outputWidth: item.width,
      outputHeight: item.height,
      savingsPct: 0,
      qualityScore: best.score,
      settingsHash,
      outputIdentity: item.fileIdentity,
      durationMs: Math.round(performance.now() - startedAt),
      message: 'The smallest acceptable candidate was not smaller than the original; the original is retained.',
    };
  }

  const outputPath = path.join(outputDir, `${item.id}-${outputStem(item)}.${outputExtension(best.format)}`);
  await writeAtomic(outputPath, best.data);
  const outputIdentity = fileIdentity(await fs.lstat(outputPath));
  return {
    status: 'complete',
    outputPath,
    outputFormat: best.format,
    outputBytes: best.data.length,
    outputWidth: best.width,
    outputHeight: best.height,
    savingsPct: Number(((1 - best.data.length / item.bytes) * 100).toFixed(2)),
    qualityScore: Number(best.score.toFixed(4)),
    settingsHash,
    outputIdentity,
    durationMs: Math.round(performance.now() - startedAt),
    message: best.quality === null ? 'Lossless candidate selected.' : `Quality ${best.quality} candidate selected.`,
  };
}

export async function createPreviewDataUrl(filePath: string): Promise<string> {
  const data = await sharp(filePath, { limitInputPixels: MAX_INPUT_PIXELS })
    .rotate()
    .resize({ width: 1600, height: 1600, fit: 'inside', withoutEnlargement: true })
    .webp({ quality: 84, effort: 3 })
    .toBuffer();
  return `data:image/webp;base64,${data.toString('base64')}`;
}

export function outputFormatLabel(format: ImageFormat): string {
  return format === 'jpeg' ? 'JPEG' : format.toUpperCase();
}
