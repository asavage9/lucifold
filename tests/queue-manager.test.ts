import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { QueueManager, importPaths } from '../src/main/services/queue-manager.js';
import { settingsSignature } from '../src/shared/settings.js';
import { DEFAULT_SETTINGS, type QueueItem } from '../src/shared/types.js';

const fixtureRoot = path.resolve('../lucifold/image-optimization-benchmark/fixtures/normalized');

async function identity(filePath: string) {
  const stat = await fs.lstat(filePath);
  return { device: stat.dev, inode: stat.ino, size: stat.size, mtimeMs: stat.mtimeMs };
}

test('folder import appends supported files and reports unsupported entries', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lucifold-import-'));
  await fs.copyFile(path.join(fixtureRoot, 'transparent-logo.png'), path.join(root, 'logo.png'));
  await fs.writeFile(path.join(root, 'notes.txt'), 'not an image');
  const response = await importPaths([root]);
  assert.equal(response.items.length, 1);
  assert.equal(response.items[0].format, 'png');
  assert.equal(response.issues.length, 1);
  assert.match(response.issues[0].message, /unsupported/i);
  await fs.rm(root, { recursive: true, force: true });
});

test('import rejects a directly selected symbolic-link image', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lucifold-import-symlink-'));
  const original = path.join(root, 'original.png');
  const linked = path.join(root, 'selected.png');
  await fs.copyFile(path.join(fixtureRoot, 'transparent-logo.png'), original);
  await fs.symlink(original, linked);
  const response = await importPaths([linked]);
  assert.equal(response.items.length, 0);
  assert.match(response.issues[0].message, /symbolic-link/i);
  await fs.rm(root, { recursive: true, force: true });
});

test('export refuses stale results and collision-safely preserves valid outputs', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lucifold-export-'));
  const output = path.join(root, 'optimized.jpg');
  const destination = path.join(root, 'destination');
  await fs.writeFile(output, 'encoded');
  const outputIdentity = await identity(output);
  const item: QueueItem = {
    id: 'queue-item',
    path: path.join(root, 'source.jpg'),
    name: 'source.jpg',
    relativePath: 'folder/source.jpg',
    format: 'jpeg',
    bytes: 100,
    width: 10,
    height: 10,
    hasAlpha: false,
    isAnimated: false,
    result: { status: 'complete', outputPath: output, outputFormat: 'jpeg', outputBytes: 7, settingsHash: settingsSignature(DEFAULT_SETTINGS), outputIdentity },
  };
  const queue = new QueueManager();
  queue.addItems([item]);
  const stale = await queue.exportResults({ itemIds: [item.id], destination, preserveHierarchy: true, expectedSettingsHashByItem: { [item.id]: 'changed' } });
  assert.equal(stale.exported.length, 0);
  assert.match(stale.failures[0].message, /stale/i);

  const first = await queue.exportResults({ itemIds: [item.id], destination, preserveHierarchy: true, expectedSettingsHashByItem: { [item.id]: settingsSignature(DEFAULT_SETTINGS) } });
  const second = await queue.exportResults({ itemIds: [item.id], destination, preserveHierarchy: true, expectedSettingsHashByItem: { [item.id]: settingsSignature(DEFAULT_SETTINGS) } });
  assert.equal(first.exported.length, 1);
  assert.equal(second.exported.length, 1);
  assert.notEqual(first.exported[0].path, second.exported[0].path);
  assert.ok(first.exported[0].path.endsWith(path.join('destination', 'folder', 'source.jpg')));
  assert.equal(await fs.readFile(first.exported[0].path, 'utf8'), 'encoded');
  assert.equal(await fs.readFile(second.exported[0].path, 'utf8'), 'encoded');
  const flat = await queue.exportResults({ itemIds: [item.id], destination: path.join(root, 'flat'), preserveHierarchy: false, expectedSettingsHashByItem: { [item.id]: settingsSignature(DEFAULT_SETTINGS) } });
  assert.ok(flat.exported[0].path.endsWith(path.join('flat', 'source.jpg')));
  await fs.rm(root, { recursive: true, force: true });
});

