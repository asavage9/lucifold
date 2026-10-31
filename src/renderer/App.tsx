import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import type { AppInfo, AppSettings, AppView, BatchState, ImageFormat, OptimizationRequest, OptimizationSettings, Preset, QueueItem, QueueUpdate, SupportedFormat, UpdateCheckResult, UpdateProgress } from '../shared/types';
import { DEFAULT_APP_SETTINGS, DEFAULT_SETTINGS } from '../shared/types';
import { resolveSettings, settingsSignature } from '../shared/settings';

type AppMessage = { tone: 'info' | 'error' | 'success'; text: string; actionPath?: string };

const initialBatch: BatchState = { id: '', status: 'idle', completed: 0, total: 0, failed: 0 };

const formatBytes = (bytes?: number): string => {
  if (bytes === undefined) return '—';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1024;
  let unit = units[0];
  for (let index = 0; index < units.length && value >= 1024; index += 1) {
    value /= 1024;
    unit = units[index + 1] ?? units[index];
  }
  return `${value.toFixed(value >= 10 ? 1 : 2)} ${unit}`;
};

const formatName = (format: SupportedFormat): string => format === 'unknown' ? 'Unknown' : format === 'jpeg' ? 'JPEG' : format.toUpperCase();

const statusText = (item: QueueItem): string => {
  const status = item.result?.status;
  if (!status) return 'Ready';
  if (status === 'complete') return 'Optimized';
  if (status === 'no-improvement') return 'Original retained';
  if (status === 'needs-reoptimization') return 'Needs reoptimization';
  if (status === 'processing') return 'Optimizing';
  if (status === 'failed') return 'Failed';
  if (status === 'cancelled') return 'Canceled';
  return 'Ready';
};

const resultReady = (item: QueueItem): boolean => ['complete', 'no-improvement'].includes(item.result?.status ?? '') && Boolean(item.result?.outputPath);

function Icon({ name, size = 18 }: { name: string; size?: number }) {
  const paths: Record<string, ReactNode> = {
    optimize: <><path d="M4 5h16M4 12h16M4 19h10" /><path d="m17 16 3 3-3 3" /></>,
    presets: <><path d="M4 5h16v14H4z" /><path d="M8 9h8M8 13h5" /></>,
    compare: <><path d="M4 5h7v14H4zM13 5h7v14h-7z" /><path d="M11 12h2" /></>,
    settings: <><path d="M12 8.5a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7Z" /><path d="m19.4 15 .1 1.8-1.8 1.8-1.7-.6a8 8 0 0 1-1.7 1l-.5 1.7H10l-.5-1.7a8 8 0 0 1-1.7-1l-1.7.6-1.8-1.8.1-1.8a8 8 0 0 1-.8-1.7l-1.6-.7v-2.5l1.6-.7a8 8 0 0 1 .8-1.7l-.1-1.8 1.8-1.8 1.7.6a8 8 0 0 1 1.7-1L10 2.5h2.5L13 4.2a8 8 0 0 1 1.7 1l1.7-.6 1.8 1.8-.1 1.8a8 8 0 0 1 .8 1.7l1.6.7v2.5l-1.6.7a8 8 0 0 1-.8 1.7Z" /></>,
    plus: <><path d="M12 5v14M5 12h14" /></>,
    folder: <><path d="M3.5 6.5h6l1.5 2h9.5v9.5h-17z" /><path d="M3.5 8.5h17" /></>,
    export: <><path d="M12 4v10M8 8l4-4 4 4" /><path d="M5 14v5h14v-5" /></>,
    trash: <><path d="M5 7h14M10 11v6M14 11v6M7 7l1 13h8l1-13M9 7V4h6v3" /></>,
    edit: <><path d="m4 16.5-.8 3.3 3.3-.8L18.8 6.7a2.2 2.2 0 0 0-3.1-3.1L4 16.5Z" /><path d="m14.5 5.5 3 3" /></>,
    sun: <><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" /></>,
    check: <path d="m5 12 4 4L19 6" />,
    close: <><path d="m6 6 12 12M18 6 6 18" /></>,
    refresh: <><path d="M20 11a8 8 0 0 0-14.7-4L3 10" /><path d="M3 5v5h5M4 13a8 8 0 0 0 14.7 4L21 14" /><path d="M21 19v-5h-5" /></>,
    info: <><circle cx="12" cy="12" r="9" /><path d="M12 11v6M12 8h.01" /></>,
    spark: <><path d="m12 3 1.4 5.6L19 10l-5.6 1.4L12 17l-1.4-5.6L5 10l5.6-1.4z" /><path d="m19 16 .5 2 2 .5-2 .5-.5 2-.5-2-2-.5 2-.5z" /></>,
  };
  return <svg aria-hidden="true" className="icon" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">{paths[name] ?? paths.info}</svg>;
}

function Logo() {
  return <div className="brand-lockup"><div className="brand-mark"><img src="./foreground-mark.svg" alt="" /></div><span>lucifold</span></div>;
}

function Sidebar({ view, setView, itemCount, version }: { view: AppView; setView: (view: AppView) => void; itemCount: number; version: string }) {
  const entries: Array<{ id: AppView; label: string; icon: string }> = [
    { id: 'optimize', label: 'Optimize', icon: 'optimize' },
    { id: 'presets', label: 'Presets', icon: 'presets' },
    { id: 'compare', label: 'Compare', icon: 'compare' },
    { id: 'settings', label: 'Settings', icon: 'settings' },
  ];
  return <aside className="sidebar">
    <Logo />
    <div className="sidebar-rule" />
    <nav aria-label="Primary navigation" className="nav-list">
      {entries.map((entry) => <button key={entry.id} className={`nav-item ${view === entry.id ? 'active' : ''}`} onClick={() => setView(entry.id)} aria-current={view === entry.id ? 'page' : undefined}>
        <Icon name={entry.icon} /><span>{entry.label}</span>{entry.id === 'optimize' && itemCount > 0 ? <span className="nav-count">{itemCount}</span> : null}
      </button>)}
    </nav>
    <div className="sidebar-bottom"><div className="identity-chip"><span className="status-dot" />Local processing</div><span className="sidebar-version">v{version} · Apple Silicon</span></div>
  </aside>;
}

