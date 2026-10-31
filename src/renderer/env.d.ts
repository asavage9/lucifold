import type { AppInfo, AppSettings, BatchState, ExportReport, ExportRequest, ImportResponse, OptimizationRequest, Preset, QueueItem, QueueUpdate, UpdateCheckResult, UpdateInstallResponse, UpdateProgress } from '../shared/types';

interface LucifoldAPI {
  getInitialState(): Promise<{ items: QueueItem[]; batch: BatchState; settings: AppSettings; presets: Preset[] }>;
  getAppInfo(): Promise<AppInfo>;
  chooseFiles(): Promise<string[]>;
  chooseFolder(): Promise<string | null>;
  importPaths(paths: string[]): Promise<ImportResponse>;
  getQueue(): Promise<{ items: QueueItem[]; batch: BatchState }>;
  removeItems(ids: string[]): Promise<QueueItem[]>;
  clearQueue(): Promise<QueueItem[]>;
  invalidate(ids?: string[]): Promise<QueueItem[]>;
  optimize(request: OptimizationRequest): Promise<BatchState>;
  retry(request: OptimizationRequest): Promise<BatchState>;
  cancel(): Promise<void>;
  getPreview(itemId: string, kind: 'source' | 'output'): Promise<string | null>;
  chooseExportDestination(): Promise<string | null>;
  exportItems(request: ExportRequest): Promise<ExportReport>;
  showInFinder(filePath: string): Promise<{ ok: boolean; message: string }>;
  readSettings(): Promise<AppSettings>;
  writeSettings(settings: AppSettings): Promise<AppSettings>;
  listPresets(): Promise<Preset[]>;
  savePreset(preset: Preset): Promise<Preset[]>;
  deletePreset(id: string): Promise<Preset[]>;
  chooseUpdateSource(): Promise<{ ok: boolean; path?: string; message: string }>;
  checkForUpdates(): Promise<UpdateCheckResult>;
  installUpdate(tag: string): Promise<UpdateInstallResponse>;
  readUpdateStatus(): Promise<unknown>;
  onUpdateProgress(callback: (progress: UpdateProgress) => void): () => void;
  onQueueUpdate(callback: (update: QueueUpdate) => void): () => void;
}

declare global {
  interface Window {
    lucifold: LucifoldAPI;
  }
}

export {};
