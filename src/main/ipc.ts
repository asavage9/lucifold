import { app, dialog, ipcMain, shell, type BrowserWindow, type IpcMainInvokeEvent } from 'electron';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { DEFAULT_APP_SETTINGS, DEFAULT_SETTINGS, type AppSettings, type ExportRequest, type OptimizationRequest, type Preset } from '../shared/types.js';
import { importPaths, QueueManager } from './services/queue-manager.js';
import { JsonStore } from './services/settings-store.js';
import { createPreviewDataUrl } from './services/image-service.js';
import { defaultPresets } from '../shared/presets.js';
import { APPROVED_LUCIFOLD_ORIGIN, isApprovedTag, readUpdateStatus, UpdateService } from './services/update-service.js';
import { assertAuthorizedRendererFrame, isAllowedRendererUrl } from './ipc-security.js';

const queue = new QueueManager();
let settingsStore: JsonStore<AppSettings>;
let presetStore: JsonStore<{ presets: Preset[] }>;
let activeWindow: BrowserWindow | null = null;
let handlersRegistered = false;
let updateService: UpdateService;

export function registerIpc(mainWindow: BrowserWindow): void {
  activeWindow = mainWindow;
  if (handlersRegistered) return;
  handlersRegistered = true;
  settingsStore = new JsonStore(app.getPath('userData'), 'settings.json', DEFAULT_APP_SETTINGS);
  presetStore = new JsonStore(app.getPath('userData'), 'presets.json', { presets: [] });
  updateService = new UpdateService({
    currentVersion: app.getVersion(),
    packaged: app.isPackaged,
    currentAppPath: app.isPackaged ? bundlePathFromExecutable(process.execPath) : undefined,
    currentExecutable: process.execPath,
    userDataPath: app.getPath('userData'),
    tempPath: app.getPath('temp'),
    sourceCandidates: [],
    expectedOrigin: APPROVED_LUCIFOLD_ORIGIN,
  });

  queue.onUpdate((update) => {
    if (activeWindow && !activeWindow.isDestroyed()) activeWindow.webContents.send('queue:update', update);
  });

  registerHandler('app:get-initial-state', async () => ({
    items: queue.getItems(),
    batch: queue.getBatch(),
    settings: await settingsStore.read(),
    presets: await loadPresets(),
  }));
  registerHandler('app:get-info', async () => ({
    version: app.getVersion(),
    packaged: app.isPackaged,
    lastUpdateStatus: await readUpdateStatus(path.join(app.getPath('userData'), 'update-status.json')),
  }));

  registerHandler('dialog:choose-files', async () => {
    const options = {
      title: 'Add Images',
      properties: ['openFile', 'multiSelections'] as Array<'openFile' | 'multiSelections'>,
      filters: [{ name: 'Supported images', extensions: ['jpg', 'jpeg', 'png', 'webp', 'avif'] }],
    };
    const result = activeWindow ? await dialog.showOpenDialog(activeWindow, options) : await dialog.showOpenDialog(options);
    return result.canceled ? [] : result.filePaths;
  });

  registerHandler('dialog:choose-folder', async () => {
    const options = { title: 'Add Folder', properties: ['openDirectory'] as Array<'openDirectory'> };
    const result = activeWindow ? await dialog.showOpenDialog(activeWindow, options) : await dialog.showOpenDialog(options);
    return result.canceled ? null : result.filePaths[0] ?? null;
  });

  registerHandler('import:paths', async (_event, paths: unknown) => {
    const response = await importPaths(assertAbsoluteStringArray(paths, 'import paths'));
    return { ...response, items: queue.addItems(response.items) };
  });

  registerHandler('queue:get', () => ({ items: queue.getItems(), batch: queue.getBatch() }));
  registerHandler('queue:remove', (_event, ids: unknown) => queue.removeItems(assertStringArray(ids, 'queue item IDs')));
  registerHandler('queue:clear', () => queue.clear());
  registerHandler('queue:invalidate', (_event, ids: unknown) => queue.markNeedsReoptimization(ids === undefined ? undefined : assertStringArray(ids, 'queue item IDs')));
  registerHandler('queue:optimize', async (_event, request: unknown) => queue.start(assertOptimizationRequest(request), (await settingsStore.read()).concurrency));
  registerHandler('queue:retry', async (_event, request: unknown) => queue.start(assertOptimizationRequest(request), (await settingsStore.read()).concurrency));
  registerHandler('queue:cancel', () => queue.cancel());

  registerHandler('preview:get', async (_event, itemId: unknown, kind: unknown) => {
    assertString(itemId, 'image ID');
    if (kind !== 'source' && kind !== 'output') throw new Error('The preview kind is invalid.');
    const item = queue.getItems().find((candidate) => candidate.id === itemId);
    if (!item) throw new Error('Image is no longer in the queue.');
    const filePath = kind === 'output' ? item.result?.outputPath : item.path;
    if (!filePath) return null;
    return createPreviewDataUrl(filePath);
  });

  registerHandler('export:choose-destination', async () => {
    const stored = await settingsStore.read();
    const defaultPath = stored.defaultExportFolder ?? path.join(app.getPath('pictures'), 'lucifold-output');
    const options = { title: 'Choose Export Folder', defaultPath, properties: ['openDirectory', 'createDirectory'] as Array<'openDirectory' | 'createDirectory'> };
    const result = activeWindow ? await dialog.showOpenDialog(activeWindow, options) : await dialog.showOpenDialog(options);
    return result.canceled ? null : result.filePaths[0] ?? null;
  });

  registerHandler('export:items', async (_event, request: unknown) => queue.exportResults(assertExportRequest(request)));
  registerHandler('export:show-in-finder', async (_event, filePath: unknown) => {
    assertString(filePath, 'export path');
    if (!path.isAbsolute(filePath)) return { ok: false, message: 'Only an absolute local export path can be shown in Finder.' };
    try {
      const stat = await fs.stat(filePath);
      if (!stat.isFile()) return { ok: false, message: 'The exported file no longer exists.' };
      shell.showItemInFolder(filePath);
      return { ok: true, message: 'Opened the exported file in Finder.' };
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : 'The exported file could not be shown in Finder.' };
    }
  });

  registerHandler('settings:read', () => settingsStore.read());
  registerHandler('settings:write', async (_event, value: unknown) => {
    const current = await settingsStore.read();
    const validated = assertAppSettings(value);
    await settingsStore.write({ ...DEFAULT_APP_SETTINGS, ...validated, updateSourcePath: current.updateSourcePath });
    return settingsStore.read();
  });

  registerHandler('presets:list', async () => loadPresets());
  registerHandler('presets:save', async (_event, value: unknown) => {
    const preset = assertPreset(value);
    const current = await presetStore.read();
    const presets = current.presets.filter((candidate) => candidate.id !== preset.id);
    presets.push(preset);
    await presetStore.write({ presets });
    return presets;
  });
  registerHandler('presets:delete', async (_event, id: unknown) => {
    assertString(id, 'preset ID');
    const current = await presetStore.read();
    const presets = current.presets.filter((preset) => preset.id !== id);
    await presetStore.write({ presets });
    return presets;
  });

  registerHandler('update:choose-source', async () => {
    const options = { title: 'Choose lucifold source repository', properties: ['openDirectory'] as Array<'openDirectory'> };
    const result = activeWindow ? await dialog.showOpenDialog(activeWindow, options) : await dialog.showOpenDialog(options);
    if (result.canceled || !result.filePaths[0]) return { ok: false, message: 'Repository selection cancelled.' };
    const validation = await updateService.validateSourceRepository(result.filePaths[0]);
    if (!validation.ok) return validation;
    const settings = await settingsStore.read();
    await settingsStore.write({ ...settings, updateSourcePath: validation.path });
    return validation;
  });

  registerHandler('update:check', async (event) => {
    event.sender.send('update:progress', { phase: 'checking', percent: 5, message: 'Checking the configured source repository and approved tags…' });
    const settings = await settingsStore.read();
    return updateService.checkForUpdates(settings.updateSourcePath);
  });

  registerHandler('update:install', async (event, tag: unknown) => {
    assertString(tag, 'update tag');
    if (!isApprovedTag(tag)) throw new Error('The selected update tag is not an approved stable version tag.');
    const settings = await settingsStore.read();
    const response = await updateService.prepareAndInstall(tag, settings.updateSourcePath, (progress) => event.sender.send('update:progress', progress));
    if (response.accepted) setTimeout(() => app.quit(), 150);
    return response;
  });

  registerHandler('update:status', () => readUpdateStatus(path.join(app.getPath('userData'), 'update-status.json')));
  app.on('before-quit', () => queue.shutdown());
}

