import { constants as fsConstants, promises as fs } from 'node:fs';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import type {
  BatchState,
  ExportReport,
  ExportRequest,
  ImageInfo,
  ImportIssue,
  ImportResponse,
  OptimizationRequest,
  QueueItem,
  QueueUpdate,
} from '../../shared/types.js';
import { inspectImage, optimizeImage, readStableFile } from './image-service.js';
import { resolveSettings, settingsSignature } from '../../shared/settings.js';

const supportedPathExtensions = new Set(['.jpg', '.jpeg', '.png', '.webp', '.avif']);
const MAX_IMPORTED_FILES = 5_000;
const MAX_DIRECTORY_DEPTH = 32;
const macOsPathAliases = new Map([
  ['/var', '/private/var'],
  ['/tmp', '/private/tmp'],
  ['/etc', '/private/etc'],
]);

interface ImportTraversal {
  fileCount: number;
}

function isAllowedMacOsPathAlias(pathValue: string): boolean {
  return macOsPathAliases.has(pathValue);
}

function isAllowedMacOsAliasPath(requestedPath: string, canonicalPath: string): boolean {
  for (const [alias, canonicalAlias] of macOsPathAliases) {
    if (requestedPath === alias || requestedPath.startsWith(`${alias}${path.sep}`)) {
      const expectedCanonical = canonicalAlias + requestedPath.slice(alias.length);
      return canonicalPath === expectedCanonical;
    }
  }
  return false;
}

function countImportedFile(traversal: ImportTraversal): void {
  traversal.fileCount += 1;
  if (traversal.fileCount > MAX_IMPORTED_FILES) throw new Error(`Import request exceeds the ${MAX_IMPORTED_FILES.toLocaleString()}-file safety limit.`);
}

async function walkDirectory(rootPath: string, currentPath = rootPath, depth = 0, traversal: ImportTraversal = { fileCount: 0 }): Promise<Array<{ path: string; relativePath: string }>> {
  if (depth > MAX_DIRECTORY_DEPTH) throw new Error(`Folder nesting exceeds the ${MAX_DIRECTORY_DEPTH}-level safety limit.`);
  const entries = await fs.readdir(currentPath, { withFileTypes: true });
  const files: Array<{ path: string; relativePath: string }> = [];
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    const absolutePath = path.join(currentPath, entry.name);
    if (entry.isSymbolicLink()) throw new Error('Folder import contains a symbolic-link path and was rejected.');
    if (entry.isDirectory()) {
      files.push(...await walkDirectory(rootPath, absolutePath, depth + 1, traversal));
    } else if (entry.isFile()) {
      countImportedFile(traversal);
      files.push({ path: absolutePath, relativePath: path.relative(rootPath, absolutePath) });
    }
  }
  return files;
}

export async function importPaths(paths: string[]): Promise<ImportResponse> {
  const candidates: Array<{ path: string; relativePath: string }> = [];
  const issues: ImportIssue[] = [];
  const traversal: ImportTraversal = { fileCount: 0 };
  for (const selectedPath of paths) {
    try {
      const stat = await fs.lstat(selectedPath);
      if (stat.isSymbolicLink()) throw new Error('Symbolic-link import paths are not accepted. Choose the original file or folder directly.');
      if (stat.isDirectory()) {
        candidates.push(...await walkDirectory(selectedPath, selectedPath, 0, traversal));
      } else {
        countImportedFile(traversal);
        candidates.push({ path: selectedPath, relativePath: path.basename(selectedPath) });
      }
    } catch (error) {
      issues.push({ path: selectedPath, message: error instanceof Error ? error.message : 'Could not read the selected path.' });
    }
  }

  const items: QueueItem[] = [];
  const seen = new Set<string>();
  for (const candidate of candidates) {
    const absolutePath = path.resolve(candidate.path);
    if (seen.has(absolutePath)) continue;
    seen.add(absolutePath);
    if (!supportedPathExtensions.has(path.extname(absolutePath).toLowerCase())) {
      issues.push({ path: absolutePath, message: 'Unsupported file type. lucifold v1.0 supports JPEG, PNG, WebP, and AVIF.' });
      continue;
    }
    try {
      const info = await inspectImage(absolutePath, candidate.relativePath);
      items.push({ ...info, result: undefined, progress: 0 });
    } catch (error) {
      issues.push({ path: absolutePath, message: error instanceof Error ? error.message : 'Could not decode the image.' });
    }
  }
  return { items, issues };
}