test('recursive import applies one file limit across the complete traversal', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lucifold-import-limit-'));
  await fs.mkdir(path.join(root, 'first'), { recursive: true });
  await fs.mkdir(path.join(root, 'second'), { recursive: true });
  for (let index = 0; index < 2_501; index += 1) {
    await fs.writeFile(path.join(root, 'first', `entry-${index}.txt`), 'x');
    await fs.writeFile(path.join(root, 'second', `entry-${index}.txt`), 'x');
  }
  const response = await importPaths([root]);
  assert.match(response.issues[0].message, /5,000-file safety limit/i);
  await fs.rm(root, { recursive: true, force: true });
});

test('folder import applies one cumulative file limit across multiple selected roots', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lucifold-import-multi-root-limit-'));
  const first = path.join(root, 'first');
  const second = path.join(root, 'second');
  await fs.mkdir(first);
  await fs.mkdir(second);
  for (let index = 0; index < 2_501; index += 1) await fs.writeFile(path.join(first, `first-${index}.txt`), 'x');
  for (let index = 0; index < 2_500; index += 1) await fs.writeFile(path.join(second, `second-${index}.txt`), 'x');
  const response = await importPaths([first, second]);
  assert.ok(response.issues.some((issue) => /5,000-file safety limit/i.test(issue.message)));
  await fs.rm(root, { recursive: true, force: true });
});

test('import request budget counts exactly 5,000 and rejects the 5,001st direct file', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lucifold-import-direct-limit-'));
  const files = await Promise.all(Array.from({ length: 5_001 }, async (_, index) => {
    const filePath = path.join(root, `direct-${index}.txt`);
    await fs.writeFile(filePath, 'x');
    return filePath;
  }));
  const exact = await importPaths(files.slice(0, 5_000));
  assert.equal(exact.issues.some((issue) => /5,000-file safety limit/i.test(issue.message)), false);
  const over = await importPaths(files);
  assert.ok(over.issues.some((issue) => /5,000-file safety limit/i.test(issue.message)));
  await fs.rm(root, { recursive: true, force: true });
});

test('mixed folder and direct-file selections share one import budget', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lucifold-import-mixed-limit-'));
  const folder = path.join(root, 'folder');
  await fs.mkdir(folder);
  await Promise.all(Array.from({ length: 4_999 }, async (_, index) => fs.writeFile(path.join(folder, `folder-${index}.txt`), 'x')));
  const directA = path.join(root, 'direct-a.txt');
  const directB = path.join(root, 'direct-b.txt');
  await fs.writeFile(directA, 'x');
  await fs.writeFile(directB, 'x');
  const response = await importPaths([folder, directA, directB]);
  assert.ok(response.issues.some((issue) => /5,000-file safety limit/i.test(issue.message)));
  await fs.rm(root, { recursive: true, force: true });
});