function QueueRow({ item, selected, checked, overridden, thumbnail, onSelect, onCheck }: { item: QueueItem; selected: boolean; checked: boolean; overridden: boolean; thumbnail?: string; onSelect: () => void; onCheck: (checked: boolean) => void }) {
  const status = item.result?.status ?? 'queued';
  return <div className={`queue-row ${selected ? 'selected' : ''} status-${status}`} onClick={onSelect} role="button" tabIndex={0} onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') onSelect(); }} aria-label={`${item.name}, ${statusText(item)}${overridden ? ', custom settings' : ''}`}>
    <input className="row-check" type="checkbox" checked={checked} onChange={(event) => onCheck(event.target.checked)} onClick={(event) => event.stopPropagation()} aria-label={`Select ${item.name}`} />
    <div className="queue-thumb">{thumbnail ? <img src={thumbnail} alt="" /> : <span className="thumb-placeholder"><Icon name="spark" size={15} /></span>}</div>
    <div className="row-copy"><div className="row-title" title={item.path}>{item.name}</div><div className="row-meta">{item.width} × {item.height} · {formatName(item.format)} · {formatBytes(item.bytes)}</div><div className={`row-status status-label-${status}`}><span className="status-glyph">{status === 'complete' ? '✓' : status === 'failed' ? '!' : status === 'processing' ? '◌' : status === 'needs-reoptimization' ? '↻' : '•'}</span>{statusText(item)}{overridden ? <span className="row-override">Custom</span> : null}{item.result?.status === 'complete' && item.result.savingsPct !== undefined ? <span className="row-savings">{item.result.savingsPct >= 0 ? `−${item.result.savingsPct}%` : `+${Math.abs(item.result.savingsPct)}%`}</span> : null}</div></div>
    <div className="row-size">{item.result?.outputBytes !== undefined ? <><strong>{formatBytes(item.result.outputBytes)}</strong><span>{item.result.outputFormat ? formatName(item.result.outputFormat) : ''}</span></> : <span>—</span>}</div>
  </div>;
}

function QueuePanel({ items, selectedId, checkedIds, overrides, thumbnails, onSelect, onCheck, onAddImages, onAddFolder, onClear }: {
  items: QueueItem[]; selectedId: string | null; checkedIds: Set<string>; overrides: Record<string, Partial<OptimizationSettings>>; thumbnails: Record<string, string>; onSelect: (id: string) => void; onCheck: (id: string, checked: boolean) => void; onAddImages: () => void; onAddFolder: () => void; onClear: () => void;
}) {
  const totalOriginal = items.reduce((sum, item) => sum + item.bytes, 0);
  const totalOptimized = items.reduce((sum, item) => sum + (resultReady(item) && item.result?.outputBytes ? item.result.outputBytes : 0), 0);
  const completed = items.filter(resultReady);
  return <section className="queue-panel" aria-label="Image queue">
    <div className="panel-header queue-header"><div><h1>Optimize</h1><p>{items.length ? `${items.length} image${items.length === 1 ? '' : 's'} · ${formatBytes(totalOriginal)} original` : 'Your local image workspace'}</p></div><button className="icon-button" onClick={onClear} disabled={!items.length} aria-label="Clear queue" title="Clear queue"><Icon name="trash" /></button></div>
    {items.length ? <div className="queue-summary"><span>{completed.length ? `${formatBytes(totalOptimized)} optimized` : 'No optimized results yet'}</span>{completed.length ? <span className="summary-reduction">{totalOriginal ? `−${(((totalOriginal - totalOptimized) / totalOriginal) * 100).toFixed(1)}% verified` : ''}</span> : null}</div> : null}
    <div className={`queue-list ${!items.length ? 'empty-queue' : ''}`}>
      {!items.length ? <div className="empty-state"><div className="empty-visual"><Icon name="spark" size={34} /></div><h2>Drop images or folders here</h2><p>JPEG, PNG, WebP, and AVIF stay on this Mac.</p><div className="empty-actions"><button className="primary-button" onClick={onAddImages}><Icon name="plus" size={16} />Add Images…</button><button className="secondary-button" onClick={onAddFolder}><Icon name="folder" size={16} />Add Folder…</button></div></div> : items.map((item) => <QueueRow key={item.id} item={item} selected={selectedId === item.id} checked={checkedIds.has(item.id)} overridden={Boolean(overrides[item.id])} thumbnail={thumbnails[item.id]} onSelect={() => onSelect(item.id)} onCheck={(checked) => onCheck(item.id, checked)} />)}
    </div>
    {items.length ? <div className="queue-footer"><button className="secondary-button compact" onClick={onAddImages}><Icon name="plus" size={15} />Add Images</button><button className="secondary-button compact" onClick={onAddFolder}><Icon name="folder" size={15} />Add Folder</button></div> : null}
  </section>;
}