function isContainedPath(child: string, parent: string, allowEqual = false): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return (allowEqual && relative === '') || (Boolean(relative) && !relative.startsWith('..') && !path.isAbsolute(relative));
}

async function assertNoSymlinkAncestors(absolutePath: string): Promise<void> {
  const root = path.parse(absolutePath).root;
  let current = root;
  for (const component of absolutePath.slice(root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, component);
    try {
      const stat = await fs.lstat(current);
      if (stat.isSymbolicLink()) {
        if (!isAllowedMacOsPathAlias(current)) throw new Error('The selected export destination contains a symbolic-link path.');
        continue;
      }
      if (!stat.isDirectory()) throw new Error('The selected export destination contains a non-directory path component.');
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return;
      throw error;
    }
  }
}

type DirectoryHandle = Awaited<ReturnType<typeof fs.open>>;

interface TrustedDestination {
  path: string;
  handle: DirectoryHandle;
}

async function openTrustedDestination(directoryPath: string): Promise<TrustedDestination> {
  const resolved = path.resolve(directoryPath);
  await assertNoSymlinkAncestors(resolved);
  await fs.mkdir(resolved, { recursive: true, mode: 0o700 });
  const realPath = await fs.realpath(resolved);
  if (realPath !== resolved && !isAllowedMacOsAliasPath(resolved, realPath)) throw new Error('The selected export destination contains a symbolic-link path.');
  const stat = await fs.lstat(resolved);
  if (stat.isSymbolicLink()) throw new Error('The selected export destination contains a symbolic-link path.');
  if (!stat.isDirectory()) throw new Error('The selected export destination is not a directory.');
  const expected = await fs.stat(realPath);
  const noFollowFlag = (fsConstants as typeof fsConstants & { O_NOFOLLOW?: number }).O_NOFOLLOW ?? 0;
  const directoryFlag = (fsConstants as typeof fsConstants & { O_DIRECTORY?: number }).O_DIRECTORY ?? 0;
  const handle = await fs.open(realPath, fsConstants.O_RDONLY | noFollowFlag | directoryFlag);
  const actual = await handle.stat();
  if (!actual.isDirectory() || actual.dev !== expected.dev || actual.ino !== expected.ino) {
    await handle.close().catch(() => undefined);
    throw new Error('The export destination changed while it was being authorized.');
  }
  return { path: realPath, handle };
}

function nextCollisionPath(requestedPath: string, index: number): string {
  const extension = path.extname(requestedPath);
  const stem = path.basename(requestedPath, extension);
  return path.join(path.dirname(requestedPath), `${stem} (${index})${extension}`);
}

const NATIVE_PUBLISH_COLLISION = 17;

function nativePublisherCandidates(): string[] {
  const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.resolve(moduleDirectory, '../../../native/lucifold-export-publisher'),
    path.resolve(moduleDirectory, '../../../dist/native/lucifold-export-publisher'),
  ];
  const marker = `${path.sep}app.asar${path.sep}`;
  return candidates.flatMap((candidate) => candidate.includes(marker)
    ? [candidate.replace(marker, `${path.sep}app.asar.unpacked${path.sep}`), candidate]
    : [candidate]);
}

async function resolveNativePublisher(): Promise<string> {
  for (const candidate of nativePublisherCandidates()) {
    try {
      await fs.access(candidate, fsConstants.X_OK);
      return candidate;
    } catch {
      // Try the source-tree or packaged native location next.
    }
  }
  throw new Error('The race-resistant export publisher is unavailable in this build.');
}

async function runNativePublisher(publisher: string, sourcePath: string, relativePath: string, destinationRealPath: string, destinationFd: number): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(publisher, [sourcePath, relativePath, destinationRealPath], { stdio: ['ignore', 'pipe', 'pipe', destinationFd] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout?.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.stderr?.on('data', (chunk: Buffer) => stderr.push(chunk));
    child.once('error', reject);
    child.once('close', (code) => resolve({ code: code ?? 1, stdout: Buffer.concat(stdout).toString().trim(), stderr: Buffer.concat(stderr).toString().trim() }));
  });
}

