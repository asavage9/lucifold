export type ImageFormat = 'jpeg' | 'png' | 'webp' | 'avif';
export type SupportedFormat = ImageFormat | 'unknown';
export type OptimizationProfile = 'fast' | 'balanced' | 'maximum';
export type OutputPolicy = 'preserve' | 'convert' | 'smart';
export type MetadataPolicy = 'strip' | 'preserve';
export type ColorPolicy = 'srgb' | 'preserve';
export type ItemStatus = 'queued' | 'processing' | 'complete' | 'no-improvement' | 'failed' | 'cancelled' | 'needs-reoptimization';
export type AppView = 'optimize' | 'presets' | 'compare' | 'settings';

export interface ImageInfo {
  id: string;
  path: string;
  name: string;
  relativePath: string;
  format: SupportedFormat;
  bytes: number;
  width: number;
  height: number;
  hasAlpha: boolean;
  orientation?: number;
  isAnimated: boolean;
  fileIdentity?: FileIdentity;
}

export interface FileIdentity {
  device: number;
  inode: number;
  size: number;
  mtimeMs: number;
}

export interface OptimizationSettings {
  profile: OptimizationProfile;
  outputPolicy: OutputPolicy;
  outputFormat: ImageFormat | null;
  quality: number | 'auto';
  lossless: boolean;
  maxWidth: number | null;
  maxHeight: number | null;
  metadata: MetadataPolicy;
  color: ColorPolicy;
  preserveAspect: boolean;
  preserveFolderHierarchy: boolean;
}

export interface Preset {
  id: string;
  name: string;
  description: string;
  settings: OptimizationSettings;
  builtIn?: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface OptimizationResult {
  status: ItemStatus;
  outputPath?: string;
  outputFormat?: ImageFormat;
  outputBytes?: number;
  outputWidth?: number;
  outputHeight?: number;
  savingsPct?: number;
  qualityScore?: number;
  durationMs?: number;
  settingsHash?: string;
  outputIdentity?: FileIdentity;
  message?: string;
}

export interface QueueItem extends ImageInfo {
  settingsOverride?: Partial<OptimizationSettings>;
  result?: OptimizationResult;
  progress?: number;
}

export interface ImportResponse {
  items: QueueItem[];
  issues: ImportIssue[];
}

export interface ImportIssue {
  path: string;
  message: string;
}

export interface BatchState {
  id: string;
  status: 'idle' | 'processing' | 'complete' | 'cancelled';
  completed: number;
  total: number;
  failed: number;
  startedAt?: string;
}

export interface OptimizationRequest {
  ids: string[];
  defaults: OptimizationSettings;
  overrides: Record<string, Partial<OptimizationSettings>>;
}

export interface QueueUpdate {
  item: QueueItem;
  batch: BatchState;
}

export interface ExportRequest {
  itemIds: string[];
  destination: string;
  preserveHierarchy: boolean;
  preserveHierarchyByItem?: Record<string, boolean>;
  expectedSettingsHashByItem?: Record<string, string>;
}

export interface ExportReport {
  exported: Array<{ itemId: string; path: string }>;
  failures: Array<{ itemId: string; message: string }>;
}

export interface AppSettings {
  theme: 'dark' | 'light' | 'system';
  concurrency: number;
  defaultExportFolder: string | null;
  lastOutputPolicy: OutputPolicy;
  lastProfile: OptimizationProfile;
  defaultOptimization: OptimizationSettings;
  updateSourcePath: string | null;
}

export type UpdateCheckState = 'available' | 'up-to-date' | 'not-configured' | 'dirty' | 'invalid-source' | 'unavailable' | 'error';

export interface UpdateCheckResult {
  state: UpdateCheckState;
  currentVersion: string;
  latestVersion?: string;
  tag?: string;
  sourcePath?: string;
  approvedSource?: string;
  message: string;
  canInstall: boolean;
}

export type UpdateProgressPhase = 'checking' | 'staging' | 'installing' | 'verifying' | 'failed';

export interface UpdateProgress {
  phase: UpdateProgressPhase;
  message: string;
  percent?: number;
}

export interface UpdateStatusRecord {
  state: 'pending' | 'verified' | 'installed' | 'failed' | 'rolled-back';
  version?: string;
  message: string;
  timestamp: string;
  backupPath?: string;
  lockPath?: string;
  stagingRoot?: string;
  targetAppPath?: string;
  transactionId?: string;
  applicationIdentity?: string;
  knownGoodApplicationIdentity?: string;
}

export interface UpdateInstallResponse {
  accepted: boolean;
  message: string;
}

export interface AppInfo {
  version: string;
  packaged: boolean;
  lastUpdateStatus: UpdateStatusRecord | null;
}

export const DEFAULT_SETTINGS: OptimizationSettings = {
  profile: 'balanced',
  outputPolicy: 'preserve',
  outputFormat: null,
  quality: 'auto',
  lossless: false,
  maxWidth: null,
  maxHeight: null,
  metadata: 'strip',
  color: 'srgb',
  preserveAspect: true,
  preserveFolderHierarchy: true,
};

export const DEFAULT_APP_SETTINGS: AppSettings = {
  theme: 'dark',
  concurrency: 2,
  defaultExportFolder: null,
  lastOutputPolicy: 'preserve',
  lastProfile: 'balanced',
  defaultOptimization: DEFAULT_SETTINGS,
  updateSourcePath: null,
};