function PreviewPane({ item, sourcePreview, outputPreview, divider, setDivider, zoom, setZoom, compareMode, setCompareMode }: { item: QueueItem | undefined; sourcePreview: string | null; outputPreview: string | null; divider: number; setDivider: (value: number) => void; zoom: 'fit' | '100%'; setZoom: (value: 'fit' | '100%') => void; compareMode: 'split' | 'side'; setCompareMode: (mode: 'split' | 'side') => void }) {
  const hasOutput = Boolean(outputPreview && resultReady(item ?? ({} as QueueItem)));
  return <section className="preview-panel">
    <div className="preview-header"><div><h2>{item?.name ?? 'Comparison workspace'}</h2><p>{item ? `${item.width} × ${item.height} · ${formatName(item.format)} · ${formatBytes(item.bytes)}` : 'Select an image to inspect the source and result.'}</p></div><div className="preview-tools"><div className="segmented" role="group" aria-label="Comparison mode"><button className={compareMode === 'split' ? 'selected' : ''} onClick={() => setCompareMode('split')} disabled={!hasOutput}>Split</button><button className={compareMode === 'side' ? 'selected' : ''} onClick={() => setCompareMode('side')} disabled={!hasOutput}>Side by side</button></div><div className="segmented" role="group" aria-label="Preview zoom"><button className={zoom === 'fit' ? 'selected' : ''} onClick={() => setZoom('fit')}>Fit</button><button className={zoom === '100%' ? 'selected' : ''} onClick={() => setZoom('100%')}>100%</button></div></div></div>
    <div className={`preview-canvas ${zoom === '100%' ? 'zoomed' : ''}`}>
      {!item ? <div className="preview-empty"><div className="empty-visual small"><Icon name="compare" size={28} /></div><h2>Inspect a real image result</h2><p>Import an image, optimize it, then compare the actual decoded files here.</p></div> : !sourcePreview ? <div className="preview-empty"><span className="spinner" /><p>Loading source preview…</p></div> : !hasOutput ? <div className="single-preview image-checker"><img src={sourcePreview} alt={`Original ${item.name}`} /></div> : compareMode === 'side' ? <div className="side-preview"><div className="compare-card image-checker"><span className="compare-label">Original · {formatBytes(item.bytes)}</span><img src={sourcePreview} alt={`Original ${item.name}`} /></div><div className="compare-card image-checker"><span className="compare-label">Optimized · {formatBytes(item.result?.outputBytes)}</span><img src={outputPreview!} alt={`Optimized ${item.name}`} /></div></div> : <div className="split-preview image-checker" style={{ '--split': `${divider}%` } as CSSProperties}><div className="compare-image base"><img src={outputPreview!} alt={`Optimized ${item.name}`} /></div><div className="compare-image clipped"><img src={sourcePreview} alt={`Original ${item.name}`} /></div><div className="split-line" style={{ left: `${divider}%` }}><span className="split-handle" aria-hidden="true">↔</span></div><span className="compare-label label-original">Original</span><span className="compare-label label-optimized">Optimized</span></div>}
    </div>
    {hasOutput ? <div className="compare-controls"><label className="range-label" htmlFor="split-range">Comparison divider <span>{divider}% original</span></label><input id="split-range" type="range" min="5" max="95" value={divider} onChange={(event) => setDivider(Number(event.target.value))} aria-label="Comparison divider position" /><div className="result-facts"><span><strong>{formatBytes(item?.result?.outputBytes)}</strong> output</span><span className="fact-savings">{item?.result?.savingsPct !== undefined && item.result.savingsPct >= 0 ? `−${item.result.savingsPct}% smaller` : 'Original retained'}</span><span>Score {item?.result?.qualityScore?.toFixed(4) ?? '—'}</span></div></div> : null}
  </section>;
}

