import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveDroppedFilePaths } from '../src/renderer/drop-paths.js';

function file(name: string): File { return { name } as File; }

test('drop path resolution handles individual, multiple, and folder-backed files', () => {
  const files = [file('one.jpg'), file('two.png'), file('folder')];
  assert.deepEqual(resolveDroppedFilePaths(files, (candidate) => `/Users/test/${candidate.name}`), { paths: ['/Users/test/one.jpg', '/Users/test/two.png', '/Users/test/folder'], unresolved: 0 });
});

test('drop path resolution reports empty, unresolved, and thrown file lookups', () => {
  assert.deepEqual(resolveDroppedFilePaths([], () => null), { paths: [], unresolved: 0 });
  assert.deepEqual(resolveDroppedFilePaths([file('unsupported.bin'), file('ghost.jpg')], (candidate) => candidate.name === 'ghost.jpg' ? null : (() => { throw new Error('not filesystem-backed'); })()), { paths: [], unresolved: 2 });
});

test('drop path resolution preserves resolvable files while reporting unresolved entries', () => {
  assert.deepEqual(resolveDroppedFilePaths([file('valid.jpg'), file('unavailable.jpg')], (candidate) => candidate.name === 'valid.jpg' ? '/tmp/valid.jpg' : null), { paths: ['/tmp/valid.jpg'], unresolved: 1 });
});