async function loadPresets(): Promise<Preset[]> {
  const current = await presetStore.read();
  if (current.presets.length > 0) return current.presets;
  const seeded = defaultPresets();
  await presetStore.write({ presets: seeded });
  return seeded;
}

export function getQueueManager(): QueueManager {
  return queue;
}

function bundlePathFromExecutable(executablePath: string): string | undefined {
  const parts = path.resolve(executablePath).split(path.sep);
  for (let index = parts.length - 1; index >= 0; index -= 1) {
    if (parts[index].endsWith('.app')) return parts.slice(0, index + 1).join(path.sep) || path.sep;
  }
  return undefined;
}

type IpcHandler = (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown | Promise<unknown>;

function registerHandler(channel: string, handler: IpcHandler): void {
  ipcMain.handle(channel, async (event, ...args) => {
    assertTrustedRenderer(event);
    return handler(event, ...args);
  });
}

function assertTrustedRenderer(event: IpcMainInvokeEvent): void {
  assertAuthorizedRendererFrame(activeWindow, event, isTrustedRendererUrl);
}

function isTrustedRendererUrl(value: string): boolean {
  return isAllowedRendererUrl(value, path.resolve(app.getAppPath(), 'dist', 'renderer', 'index.html'), app.isPackaged);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function assertString(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 16_384) throw new Error(`The ${label} is invalid.`);
}

function assertStringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.length > 10_000) throw new Error(`The ${label} are invalid.`);
  for (const item of value) assertString(item, label);
  return value;
}