function Inspector({ settings, setSettings, item, scopeLabel, presets, activePreset, hasOverride, onApplyPreset, onSavePreset, onClearOverride }: { settings: OptimizationSettings; setSettings: (next: OptimizationSettings) => void; item?: QueueItem; scopeLabel: string; presets: Preset[]; activePreset?: Preset; hasOverride: boolean; onApplyPreset: (preset: Preset) => void; onSavePreset: () => void; onClearOverride: () => void }) {
  const update = (change: Partial<OptimizationSettings>) => setSettings({ ...settings, ...change });
  const formatOptions: Array<{ value: OptimizationSettings['outputPolicy']; label: string }> = [{ value: 'preserve', label: 'Preserve original format' }, { value: 'convert', label: 'Convert to selected format' }, { value: 'smart', label: 'Smart format selection' }];
  return <aside className="inspector-panel"><div className="inspector-head"><div><p className="eyebrow">Settings</p><h2>Optimization</h2></div><span className="scope-pill">{scopeLabel}</span></div><div className="inspector-scroll">
    <div className="inspector-section"><label className="field-label" htmlFor="preset">Preset</label><select id="preset" value={activePreset?.id ?? 'custom'} onChange={(event) => { const preset = presets.find((candidate) => candidate.id === event.target.value); if (preset) onApplyPreset(preset); }}><option value="custom">Custom settings</option>{presets.map((preset) => <option key={preset.id} value={preset.id}>{preset.name}</option>)}</select>{activePreset ? <button className="secondary-button compact" onClick={onSavePreset}>Save changes to {activePreset.name}</button> : null}{hasOverride ? <button className="secondary-button compact" onClick={onClearOverride}>Reset selected to batch defaults</button> : null}</div>
    <div className="inspector-section"><p className="field-label">Compression profile</p><div className="profile-grid">{(['fast', 'balanced', 'maximum'] as const).map((profile) => <button key={profile} className={`profile-card ${settings.profile === profile ? 'selected' : ''}`} onClick={() => update({ profile })}><span>{profile === 'fast' ? 'Fast' : profile === 'balanced' ? 'Balanced' : 'Maximum'}</span><small>{profile === 'fast' ? 'Quick pass' : profile === 'balanced' ? 'Recommended' : 'Smallest acceptable'}</small></button>)}</div></div>
    <div className="inspector-section"><label className="field-label" htmlFor="output-policy">Output format</label><select id="output-policy" value={settings.outputPolicy} onChange={(event) => update({ outputPolicy: event.target.value as OptimizationSettings['outputPolicy'], outputFormat: event.target.value === 'convert' ? settings.outputFormat ?? 'webp' : settings.outputFormat })}>{formatOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select>{settings.outputPolicy === 'convert' ? <select aria-label="Selected output format" value={settings.outputFormat ?? 'webp'} onChange={(event) => update({ outputFormat: event.target.value as ImageFormat })}><option value="jpeg" disabled={item?.hasAlpha}>JPEG{item?.hasAlpha ? ' (no alpha)' : ''}</option><option value="png">PNG</option><option value="webp">WebP</option><option value="avif">AVIF</option></select> : null}<p className="field-help">lucifold never changes format unless you choose conversion or Smart selection.</p></div>
    <div className="inspector-section"><div className="field-row"><label className="field-label" htmlFor="quality">Quality</label><label className="toggle-line"><input type="checkbox" checked={settings.quality === 'auto'} onChange={(event) => update({ quality: event.target.checked ? 'auto' : 80 })} /> Auto</label></div>{settings.quality === 'auto' ? <div className="auto-note"><Icon name="spark" size={15} />Bounded quality search selects the smallest candidate that clears its threshold.</div> : <div className="quality-control"><input id="quality" type="range" min="30" max="100" value={settings.quality} onChange={(event) => update({ quality: Number(event.target.value) })} /><output>{settings.quality}</output></div>}<label className={`toggle-line ${item?.format === 'jpeg' || settings.outputFormat === 'jpeg' ? 'disabled' : ''}`}><input type="checkbox" checked={settings.lossless} disabled={item?.format === 'jpeg' || settings.outputFormat === 'jpeg'} onChange={(event) => update({ lossless: event.target.checked })} /> Lossless where supported</label></div>
    <div className="inspector-section"><p className="field-label">Resize</p><div className="dimension-row"><input type="number" min="1" placeholder="Max width" value={settings.maxWidth ?? ''} onChange={(event) => update({ maxWidth: event.target.value ? Number(event.target.value) : null })} /><span>×</span><input type="number" min="1" placeholder="Max height" value={settings.maxHeight ?? ''} onChange={(event) => update({ maxHeight: event.target.value ? Number(event.target.value) : null })} /></div><label className="toggle-line"><input type="checkbox" checked={settings.preserveAspect} onChange={(event) => update({ preserveAspect: event.target.checked })} /> Preserve aspect ratio</label></div>
    <div className="inspector-section"><p className="field-label">Color and metadata</p><select aria-label="Color handling" value={settings.color} onChange={(event) => update({ color: event.target.value as OptimizationSettings['color'] })}><option value="srgb">Normalize to sRGB</option><option value="preserve">Preserve source color profile</option></select><select aria-label="Metadata handling" value={settings.metadata} onChange={(event) => update({ metadata: event.target.value as OptimizationSettings['metadata'] })}><option value="strip">Strip metadata for web</option><option value="preserve">Preserve metadata where supported</option></select></div>
    <div className="inspector-section"><p className="field-label">Export</p><label className="toggle-line"><input type="checkbox" checked={settings.preserveFolderHierarchy} onChange={(event) => update({ preserveFolderHierarchy: event.target.checked })} /> Preserve folder hierarchy</label><p className="field-help">When enabled, exported files retain their imported folder paths beneath the destination. The preference is saved with the batch defaults.</p></div>
  </div></aside>;
}

function FooterActions({ batch, items, checkedIds, onOptimize, onCancel, onExport, onRetry }: { batch: BatchState; items: QueueItem[]; checkedIds: Set<string>; onOptimize: () => void; onCancel: () => void; onExport: () => void; onRetry: () => void }) {
  const eligible = items.filter((item) => resultReady(item) && (checkedIds.size === 0 || checkedIds.has(item.id))).length;
  const failed = items.filter((item) => item.result?.status === 'failed' || item.result?.status === 'cancelled').length;
  const processing = batch.status === 'processing';
  return <footer className="action-footer"><div className="batch-status" aria-live="polite"><span className={`status-dot ${processing ? 'working' : batch.failed ? 'warning' : ''}`} />{processing ? <span>Optimizing {batch.completed} of {batch.total}</span> : batch.status === 'complete' ? <span>{batch.failed ? `${batch.failed} failed · ` : ''}Batch complete</span> : batch.status === 'cancelled' ? <span>Batch canceled · {batch.completed} of {batch.total} finished</span> : <span>{items.length ? `${items.length} ready` : 'No images queued'}</span>}</div><div className="footer-actions">{processing ? <button className="secondary-button" onClick={onCancel}><Icon name="close" size={16} />Cancel</button> : failed ? <button className="secondary-button" onClick={onRetry}><Icon name="refresh" size={16} />Retry failed</button> : null}<button className="secondary-button" disabled={!eligible || processing} onClick={onExport}><Icon name="export" size={16} />Export {eligible ? `${eligible} result${eligible === 1 ? '' : 's'}` : 'results'}</button><button className="primary-button" disabled={!items.length || processing} onClick={onOptimize}><Icon name="spark" size={16} />{checkedIds.size ? 'Optimize selected' : 'Start optimization'}</button></div></footer>;
}

function PresetsView({ presets, settings, onApply, onSave, onDelete, onRename, onDuplicate }: { presets: Preset[]; settings: OptimizationSettings; onApply: (preset: Preset) => void; onSave: (preset: Preset) => void; onDelete: (preset: Preset) => void; onRename: (preset: Preset) => void; onDuplicate: (preset: Preset) => void }) {
  return <section className="content-view presets-view"><div className="view-heading"><div><p className="eyebrow">Reusable setups</p><h1>Presets</h1><p>Keep repeatable image decisions local to this Mac.</p></div><button className="primary-button" onClick={() => { const name = window.prompt('Preset name'); if (name?.trim()) onSave({ id: crypto.randomUUID(), name: name.trim(), description: 'Custom local preset.', settings: { ...settings }, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }); }}><Icon name="plus" size={16} />New preset</button></div><div className="preset-grid">{presets.map((preset) => <article className="preset-card" key={preset.id}><div className="preset-card-top"><div className="preset-icon"><Icon name={preset.builtIn ? 'spark' : 'presets'} size={18} /></div><span className="preset-kind">{preset.builtIn ? 'Built in' : 'Local'}</span></div><h2>{preset.name}</h2><p>{preset.description}</p><div className="preset-summary"><span>{preset.settings.profile}</span><span>{preset.settings.outputPolicy === 'preserve' ? 'Original format' : preset.settings.outputPolicy === 'smart' ? 'Smart format' : formatName(preset.settings.outputFormat ?? 'webp')}</span><span>{preset.settings.quality === 'auto' ? 'Auto quality' : `Q${preset.settings.quality}`}</span></div><div className="preset-actions"><button className="secondary-button compact" onClick={() => onApply(preset)}>Use in Optimize</button><button className="icon-button" onClick={() => onDuplicate(preset)} aria-label={`Duplicate ${preset.name}`} title={`Duplicate ${preset.name}`}><Icon name="presets" size={16} /></button>{!preset.builtIn ? <><button className="icon-button" onClick={() => onRename(preset)} aria-label={`Rename ${preset.name}`} title={`Rename ${preset.name}`}><Icon name="edit" size={16} /></button><button className="icon-button" onClick={() => onDelete(preset)} aria-label={`Delete ${preset.name}`} title={`Delete ${preset.name}`}><Icon name="trash" size={16} /></button></> : null}</div></article>)}</div></section>;
}

function ApplicationSettingsView({ settings, appSettings, appInfo, updateCheck, updateProgress, updateBusy, onAppSettingsChange, onChooseSource, onCheckForUpdates, onInstallUpdate }: { settings: OptimizationSettings; appSettings: AppSettings; appInfo: AppInfo | null; updateCheck: UpdateCheckResult | null; updateProgress: UpdateProgress | null; updateBusy: boolean; onAppSettingsChange: (next: AppSettings) => void; onChooseSource: () => void; onCheckForUpdates: () => void; onInstallUpdate: () => void }) {
  const updateState = updateCheck ? updateStateLabel(updateCheck.state) : 'Not checked yet';
  const sourcePath = appSettings.updateSourcePath ?? updateCheck?.sourcePath ?? 'Not configured';
  const canInstall = Boolean(updateCheck?.state === 'available' && updateCheck.tag && updateCheck.canInstall);
  return <section className="content-view settings-view"><div className="view-heading"><div><p className="eyebrow">Application preferences</p><h1>Settings</h1><p>Local controls for appearance, processing, safe export, and approved updates.</p></div></div><div className="settings-groups"><div className="settings-card"><h2>Appearance</h2><p>System follows the macOS appearance. Light and dark are always available.</p><label className="field-label" htmlFor="theme">Appearance</label><select id="theme" value={appSettings.theme} onChange={(event) => onAppSettingsChange({ ...appSettings, theme: event.target.value as AppSettings['theme'] })}><option value="system">System</option><option value="dark">Dark</option><option value="light">Light</option></select></div><div className="settings-card"><h2>Processing</h2><p>Keep concurrency bounded so the workspace stays responsive while codecs run outside the renderer.</p><label className="field-label" htmlFor="concurrency">Concurrent images</label><select id="concurrency" value={appSettings.concurrency} onChange={(event) => onAppSettingsChange({ ...appSettings, concurrency: Number(event.target.value) })}><option value="1">1 · Lowest memory</option><option value="2">2 · Recommended</option><option value="3">3 · Faster batches</option><option value="4">4 · Highest throughput</option></select><div className="settings-note"><Icon name="info" size={16} />AVIF and Maximum mode may take longer because each candidate is encoded from the original source.</div></div><div className="settings-card"><h2>Default optimization</h2><p>These controls mirror the Optimize inspector and persist for the next session.</p><div className="settings-inline"><span>Profile</span><strong>{settings.profile}</strong></div><div className="settings-inline"><span>Output policy</span><strong>{settings.outputPolicy === 'preserve' ? 'Preserve original format' : settings.outputPolicy}</strong></div><div className="settings-inline"><span>Metadata</span><strong>{settings.metadata === 'strip' ? 'Strip for web' : 'Preserve'}</strong></div></div><div className="settings-card"><h2>About lucifold</h2><p>Local-first image optimization for professional web workflows. Originals are never replaced by v1.0.1.</p><div className="support-list"><span>JPEG · PNG · WebP · AVIF</span><span>Sharp/libvips · MozJPEG · WebP/AVIF codecs</span><span>macOS Apple Silicon · v1.0.1</span></div></div><div className="settings-card update-card"><div className="update-heading"><div><p className="eyebrow">Application updates</p><h2>Keep lucifold current.</h2></div><span className={`status-chip ${updateCheck?.state === 'available' ? 'success' : updateCheck?.state === 'up-to-date' ? 'muted' : updateCheck ? 'error' : 'muted'}`}><span className="status-dot" />{updateState}</span></div><p>Updates are staged locally from a clean approved source checkout. Nothing installs automatically, and the current app is backed up before replacement.</p><div className="settings-fact"><span>Installed version</span><code>v{appInfo?.version ?? 'Loading…'}</code></div><div className="settings-fact"><span>Configured local project</span><code>{sourcePath}</code></div><div className="settings-fact"><span>Approved source</span><code>{updateCheck?.approvedSource ?? 'Not configured in this build'}</code></div>{updateProgress ? <div className="update-progress" role="status"><span>{updateProgress.message}</span>{typeof updateProgress.percent === 'number' ? <strong>{updateProgress.percent}%</strong> : null}</div> : null}{updateCheck?.latestVersion ? <div className="update-available"><strong>v{updateCheck.latestVersion}</strong><span>{updateCheck.tag} is ready to stage.</span></div> : null}{appInfo?.lastUpdateStatus ? <div className="update-history"><span>Last installation</span><strong>{appInfo.lastUpdateStatus.state === 'installed' ? `v${appInfo.lastUpdateStatus.version ?? ''} installed` : appInfo.lastUpdateStatus.state === 'rolled-back' ? 'Rolled back safely' : appInfo.lastUpdateStatus.state === 'verified' ? 'Startup verified' : 'Installation pending or failed'}</strong><small>{appInfo.lastUpdateStatus.message}</small></div> : null}<div className="update-actions"><button className="secondary-button" type="button" disabled={updateBusy} onClick={onChooseSource}>Choose repository</button><button className="secondary-button" type="button" disabled={updateBusy} onClick={onCheckForUpdates}>{updateBusy && updateProgress?.phase === 'checking' ? 'Checking…' : 'Check for Updates'}</button><button className="primary-button" type="button" disabled={updateBusy || !canInstall} onClick={onInstallUpdate}>Install Update &amp; Restart</button></div><p className="update-note">This v1.0.1 build intentionally has no approved lucifold remote origin yet. Selecting a local checkout is supported for preparation and diagnostics; live discovery remains disabled until an approved source is embedded in a future authorized build.</p></div></div></section>;
}

function updateStateLabel(state: UpdateCheckResult['state']): string {
  return ({ available: 'Update available', 'up-to-date': 'Up to date', 'not-configured': 'Source not configured', dirty: 'Source is dirty', 'invalid-source': 'Invalid source', unavailable: 'Unavailable', error: 'Check failed' } as const)[state];
}

export default function App() {
  const [view, setView] = useState<AppView>('optimize');
  const [items, setItems] = useState<QueueItem[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [checkedIds, setCheckedIds] = useState<Set<string>>(new Set());
  const [thumbnails, setThumbnails] = useState<Record<string, string>>({});
  const [sourcePreview, setSourcePreview] = useState<string | null>(null);
  const [outputPreview, setOutputPreview] = useState<string | null>(null);
  const [batch, setBatch] = useState<BatchState>(initialBatch);
  const [settings, setSettings] = useState<OptimizationSettings>(DEFAULT_SETTINGS);
  const [overrides, setOverrides] = useState<Record<string, Partial<OptimizationSettings>>>({});
  const [appSettings, setAppSettings] = useState<AppSettings>(DEFAULT_APP_SETTINGS);
  const [presets, setPresets] = useState<Preset[]>([]);
  const [activePresetId, setActivePresetId] = useState<string | null>(null);
  const [appInfo, setAppInfo] = useState<AppInfo | null>(null);
  const [updateCheck, setUpdateCheck] = useState<UpdateCheckResult | null>(null);
  const [updateProgress, setUpdateProgress] = useState<UpdateProgress | null>(null);
  const [updateBusy, setUpdateBusy] = useState(false);
  const [message, setMessage] = useState<AppMessage | null>(null);
  const [divider, setDivider] = useState(50);
  const [zoom, setZoom] = useState<'fit' | '100%'>('fit');
  const [compareMode, setCompareMode] = useState<'split' | 'side'>('split');
  const hydrated = useRef(false);
  const dragDepth = useRef(0);
  const [isDraggingFiles, setIsDraggingFiles] = useState(false);

  const selectedItem = useMemo(() => items.find((item) => item.id === selectedId), [items, selectedId]);
  const activePreset = useMemo(() => presets.find((preset) => preset.id === activePresetId), [activePresetId, presets]);
  const scopeIds = useMemo(() => [...checkedIds], [checkedIds]);
  const editorSettings = useMemo(() => scopeIds.length ? resolveSettings(settings, overrides[scopeIds[0]]) : settings, [overrides, scopeIds, settings]);
  const hasOverride = scopeIds.some((id) => Boolean(overrides[id]));
  const scopeLabel = scopeIds.length > 0 ? `${scopeIds.length} selected image${scopeIds.length === 1 ? '' : 's'}${hasOverride ? ' · custom' : ''}` : 'Batch defaults';

  useEffect(() => {
    let active = true;
    void window.lucifold.getInitialState().then((state) => {
      if (!active) return;
      setItems(state.items);
      setBatch(state.batch);
      setOverrides(Object.fromEntries(state.items.filter((item) => item.settingsOverride).map((item) => [item.id, item.settingsOverride])) as Record<string, Partial<OptimizationSettings>>);
      setAppSettings(state.settings);
      setSettings(state.settings.defaultOptimization ?? {
        ...DEFAULT_SETTINGS,
        profile: state.settings.lastProfile,
        outputPolicy: state.settings.lastOutputPolicy,
      });
      setPresets(state.presets);
      hydrated.current = true;
      if (state.items[0]) setSelectedId(state.items[0].id);
    });
    void window.lucifold.getAppInfo().then((info) => { if (active) setAppInfo(info); });
    const unsubscribe = window.lucifold.onQueueUpdate((update: QueueUpdate) => {
      setItems((current) => current.map((item) => item.id === update.item.id ? update.item : item));
      setBatch(update.batch);
    });
    const unsubscribeUpdates = window.lucifold.onUpdateProgress((progress) => setUpdateProgress(progress));
    return () => { active = false; unsubscribe(); unsubscribeUpdates(); };
  }, []);

  useEffect(() => {
    const theme = appSettings.theme === 'system' ? (window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark') : appSettings.theme;
    document.documentElement.dataset.theme = theme;
  }, [appSettings.theme]);

  useEffect(() => {
    const ids = items.map((item) => item.id).join('|');
    if (!ids) return;
    let cancelled = false;
    for (const item of items.slice(0, 40)) {
      if (thumbnails[item.id]) continue;
      void window.lucifold.getPreview(item.id, 'source').then((preview) => { if (!cancelled && preview) setThumbnails((current) => ({ ...current, [item.id]: preview })); });
    }
    return () => { cancelled = true; };
  }, [items]);

  useEffect(() => {
    if (!selectedItem) { setSourcePreview(null); setOutputPreview(null); return; }
    let cancelled = false;
    void window.lucifold.getPreview(selectedItem.id, 'source').then((preview) => { if (!cancelled) setSourcePreview(preview); });
    if (resultReady(selectedItem)) void window.lucifold.getPreview(selectedItem.id, 'output').then((preview) => { if (!cancelled) setOutputPreview(preview); });
    else setOutputPreview(null);
    return () => { cancelled = true; };
  }, [selectedItem?.id, selectedItem?.result?.status, selectedItem?.result?.outputPath]);

  useEffect(() => {
    if (selectedId && !items.some((item) => item.id === selectedId)) setSelectedId(items[0]?.id ?? null);
  }, [items, selectedId]);

  const importSelectedPaths = async (paths: string[]) => {
    if (!paths.length) return;
    try {
      const response = await window.lucifold.importPaths(paths);
      setItems(response.items);
      const importedOverrides = Object.fromEntries(response.items.flatMap((item) => item.settingsOverride ? [[item.id, item.settingsOverride]] : [])) as Record<string, Partial<OptimizationSettings>>;
      setOverrides((current) => ({ ...current, ...importedOverrides }));
      if (!selectedId && response.items[0]) setSelectedId(response.items[0].id);
      if (response.issues.length) setMessage({ tone: 'error', text: `${response.items.length} imported · ${response.issues.length} skipped or failed. ${response.issues[0].message}` });
      else setMessage({ tone: 'success', text: `${response.items.length} image${response.items.length === 1 ? '' : 's'} ready.` });
    } catch (error) {
      setMessage({ tone: 'error', text: error instanceof Error ? error.message : 'Import failed.' });
    }
  };

  const addImages = async () => importSelectedPaths(await window.lucifold.chooseFiles());
  const addFolder = async () => { const folder = await window.lucifold.chooseFolder(); if (folder) await importSelectedPaths([folder]); };
  const removeAll = () => { if (window.confirm('Clear the queue? Pending optimization results will be removed from this workspace. Original files will remain unchanged.')) { void window.lucifold.clearQueue().then((next) => { setItems(next); setSelectedId(null); setCheckedIds(new Set()); setMessage({ tone: 'info', text: 'Queue cleared. Originals remain untouched.' }); }); } };
  const effectiveSettingsFor = (id: string): OptimizationSettings => resolveSettings(settings, overrides[id]);
  const requestFor = (ids: string[]): OptimizationRequest => ({ ids, defaults: settings, overrides: Object.fromEntries(ids.filter((id) => overrides[id]).map((id) => [id, overrides[id]])) });
  const optimize = async (retryOnly = false) => {
    const ids = checkedIds.size ? [...checkedIds] : items.filter((item) => !resultReady(item) || item.result?.status === 'needs-reoptimization').map((item) => item.id);
    if (!ids.length) { setMessage({ tone: 'info', text: 'All queued images already have current results. Select an item to reoptimize it.' }); return; }
    try { const next = retryOnly ? await window.lucifold.retry(requestFor(ids)) : await window.lucifold.optimize(requestFor(ids)); setBatch(next); setMessage({ tone: 'success', text: 'Optimization finished. Results reflect measured output files.' }); } catch (error) { setMessage({ tone: 'error', text: error instanceof Error ? error.message : 'Optimization could not start.' }); }
  };
  const exportResults = async () => {
    const eligible = items.filter((item) => resultReady(item) && (checkedIds.size === 0 || checkedIds.has(item.id)));
    if (!eligible.length) { setMessage({ tone: 'info', text: 'There are no current optimization results to export.' }); return; }
    try {
      const destination = await window.lucifold.chooseExportDestination();
      if (!destination) return;
      const itemIds = eligible.map((item) => item.id);
      const report = await window.lucifold.exportItems({ itemIds, destination, preserveHierarchy: settings.preserveFolderHierarchy, preserveHierarchyByItem: Object.fromEntries(itemIds.map((id) => [id, effectiveSettingsFor(id).preserveFolderHierarchy])), expectedSettingsHashByItem: Object.fromEntries(itemIds.map((id) => [id, settingsSignature(effectiveSettingsFor(id))])) });
      if (report.exported.length) {
        const nextAppSettings = { ...appSettings, defaultExportFolder: destination };
        setAppSettings(nextAppSettings);
        void window.lucifold.writeSettings(nextAppSettings);
      }
      const actionPath = report.exported[0]?.path;
      if (report.failures.length) setMessage({ tone: 'error', text: `${report.exported.length} exported · ${report.failures.length} failed. ${report.failures[0].message}`, actionPath });
      else setMessage({ tone: 'success', text: `${report.exported.length} image${report.exported.length === 1 ? '' : 's'} exported to ${destination}.`, actionPath });
    } catch (error) {
      setMessage({ tone: 'error', text: error instanceof Error ? error.message : 'Export could not be completed.' });
    }
  };
  const showExportInFinder = async (filePath: string) => {
    const result = await window.lucifold.showInFinder(filePath);
    if (!result.ok) setMessage({ tone: 'error', text: result.message });
  };
  const updateSettings = (next: OptimizationSettings) => {
    if (scopeIds.length) {
      const nextOverrides = { ...overrides };
      for (const id of scopeIds) nextOverrides[id] = { ...next };
      setOverrides(nextOverrides);
      void window.lucifold.invalidate(scopeIds).then((nextItems) => setItems(nextItems));
      return;
    }
    const changedIds = items.filter((item) => settingsSignature(effectiveSettingsFor(item.id)) !== settingsSignature(resolveSettings(next, overrides[item.id]))).map((item) => item.id);
    setSettings(next);
    const nextAppSettings = { ...appSettings, defaultOptimization: next, lastProfile: next.profile, lastOutputPolicy: next.outputPolicy };
    setAppSettings(nextAppSettings);
    void window.lucifold.writeSettings(nextAppSettings);
    if (changedIds.length) void window.lucifold.invalidate(changedIds).then((nextItems) => setItems(nextItems));
  };
  const clearSelectedOverrides = () => {
    if (!scopeIds.length) return;
    const nextOverrides = { ...overrides };
    for (const id of scopeIds) delete nextOverrides[id];
    setOverrides(nextOverrides);
    void window.lucifold.invalidate(scopeIds).then((nextItems) => setItems(nextItems));
  };
  const updateAppSettings = (next: AppSettings) => { setAppSettings(next); void window.lucifold.writeSettings(next); };
  const applyPreset = (preset: Preset) => { setActivePresetId(preset.id); updateSettings({ ...preset.settings }); setView('optimize'); setMessage({ tone: 'info', text: `${preset.name} applied to the current batch scope.` }); };
  const savePreset = (preset: Preset) => { setPresets((current) => [...current.filter((candidate) => candidate.id !== preset.id), preset]); setActivePresetId(preset.id); void window.lucifold.savePreset(preset); setMessage({ tone: 'success', text: `${preset.name} saved locally.` }); };
  const deletePreset = (preset: Preset) => { if (window.confirm(`Delete the local preset “${preset.name}”?`)) { setPresets((current) => current.filter((candidate) => candidate.id !== preset.id)); if (activePresetId === preset.id) setActivePresetId(null); void window.lucifold.deletePreset(preset.id); } };
  const renamePreset = (preset: Preset) => { const name = window.prompt('Rename preset', preset.name); if (name?.trim() && name.trim() !== preset.name) savePreset({ ...preset, name: name.trim(), builtIn: false, updatedAt: new Date().toISOString() }); };
  const duplicatePreset = (preset: Preset) => savePreset({ ...preset, id: crypto.randomUUID(), name: `${preset.name} Copy`, builtIn: false, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
  const saveActivePreset = () => { if (activePreset) savePreset({ ...activePreset, settings: { ...editorSettings }, updatedAt: new Date().toISOString() }); };

  const chooseUpdateSource = async () => {
    setUpdateBusy(true);
    try {
      const result = await window.lucifold.chooseUpdateSource();
      if (result.ok && result.path) {
        const next = { ...appSettings, updateSourcePath: result.path };
        setAppSettings(next);
        setMessage({ tone: 'success', text: result.message });
      } else setMessage({ tone: 'error', text: result.message });
    } finally {
      setUpdateBusy(false);
    }
  };
  const checkForUpdates = async () => {
    setUpdateBusy(true);
    setUpdateProgress({ phase: 'checking', percent: 5, message: 'Checking the configured source repository and approved tags…' });
    try {
      const result = await window.lucifold.checkForUpdates();
      setUpdateCheck(result);
      setMessage({ tone: result.state === 'available' ? 'success' : result.state === 'up-to-date' ? 'info' : 'error', text: result.message });
    } catch (error) {
      setUpdateCheck({ state: 'error', currentVersion: appInfo?.version ?? 'unknown', message: error instanceof Error ? error.message : 'The update check could not be completed.', canInstall: false });
    } finally {
      setUpdateBusy(false);
      setUpdateProgress(null);
    }
  };
  const installUpdate = async () => {
    if (!updateCheck?.tag) return;
    setUpdateBusy(true);
    try {
      const response = await window.lucifold.installUpdate(updateCheck.tag);
      setMessage({ tone: response.accepted ? 'info' : 'error', text: response.message });
      if (!response.accepted) setUpdateProgress(null);
    } finally {
      setUpdateBusy(false);
    }
  };

  const handleDragEnter = (event: React.DragEvent<HTMLDivElement>) => {
    if (!Array.from(event.dataTransfer.types).includes('Files')) return;
    event.preventDefault();
    dragDepth.current += 1;
    setIsDraggingFiles(true);
  };
  const handleDragOver = (event: React.DragEvent<HTMLDivElement>) => {
    if (!Array.from(event.dataTransfer.types).includes('Files')) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
  };
  const handleDragLeave = (event: React.DragEvent<HTMLDivElement>) => {
    if (!Array.from(event.dataTransfer.types).includes('Files')) return;
    event.preventDefault();
    dragDepth.current = Math.max(0, dragDepth.current - 1);
    if (!dragDepth.current) setIsDraggingFiles(false);
  };
  const handleDrop = (event: React.DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    dragDepth.current = 0;
    setIsDraggingFiles(false);
    const paths = [...event.dataTransfer.files].map((file) => (file as File & { path?: string }).path).filter((filePath): filePath is string => Boolean(filePath));
    void importSelectedPaths(paths);
  };

  const appStyle = { '--queue-width': 'minmax(350px, 430px)' } as CSSProperties;
  return <div className={`app-shell ${isDraggingFiles ? 'dragging-files' : ''}`} style={appStyle} onDragEnter={handleDragEnter} onDragOver={handleDragOver} onDragLeave={handleDragLeave} onDrop={handleDrop}>
    {isDraggingFiles ? <div className="drop-overlay" role="status" aria-live="polite"><div className="drop-overlay-card"><Icon name="folder" size={28} /><strong>Drop images or folders to add</strong><span>lucifold will append supported files and report anything it cannot decode.</span></div></div> : null}
    <Sidebar view={view} setView={setView} itemCount={items.length} version={appInfo?.version ?? '1.0.1'} />
    <main className="app-main">
      {message ? <div className={`message-banner ${message.tone}`} role="status"><span>{message.text}</span>{message.actionPath ? <button className="secondary-button compact" onClick={() => void showExportInFinder(message.actionPath!)}>Show in Finder</button> : null}<button className="icon-button tiny" onClick={() => setMessage(null)} aria-label="Dismiss message"><Icon name="close" size={14} /></button></div> : null}
      {view === 'optimize' ? <div className="workspace-grid"><QueuePanel items={items} selectedId={selectedId} checkedIds={checkedIds} overrides={overrides} thumbnails={thumbnails} onSelect={setSelectedId} onCheck={(id, checked) => setCheckedIds((current) => { const next = new Set(current); if (checked) next.add(id); else next.delete(id); return next; })} onAddImages={addImages} onAddFolder={addFolder} onClear={removeAll} /><PreviewPane item={selectedItem} sourcePreview={sourcePreview} outputPreview={outputPreview} divider={divider} setDivider={setDivider} zoom={zoom} setZoom={setZoom} compareMode={compareMode} setCompareMode={setCompareMode} /><Inspector settings={editorSettings} setSettings={updateSettings} item={selectedItem} scopeLabel={scopeLabel} presets={presets} activePreset={activePreset} hasOverride={hasOverride} onApplyPreset={applyPreset} onSavePreset={saveActivePreset} onClearOverride={clearSelectedOverrides} /></div> : view === 'presets' ? <PresetsView presets={presets} settings={settings} onApply={applyPreset} onSave={savePreset} onDelete={deletePreset} onRename={renamePreset} onDuplicate={duplicatePreset} /> : view === 'settings' ? <ApplicationSettingsView settings={settings} appSettings={appSettings} appInfo={appInfo} updateCheck={updateCheck} updateProgress={updateProgress} updateBusy={updateBusy} onAppSettingsChange={updateAppSettings} onChooseSource={chooseUpdateSource} onCheckForUpdates={checkForUpdates} onInstallUpdate={installUpdate} /> : <div className="compare-view"><PreviewPane item={selectedItem} sourcePreview={sourcePreview} outputPreview={outputPreview} divider={divider} setDivider={setDivider} zoom={zoom} setZoom={setZoom} compareMode={compareMode} setCompareMode={setCompareMode} /></div>}
      {view === 'optimize' ? <FooterActions batch={batch} items={items} checkedIds={checkedIds} onOptimize={() => void optimize(false)} onCancel={() => void window.lucifold.cancel()} onExport={() => void exportResults()} onRetry={() => void optimize(true)} /> : null}
    </main>
  </div>;
}
