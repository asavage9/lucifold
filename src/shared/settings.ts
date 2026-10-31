import type { OptimizationSettings } from './types.js';

/**
 * A deterministic settings identity used to prevent stale results from being
 * exported after a materially different optimization configuration is chosen.
 */
export function settingsSignature(settings: OptimizationSettings): string {
  return JSON.stringify({
    profile: settings.profile,
    outputPolicy: settings.outputPolicy,
    outputFormat: settings.outputFormat,
    quality: settings.quality,
    lossless: settings.lossless,
    maxWidth: settings.maxWidth,
    maxHeight: settings.maxHeight,
    metadata: settings.metadata,
    color: settings.color,
    preserveAspect: settings.preserveAspect,
    preserveFolderHierarchy: settings.preserveFolderHierarchy,
  });
}

export function resolveSettings(defaults: OptimizationSettings, override?: Partial<OptimizationSettings>): OptimizationSettings {
  return { ...defaults, ...(override ?? {}) };
}