async function publishWithoutReplacement(temporaryPath: string, requestedPath: string, destinationRealPath: string, destinationHandle: DirectoryHandle): Promise<string> {
  const publisher = await resolveNativePublisher();
  let candidate = requestedPath;
  for (let index = 0; index <= MAX_IMPORTED_FILES; index += 1) {
    const relativeCandidate = path.relative(destinationRealPath, candidate).split(path.sep).join('/');
    if (!relativeCandidate || relativeCandidate.startsWith('../') || path.isAbsolute(relativeCandidate)) throw new Error('Output path escapes the selected destination.');
    const result = await runNativePublisher(publisher, temporaryPath, relativeCandidate, destinationRealPath, destinationHandle.fd);
    if (result.code === 0) {
      const publishedPath = result.stdout;
      if (!publishedPath || !path.isAbsolute(publishedPath) || !isContainedPath(publishedPath, destinationRealPath)) throw new Error('The native publisher returned an invalid export path.');
      return publishedPath;
    }
    if (result.code === NATIVE_PUBLISH_COLLISION) {
      candidate = index === 0 ? nextCollisionPath(requestedPath, 1) : nextCollisionPath(requestedPath, index + 1);
      continue;
    }
    throw new Error(result.stderr || 'The export could not be published safely.');
  }
  throw new Error('Too many files share the same export name.');
}

async function writeAndPublish(data: Buffer, requestedPath: string, destinationRealPath: string, destinationHandle: DirectoryHandle): Promise<string> {
  const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'lucifold-export-'));
  await fs.chmod(temporaryRoot, 0o700);
  const temporaryPath = path.join(temporaryRoot, `source-${randomUUID()}.tmp`);
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
  try {
    handle = await fs.open(temporaryPath, 'wx', 0o600);
    await handle.writeFile(data);
    await handle.sync();
    await handle.close();
    handle = undefined;
    return await publishWithoutReplacement(temporaryPath, requestedPath, destinationRealPath, destinationHandle);
  } finally {
    await handle?.close().catch(() => undefined);
    await fs.rm(temporaryRoot, { recursive: true, force: true }).catch(() => undefined);
  }
}

export class QueueManager {
  private readonly items = new Map<string, QueueItem>();
  private readonly listeners = new Set<(update: QueueUpdate) => void>();
  private activeController: AbortController | null = null;
  private activeBatch: BatchState = { id: '', status: 'idle', completed: 0, total: 0, failed: 0 };