function assertAbsoluteStringArray(value: unknown, label: string): string[] {
  const strings = assertStringArray(value, label);
  if (strings.some((item) => !path.isAbsolute(item))) throw new Error(`The ${label} must be absolute local paths.`);
  return strings;
}

function isOptimizationSettings(value: unknown, partial = false): boolean {
  if (!isRecord(value)) return false;
  const required = ['profile', 'outputPolicy', 'outputFormat', 'quality', 'lossless', 'maxWidth', 'maxHeight', 'metadata', 'color', 'preserveAspect', 'preserveFolderHierarchy'];
  if (!partial && required.some((key) => !(key in value))) return false;
  if ('profile' in value && !['fast', 'balanced', 'maximum'].includes(String(value.profile))) return false;
  if ('outputPolicy' in value && !['preserve', 'convert', 'smart'].includes(String(value.outputPolicy))) return false;
  if ('outputFormat' in value && value.outputFormat !== null && !['jpeg', 'png', 'webp', 'avif'].includes(String(value.outputFormat))) return false;
  if ('quality' in value && value.quality !== 'auto' && (!Number.isInteger(value.quality) || Number(value.quality) < 1 || Number(value.quality) > 100)) return false;
  if ('lossless' in value && typeof value.lossless !== 'boolean') return false;
  for (const key of ['maxWidth', 'maxHeight']) {
    if (key in value && value[key] !== null && (!Number.isInteger(value[key]) || Number(value[key]) < 1 || Number(value[key]) > 100_000)) return false;
  }
  if ('metadata' in value && !['strip', 'preserve'].includes(String(value.metadata))) return false;
  if ('color' in value && !['srgb', 'preserve'].includes(String(value.color))) return false;
  if ('preserveAspect' in value && typeof value.preserveAspect !== 'boolean') return false;
  if ('preserveFolderHierarchy' in value && typeof value.preserveFolderHierarchy !== 'boolean') return false;
  return true;
}

