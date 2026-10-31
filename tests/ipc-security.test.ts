import assert from 'node:assert/strict';
import test from 'node:test';
import { assertAuthorizedRendererFrame, isAllowedRendererUrl, type AuthorizedWindowLike } from '../src/main/ipc-security.js';

const trustedUrl = 'file:///lucifold/dist/renderer/index.html';

function fixtureWindow() {
  const mainFrame = { url: trustedUrl };
  const webContents = { mainFrame };
  const activeWindow: AuthorizedWindowLike = { isDestroyed: () => false, webContents };
  return { activeWindow, webContents, mainFrame };
}

function invokePrivilegedAction(activeWindow: AuthorizedWindowLike | null, event: { sender: unknown; senderFrame?: { url?: unknown } | null }): number {
  let privilegedActions = 0;
  assertAuthorizedRendererFrame(activeWindow, event, (url) => isAllowedRendererUrl(url, '/lucifold/dist/renderer/index.html', true));
  privilegedActions += 1;
  return privilegedActions;
}

test('authorized main-frame IPC proceeds and performs the privileged action', () => {
  const { activeWindow, webContents, mainFrame } = fixtureWindow();
  assert.equal(invokePrivilegedAction(activeWindow, { sender: webContents, senderFrame: mainFrame }), 1);
});

test('child-frame IPC is rejected even when it uses the trusted renderer URL', () => {
  const { activeWindow, webContents } = fixtureWindow();
  const childFrame = { url: trustedUrl };
  assert.throws(() => invokePrivilegedAction(activeWindow, { sender: webContents, senderFrame: childFrame }), /authorized lucifold main frame/i);
});

test('missing or detached frame identities are rejected without a privileged action', () => {
  const { activeWindow, webContents } = fixtureWindow();
  assert.throws(() => invokePrivilegedAction(activeWindow, { sender: webContents }), /authorized lucifold main frame/i);
  assert.throws(() => invokePrivilegedAction(activeWindow, { sender: webContents, senderFrame: null }), /authorized lucifold main frame/i);
});

test('unexpected windows and destroyed active windows are rejected', () => {
  const { activeWindow, mainFrame } = fixtureWindow();
  const otherWindowContents = { mainFrame };
  assert.throws(() => invokePrivilegedAction(activeWindow, { sender: otherWindowContents, senderFrame: mainFrame }), /active lucifold window/i);
  const destroyedWindow = { ...activeWindow, isDestroyed: () => true };
  assert.throws(() => invokePrivilegedAction(destroyedWindow, { sender: activeWindow.webContents, senderFrame: mainFrame }), /active lucifold window/i);
});

test('unexpected navigation and redirect URLs are rejected', () => {
  const { activeWindow, webContents, mainFrame } = fixtureWindow();
  for (const url of ['file:///lucifold/dist/renderer/other.html', 'file:///lucifold/dist/renderer/index.html?redirect=1', 'https://example.invalid/']) {
    assert.throws(() => invokePrivilegedAction(activeWindow, { sender: webContents, senderFrame: { ...mainFrame, url } }), /authorized lucifold main frame/i);
  }
});

test('production renderer authorization requires the exact URL without query or fragment', () => {
  const expectedPath = '/lucifold/dist/renderer/index.html';
  assert.equal(isAllowedRendererUrl('file:///lucifold/dist/renderer/index.html', expectedPath, true), true);
  assert.equal(isAllowedRendererUrl('file:///lucifold/dist/renderer/index.html?redirect=1', expectedPath, true), false);
  assert.equal(isAllowedRendererUrl('file:///lucifold/dist/renderer/index.html#redirect', expectedPath, true), false);
  assert.equal(isAllowedRendererUrl('file:///lucifold/dist/renderer/other.html', expectedPath, true), false);
});

test('development file-renderer startup remains authorized when npm start uses loadFile', () => {
  assert.equal(isAllowedRendererUrl('file:///lucifold/dist/renderer/index.html', '/lucifold/dist/renderer/index.html', false), true);
});