  subscribe(listener: (update: QueueUpdate) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  getItems(): QueueItem[] {
    return [...this.items.values()];
  }

  getBatch(): BatchState {
    return { ...this.activeBatch };
  }

  addItems(items: QueueItem[]): QueueItem[] {
    for (const item of items) {
      if (!this.items.has(item.path)) this.items.set(item.path, item);
    }
    return this.getItems();
  }

  removeItems(ids: string[]): QueueItem[] {
    for (const id of ids) {
      const item = [...this.items.values()].find((candidate) => candidate.id === id);
      if (item) this.items.delete(item.path);
    }
    return this.getItems();
  }

  clear(): QueueItem[] {
    this.items.clear();
    return [];
  }

  markNeedsReoptimization(ids?: string[]): QueueItem[] {
    const targets = ids?.length ? new Set(ids) : null;
    for (const item of this.items.values()) {
      if (targets && !targets.has(item.id)) continue;
      if (item.result?.status === 'complete' || item.result?.status === 'no-improvement') {
        item.result = { ...item.result, status: 'needs-reoptimization', message: 'Settings changed; run optimization again.' };
        this.items.set(item.path, item);
        this.emit(item);
      }
    }
    return this.getItems();
  }

  onUpdate(listener: (update: QueueUpdate) => void): () => void {
    return this.subscribe(listener);
  }

  private emit(item: QueueItem): void {
    const update: QueueUpdate = { item: { ...item }, batch: this.getBatch() };
    for (const listener of this.listeners) listener(update);
  }

  async start(request: OptimizationRequest, concurrency = 2): Promise<BatchState> {
    if (this.activeBatch.status === 'processing') throw new Error('A batch is already processing.');
    const overrides = request.overrides ?? {};
    const selected = this.getItems().filter((item) => {
      if (!request.ids.includes(item.id)) return false;
      const effectiveSettings = resolveSettings(request.defaults, overrides[item.id]);
      const current = item.result?.status === 'complete' || item.result?.status === 'no-improvement';
      return !(current && item.result?.settingsHash === settingsSignature(effectiveSettings));
    });
    if (selected.length === 0) throw new Error('Select at least one image that needs optimization.');

    const batchId = randomUUID();
    this.activeController = new AbortController();
    this.activeBatch = { id: batchId, status: 'processing', completed: 0, total: selected.length, failed: 0, startedAt: new Date().toISOString() };
    const { app } = await import('electron');
    const outputDir = path.join(app.getPath('temp'), 'lucifold', 'results', batchId);
    await fs.mkdir(outputDir, { recursive: true });
    let cursor = 0;
    const worker = async (): Promise<void> => {
      while (true) {
        if (this.activeController?.signal.aborted) return;
        const item = selected[cursor++];
        if (!item) return;
        const effectiveSettings = resolveSettings(request.defaults, overrides[item.id]);
        item.settingsOverride = overrides[item.id] ? { ...overrides[item.id] } : undefined;
        item.result = { status: 'processing' };
        item.progress = undefined;
        this.items.set(item.path, item);
        this.emit(item);
        try {
          item.result = await optimizeImage(item, effectiveSettings, outputDir, this.activeController?.signal);
          item.progress = 1;
          if (item.result.status === 'failed') this.activeBatch.failed += 1;
        } catch (error) {
          if (error instanceof DOMException && error.name === 'AbortError') {
            item.result = { status: 'cancelled', message: 'Optimization cancelled.' };
          } else {
            item.result = { status: 'failed', message: error instanceof Error ? error.message : 'Optimization failed.' };
            this.activeBatch.failed += 1;
          }
          item.progress = 0;
        }
        this.activeBatch.completed += 1;
        this.items.set(item.path, item);
        this.emit(item);
      }
    };
    const workerCount = Math.max(1, Math.min(Math.floor(concurrency), selected.length));
    await Promise.all(Array.from({ length: workerCount }, () => worker()));
    if (this.activeController.signal.aborted) {
      for (const item of selected) {
        if (!item.result || item.result.status === 'queued' || item.result.status === 'processing') {
          item.result = { status: 'cancelled', message: 'Optimization cancelled.' };
          item.progress = 0;
          this.activeBatch.completed += 1;
          this.items.set(item.path, item);
          this.emit(item);
        }
      }
      this.activeBatch.status = 'cancelled';
    } else {
      this.activeBatch.status = 'complete';
    }
    this.activeController = null;
    return this.getBatch();
  }

  cancel(): void {
    this.activeController?.abort();
  }

  shutdown(): void {
    this.activeController?.abort();
  }

  async exportResults(request: ExportRequest): Promise<ExportReport> {
    const destination = path.resolve(request.destination);
    const trustedDestination = await openTrustedDestination(destination);
    const exported: Array<{ itemId: string; path: string }> = [];
    const failures: Array<{ itemId: string; message: string }> = [];
    try {
      for (const itemId of request.itemIds) {
        const item = this.getItems().find((candidate) => candidate.id === itemId);
        if (!item?.result?.outputPath || !['complete', 'no-improvement'].includes(item.result.status)) {
          failures.push({ itemId, message: 'No eligible optimization result is available for export.' });
          continue;
        }
        const expectedHash = request.expectedSettingsHashByItem?.[itemId];
        if (expectedHash && item.result.settingsHash !== expectedHash) {
          failures.push({ itemId, message: 'The result is stale because its optimization settings changed. Reoptimize before exporting.' });
          continue;
        }
        try {
          const sourcePath = item.result.outputPath;
          const preserveHierarchy = request.preserveHierarchyByItem?.[itemId] ?? request.preserveHierarchy;
          const relative = preserveHierarchy ? item.relativePath : path.basename(item.name);
          if (relative.split(/[\\/]/).includes('..') || path.isAbsolute(relative)) throw new Error('Unsafe relative output path.');
          const requested = path.resolve(trustedDestination.path, relative);
          if (!isContainedPath(requested, trustedDestination.path)) throw new Error('Output path escapes the selected destination.');
          const data = (await readStableFile(sourcePath, item.result.outputIdentity)).data;
          const finalPath = await writeAndPublish(data, requested, trustedDestination.path, trustedDestination.handle);
          exported.push({ itemId, path: finalPath });
        } catch (error) {
          failures.push({ itemId, message: error instanceof Error ? error.message : 'Export failed.' });
        }
      }
    } finally {
      await trustedDestination.handle.close().catch(() => undefined);
    }
    return { exported, failures };
  }
}
