import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import sharp from 'sharp';
import { inspectImage, optimizeImage } from '../src/main/services/image-service.js';
import { DEFAULT_SETTINGS } from '../src/shared/types.js';
import type { QueueItem } from '../src/shared/types.js';

const fixtureRoot = path.resolve('../lucifold/image-optimization-benchmark/fixtures/normalized');

async function fixture(name: string): Promise<QueueItem> {
  const filePath = path.join(fixtureRoot, name);
  const info = await inspectImage(filePath);
  return { ...info, progress: 0 };
}

async function hash(filePath: string): Promise<string> {
  return createHash('sha256').update(await fs.readFile(filePath)).digest('hex');
}

test('inspectImage detects supported content and actual dimensions', async () => {
  const item = await fixture('photograph-source.jpg');
  assert.equal(item.format, 'jpeg');
  assert.equal(item.width, 2400);
  assert.equal(item.height, 1078);
  assert.equal(item.hasAlpha, false);
});

test('JPEG preserve-format optimization writes a smaller measured result', async () => {
  const item = await fixture('photograph-source.jpg');
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'lucifold-jpeg-'));
  const result = await optimizeImage(item, { ...DEFAULT_SETTINGS, profile: 'fast', outputPolicy: 'preserve', quality: 80 }, directory);
  assert.equal(result.status, 'complete');
  assert.equal(result.outputFormat, 'jpeg');
  assert.ok(result.outputPath);
  assert.ok(result.outputBytes! < item.bytes);
  const output = await inspectImage(result.outputPath!);
  assert.equal(output.format, 'jpeg');
  assert.equal(output.width, item.width);
  assert.equal(output.height, item.height);
});

test('persisted lossless preference does not break ordinary JPEG optimization', async () => {
  const item = await fixture('photograph-source.jpg');
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'lucifold-jpeg-lossless-preference-'));
  const result = await optimizeImage(item, { ...DEFAULT_SETTINGS, profile: 'fast', outputPolicy: 'preserve', lossless: true, quality: 80 }, directory);
  assert.notEqual(result.status, 'failed');
  assert.equal(result.outputFormat, 'jpeg');
  await fs.rm(directory, { recursive: true, force: true });
});

test('explicit lossless JPEG conversion is rejected instead of silently becoming lossy', async () => {
  const item = await fixture('photograph-source.jpg');
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'lucifold-jpeg-lossless-explicit-'));
  await assert.rejects(optimizeImage(item, { ...DEFAULT_SETTINGS, outputPolicy: 'convert', outputFormat: 'jpeg', lossless: true, quality: 80 }, directory), /JPEG does not support lossless/i);
  await fs.rm(directory, { recursive: true, force: true });
});

test('PNG lossless optimization preserves decoded RGBA pixels and alpha', async () => {
  const item = await fixture('transparent-logo.png');
  const originalHash = await hash(item.path);
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'lucifold-png-'));
  const result = await optimizeImage(item, { ...DEFAULT_SETTINGS, profile: 'balanced', outputPolicy: 'preserve', lossless: true }, directory);
  assert.ok(result.status === 'complete' || result.status === 'no-improvement');
  assert.equal(result.outputFormat, 'png');
  assert.ok(result.outputPath);
  const source = await sharp(item.path).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const output = await sharp(result.outputPath!).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  assert.equal(output.info.width, source.info.width);
  assert.equal(output.info.height, source.info.height);
  assert.deepEqual(output.data, source.data);
  assert.equal(await hash(item.path), originalHash);
});

test('explicit JPEG conversion rejects transparent inputs instead of dropping alpha', async () => {
  const item = await fixture('transparent-logo.png');
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'lucifold-alpha-'));
  await assert.rejects(
    optimizeImage(item, { ...DEFAULT_SETTINGS, outputPolicy: 'convert', outputFormat: 'jpeg', quality: 80 }, directory),
    /cannot preserve transparency/i,
  );
});

test('AVIF is recognized from a HEIF-family container and round-trips through optimization', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lucifold-avif-'));
  const avifPath = path.join(root, 'fixture.avif');
  await sharp(path.join(fixtureRoot, 'website-graphic.png')).avif({ quality: 65, effort: 3 }).toFile(avifPath);
  const avifInfo = await inspectImage(avifPath);
  assert.equal(avifInfo.format, 'avif');
  assert.ok(avifInfo.width > 0 && avifInfo.height > 0);
  const result = await optimizeImage({ ...avifInfo, progress: 0 }, { ...DEFAULT_SETTINGS, profile: 'fast', outputPolicy: 'preserve', quality: 65 }, root);
  assert.notEqual(result.status, 'failed');
  assert.equal(result.outputFormat, 'avif');
  assert.ok(result.outputPath);
  assert.equal((await inspectImage(result.outputPath!)).format, 'avif');
  await fs.rm(root, { recursive: true, force: true });
});

test('WebP is recognized and remains WebP through optimization', async () => {
  const item = await fixture('website-graphic.png');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lucifold-webp-'));
  const webpPath = path.join(root, 'fixture.webp');
  await sharp(item.path).webp({ quality: 80 }).toFile(webpPath);
  const webpInfo = await inspectImage(webpPath);
  assert.equal(webpInfo.format, 'webp');
  const result = await optimizeImage({ ...webpInfo, progress: 0 }, { ...DEFAULT_SETTINGS, profile: 'fast', outputPolicy: 'preserve', quality: 80 }, root);
  assert.notEqual(result.status, 'failed');
  assert.equal(result.outputFormat, 'webp');
  assert.ok(result.outputPath);
  assert.equal((await inspectImage(result.outputPath!)).format, 'webp');
  await fs.rm(root, { recursive: true, force: true });
});
