import { contextBridge, ipcRenderer } from 'electron';
import type { AppInfo, AppSettings, ExportReport, ExportRequest, ImportResponse, OptimizationRequest, Preset, QueueUpdate, UpdateCheckResult, UpdateInstallResponse, UpdateProgress } from '../shared/types.js';

const api = {
  getInitialState: () => ipcRenderer.invoke('app:get-initial-state'),
  getAppInfo: () => ipcRenderer.invoke('app:get-info') as Promise<AppInfo>,
  chooseFiles: () => ipcRenderer.invoke('dialog:choose-files') as Promise<string[]>,
  chooseFolder: () => ipcRenderer.invoke('dialog:choose-folder') as Promise<string | null>,
  importPaths: (paths: string[]) => ipcRenderer.invoke('import:paths', paths) as Promise<ImportResponse>,
  getQueue: () => ipcRenderer.invoke('queue:get'),
  removeItems: (ids: string[]) => ipcRenderer.invoke('queue:remove', ids),
  clearQueue: () => ipcRenderer.invoke('queue:clear'),
  invalidate: (ids?: string[]) => ipcRenderer.invoke('queue:invalidate', ids),
  optimize: (request: OptimizationRequest) => ipcRenderer.invoke('queue:optimize', request),
  retry: (request: OptimizationRequest) => ipcRenderer.invoke('queue:retry', request),
  cancel: () => ipcRenderer.invoke('queue:cancel'),
  getPreview: (itemId: string, kind: 'source' | 'output') => ipcRenderer.invoke('preview:get', itemId, kind) as Promise<string | null>,
  chooseExportDestination: () => ipcRenderer.invoke('export:choose-destination') as Promise<string | null>,
  exportItems: (request: ExportRequest) => ipcRenderer.invoke('export:items', request) as Promise<ExportReport>,
  showInFinder: (filePath: string) => ipcRenderer.invoke('export:show-in-finder', filePath) as Promise<{ ok: boolean; message: string }>,
  readSettings: () => ipcRenderer.invoke('settings:read') as Promise<AppSettings>,
  writeSettings: (settings: AppSettings) => ipcRenderer.invoke('settings:write', settings) as Promise<AppSettings>,
  listPresets: () => ipcRenderer.invoke('presets:list') as Promise<Preset[]>,
  savePreset: (preset: Preset) => ipcRenderer.invoke('presets:save', preset) as Promise<Preset[]>,
  deletePreset: (id: string) => ipcRenderer.invoke('presets:delete', id) as Promise<Preset[]>,
  chooseUpdateSource: () => ipcRenderer.invoke('update:choose-source') as Promise<{ ok: boolean; path?: string; message: string }>,
  checkForUpdates: () => ipcRenderer.invoke('update:check') as Promise<UpdateCheckResult>,
  installUpdate: (tag: string) => ipcRenderer.invoke('update:install', tag) as Promise<UpdateInstallResponse>,
  readUpdateStatus: () => ipcRenderer.invoke('update:status'),
  onUpdateProgress: (callback: (progress: UpdateProgress) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, progress: UpdateProgress) => callback(progress);
    ipcRenderer.on('update:progress', listener);
    return () => ipcRenderer.removeListener('update:progress', listener);
  },
  onQueueUpdate: (callback: (update: QueueUpdate) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, update: QueueUpdate) => callback(update);
    ipcRenderer.on('queue:update', listener);
    return () => ipcRenderer.removeListener('queue:update', listener);
  },
};

contextBridge.exposeInMainWorld('lucifold', api);