test('export rejects symlinked hierarchy parents and preserves the source on overlap', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lucifold-export-safety-'));
  const source = path.join(root, 'source.jpg');
  const output = path.join(root, 'optimized.jpg');
  const destination = path.join(root, 'destination');
  const outside = path.join(root, 'outside');
  const linkedParent = path.join(destination, 'linked');
  await fs.mkdir(destination, { recursive: true });
  await fs.mkdir(outside, { recursive: true });
  await fs.writeFile(source, 'original');
  await fs.writeFile(output, 'encoded');
  const outputIdentity = await identity(output);
  const sourceIdentity = await identity(source);
  await fs.symlink(outside, linkedParent, 'dir');
  const item: QueueItem = {
    id: 'symlink-item', path: source, name: 'source.jpg', relativePath: 'linked/source.jpg', format: 'jpeg', bytes: 100, width: 10, height: 10, hasAlpha: false, isAnimated: false,
    result: { status: 'complete', outputPath: output, outputFormat: 'jpeg', outputBytes: 7, settingsHash: settingsSignature(DEFAULT_SETTINGS), outputIdentity },
  };
  const queue = new QueueManager();
  queue.addItems([item]);
  const report = await queue.exportResults({ itemIds: [item.id], destination, preserveHierarchy: true, expectedSettingsHashByItem: { [item.id]: settingsSignature(DEFAULT_SETTINGS) } });
  assert.equal(report.exported.length, 0);
  assert.match(report.failures[0].message, /symbolic-link/i);
  assert.equal(await fs.readFile(source, 'utf8'), 'original');

  item.relativePath = 'source.jpg';
  item.result = { ...item.result!, outputPath: source, outputIdentity: sourceIdentity };
  const overlap = await queue.exportResults({ itemIds: [item.id], destination: root, preserveHierarchy: true, expectedSettingsHashByItem: { [item.id]: settingsSignature(DEFAULT_SETTINGS) } });
  assert.equal(overlap.exported.length, 1);
  assert.notEqual(overlap.exported[0].path, source);
  assert.equal(await fs.readFile(source, 'utf8'), 'original');
  await fs.rm(root, { recursive: true, force: true });
});

test('export rejects a symlinked destination root', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lucifold-export-root-link-'));
  const source = path.join(root, 'source.jpg');
  const output = path.join(root, 'optimized.jpg');
  const outside = path.join(root, 'outside');
  const destination = path.join(root, 'destination');
  await fs.mkdir(outside);
  await fs.writeFile(source, 'original');
  await fs.writeFile(output, 'encoded');
  await fs.symlink(outside, destination, 'dir');
  const outputIdentity = await identity(output);
  const item: QueueItem = {
    id: 'root-link-item', path: source, name: 'source.jpg', relativePath: 'source.jpg', format: 'jpeg', bytes: 100, width: 10, height: 10, hasAlpha: false, isAnimated: false,
    result: { status: 'complete', outputPath: output, outputFormat: 'jpeg', outputBytes: 7, settingsHash: settingsSignature(DEFAULT_SETTINGS), outputIdentity },
  };
  const queue = new QueueManager();
  queue.addItems([item]);
  await assert.rejects(queue.exportResults({ itemIds: [item.id], destination, preserveHierarchy: false, expectedSettingsHashByItem: { [item.id]: settingsSignature(DEFAULT_SETTINGS) } }), /symbolic-link path/i);
  await assert.rejects(fs.access(path.join(outside, 'source.jpg')));
  await fs.rm(root, { recursive: true, force: true });
});

test('export rejects a symlinked ancestor of the destination root', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lucifold-export-ancestor-link-'));
  const source = path.join(root, 'source.jpg');
  const output = path.join(root, 'optimized.jpg');
  const outside = path.join(root, 'outside');
  const alias = path.join(root, 'alias');
  const destination = path.join(alias, 'destination');
  await fs.mkdir(outside);
  await fs.writeFile(source, 'original');
  await fs.writeFile(output, 'encoded');
  await fs.symlink(outside, alias, 'dir');
  const outputIdentity = await identity(output);
  const item: QueueItem = {
    id: 'ancestor-link-item', path: source, name: 'source.jpg', relativePath: 'source.jpg', format: 'jpeg', bytes: 100, width: 10, height: 10, hasAlpha: false, isAnimated: false,
    result: { status: 'complete', outputPath: output, outputFormat: 'jpeg', outputBytes: 7, settingsHash: settingsSignature(DEFAULT_SETTINGS), outputIdentity },
  };
  const queue = new QueueManager();
  queue.addItems([item]);
  await assert.rejects(queue.exportResults({ itemIds: [item.id], destination, preserveHierarchy: false, expectedSettingsHashByItem: { [item.id]: settingsSignature(DEFAULT_SETTINGS) } }), /symbolic-link path/i);
  await assert.rejects(fs.access(path.join(outside, 'destination', 'source.jpg')));
  await fs.rm(root, { recursive: true, force: true });
});