function assertOptimizationRequest(value: unknown): OptimizationRequest {
  if (!isRecord(value) || !Array.isArray(value.ids) || !isOptimizationSettings(value.defaults)) throw new Error('The optimization request is invalid.');
  const ids = assertStringArray(value.ids, 'optimization item IDs');
  if (!isRecord(value.overrides)) throw new Error('The optimization overrides are invalid.');
  for (const override of Object.values(value.overrides)) {
    if (!isOptimizationSettings(override, true)) throw new Error('An optimization override is invalid.');
  }
  return { ids, defaults: value.defaults as OptimizationRequest['defaults'], overrides: value.overrides as OptimizationRequest['overrides'] };
}

function assertExportRequest(value: unknown): ExportRequest {
  if (!isRecord(value) || !Array.isArray(value.itemIds) || typeof value.destination !== 'string' || !path.isAbsolute(value.destination) || typeof value.preserveHierarchy !== 'boolean') throw new Error('The export request is invalid.');
  const itemIds = assertStringArray(value.itemIds, 'export item IDs');
  if (value.preserveHierarchyByItem !== undefined && !isRecord(value.preserveHierarchyByItem)) throw new Error('The export hierarchy preferences are invalid.');
  if (isRecord(value.preserveHierarchyByItem)) {
    for (const preference of Object.values(value.preserveHierarchyByItem)) {
      if (typeof preference !== 'boolean') throw new Error('The export hierarchy preferences are invalid.');
    }
  }
  if (value.expectedSettingsHashByItem !== undefined && !isRecord(value.expectedSettingsHashByItem)) throw new Error('The export settings hashes are invalid.');
  if (isRecord(value.expectedSettingsHashByItem)) {
    for (const hash of Object.values(value.expectedSettingsHashByItem)) assertString(hash, 'export settings hash');
  }
  return { itemIds, destination: value.destination, preserveHierarchy: value.preserveHierarchy, preserveHierarchyByItem: value.preserveHierarchyByItem as Record<string, boolean> | undefined, expectedSettingsHashByItem: value.expectedSettingsHashByItem as Record<string, string> | undefined };
}

function assertAppSettings(value: unknown): AppSettings {
  if (!isRecord(value) || !['dark', 'light', 'system'].includes(String(value.theme)) || !Number.isInteger(value.concurrency) || Number(value.concurrency) < 1 || Number(value.concurrency) > 16 || ![ 'preserve', 'convert', 'smart' ].includes(String(value.lastOutputPolicy)) || !['fast', 'balanced', 'maximum'].includes(String(value.lastProfile)) || !isOptimizationSettings(value.defaultOptimization)) throw new Error('The application settings are invalid.');
  if (value.defaultExportFolder !== null && (typeof value.defaultExportFolder !== 'string' || !path.isAbsolute(value.defaultExportFolder))) throw new Error('The default export folder is invalid.');
  return value as unknown as AppSettings;
}

function assertPreset(value: unknown): Preset {
  if (!isRecord(value) || typeof value.id !== 'string' || typeof value.name !== 'string' || typeof value.description !== 'string' || typeof value.createdAt !== 'string' || typeof value.updatedAt !== 'string' || !isOptimizationSettings(value.settings)) throw new Error('The preset is invalid.');
  return value as unknown as Preset;
}