test('concurrent same-name exports publish without overwriting each other', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lucifold-export-race-'));
  const output = path.join(root, 'optimized.jpg');
  const destination = path.join(root, 'destination');
  await fs.writeFile(output, 'encoded');
  const outputIdentity = await identity(output);
  const item: QueueItem = {
    id: 'race-item', path: path.join(root, 'source.jpg'), name: 'source.jpg', relativePath: 'source.jpg', format: 'jpeg', bytes: 100, width: 10, height: 10, hasAlpha: false, isAnimated: false,
    result: { status: 'complete', outputPath: output, outputFormat: 'jpeg', outputBytes: 7, settingsHash: settingsSignature(DEFAULT_SETTINGS), outputIdentity },
  };
  const queue = new QueueManager();
  queue.addItems([item]);
  const reports = await Promise.all(Array.from({ length: 8 }, () => queue.exportResults({ itemIds: [item.id], destination, preserveHierarchy: false, expectedSettingsHashByItem: { [item.id]: settingsSignature(DEFAULT_SETTINGS) } })));
  const paths = reports.flatMap((report) => report.exported.map((entry) => entry.path));
  assert.equal(paths.length, 8);
  assert.equal(new Set(paths).size, 8);
  for (const exportedPath of paths) assert.equal(await fs.readFile(exportedPath, 'utf8'), 'encoded');
  await fs.rm(root, { recursive: true, force: true });
});

test('export rejects a result path replaced by a symbolic link', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lucifold-export-result-link-'));
  const output = path.join(root, 'optimized.jpg');
  const secret = path.join(root, 'secret.txt');
  const destination = path.join(root, 'destination');
  await fs.writeFile(output, 'encoded');
  await fs.writeFile(secret, 'not an image result');
  const outputIdentity = await identity(output);
  await fs.rm(output);
  await fs.symlink(secret, output);
  const item: QueueItem = {
    id: 'substituted-result', path: path.join(root, 'source.jpg'), name: 'source.jpg', relativePath: 'source.jpg', format: 'jpeg', bytes: 100, width: 10, height: 10, hasAlpha: false, isAnimated: false,
    result: { status: 'complete', outputPath: output, outputFormat: 'jpeg', outputBytes: 7, settingsHash: settingsSignature(DEFAULT_SETTINGS), outputIdentity },
  };
  const queue = new QueueManager();
  queue.addItems([item]);
  const report = await queue.exportResults({ itemIds: [item.id], destination, preserveHierarchy: false, expectedSettingsHashByItem: { [item.id]: settingsSignature(DEFAULT_SETTINGS) } });
  assert.equal(report.exported.length, 0);
  assert.match(report.failures[0].message, /symbolic|regular file|changed/i);
  await fs.rm(root, { recursive: true, force: true });
});

test('concurrent directory mutation cannot redirect publication to an external sentinel', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lucifold-export-directory-mutation-'));
  const source = path.join(root, 'optimized.bin');
  const destination = path.join(root, 'destination');
  const hierarchy = path.join(destination, 'linked');
  const movedHierarchy = path.join(destination, 'linked-moved');
  const outside = path.join(root, 'outside');
  const sentinel = path.join(outside, 'sentinel.txt');
  await fs.mkdir(hierarchy, { recursive: true });
  await fs.mkdir(outside);
  await fs.writeFile(sentinel, 'unchanged');
  await fs.writeFile(source, Buffer.alloc(32 * 1024 * 1024, 0x5a));
  const outputIdentity = await identity(source);
  const item: QueueItem = {
    id: 'directory-mutation-item', path: path.join(root, 'source.jpg'), name: 'source.jpg', relativePath: 'linked/source.jpg', format: 'jpeg', bytes: 100, width: 10, height: 10, hasAlpha: false, isAnimated: false,
    result: { status: 'complete', outputPath: source, outputFormat: 'jpeg', outputBytes: 32 * 1024 * 1024, settingsHash: settingsSignature(DEFAULT_SETTINGS), outputIdentity },
  };
  const queue = new QueueManager();
  queue.addItems([item]);
  let finished = false;
  const mutator = (async () => {
    for (let attempt = 0; attempt < 250 && !finished; attempt += 1) {
      try {
        await fs.rename(hierarchy, movedHierarchy);
        await fs.symlink(outside, hierarchy, 'dir');
        await fs.rm(hierarchy, { recursive: true, force: true });
        await fs.rename(movedHierarchy, hierarchy);
      } catch {
        await fs.rm(hierarchy, { recursive: true, force: true }).catch(() => undefined);
        await fs.rename(movedHierarchy, hierarchy).catch(() => undefined);
      }
    }
  })();
  let report;
  try {
    report = await queue.exportResults({ itemIds: [item.id], destination, preserveHierarchy: true, expectedSettingsHashByItem: { [item.id]: settingsSignature(DEFAULT_SETTINGS) } });
  } finally {
    finished = true;
    await mutator;
    await fs.rm(hierarchy, { recursive: true, force: true }).catch(() => undefined);
    await fs.rename(movedHierarchy, hierarchy).catch(() => undefined);
  }
  assert.equal(await fs.readFile(sentinel, 'utf8'), 'unchanged');
  await assert.rejects(fs.access(path.join(outside, 'source.jpg')));
  if (report.exported.length > 0) assert.equal(await fs.readFile(path.join(hierarchy, 'source.jpg')), await fs.readFile(source));
  await fs.rm(root, { recursive: true, force: true });
});

test('failed native publication reports accurately and leaves no temporary export files', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lucifold-export-failure-recovery-'));
  const source = path.join(root, 'optimized.jpg');
  const destination = path.join(root, 'destination');
  const invalidComponent = path.join(destination, 'not-a-directory');
  await fs.mkdir(destination);
  await fs.writeFile(invalidComponent, 'file component');
  await fs.writeFile(source, 'encoded');
  const outputIdentity = await identity(source);
  const item: QueueItem = {
    id: 'invalid-component-item', path: path.join(root, 'source.jpg'), name: 'source.jpg', relativePath: 'not-a-directory/source.jpg', format: 'jpeg', bytes: 100, width: 10, height: 10, hasAlpha: false, isAnimated: false,
    result: { status: 'complete', outputPath: source, outputFormat: 'jpeg', outputBytes: 7, settingsHash: settingsSignature(DEFAULT_SETTINGS), outputIdentity },
  };
  const queue = new QueueManager();
  queue.addItems([item]);
  const report = await queue.exportResults({ itemIds: [item.id], destination, preserveHierarchy: true, expectedSettingsHashByItem: { [item.id]: settingsSignature(DEFAULT_SETTINGS) } });
  assert.equal(report.exported.length, 0);
  assert.match(report.failures[0].message, /directory|publish/i);
  assert.deepEqual(await fs.readdir(destination), ['not-a-directory']);

  if (typeof process.getuid === 'function' && process.getuid() !== 0) {
    const locked = path.join(root, 'locked');
    await fs.mkdir(locked);
    await fs.chmod(locked, 0o500);
    const lockedReport = await queue.exportResults({ itemIds: [item.id], destination: locked, preserveHierarchy: false, expectedSettingsHashByItem: { [item.id]: settingsSignature(DEFAULT_SETTINGS) } });
    assert.equal(lockedReport.exported.length, 0);
    assert.match(lockedReport.failures[0].message, /permission|export|publish/i);
    await fs.chmod(locked, 0o700);
  } else {
    t.diagnostic('permission-failure branch skipped when running as root');
  }
  await fs.rm(root, { recursive: true, force: true });
});
