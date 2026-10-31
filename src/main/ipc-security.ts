import path from 'node:path';
import { fileURLToPath } from 'node:url';

export interface AuthorizedWindowLike {
  isDestroyed(): boolean;
  webContents: {
    mainFrame: unknown;
  };
}

export interface IpcFrameEventLike {
  sender: unknown;
  senderFrame?: {
    url?: unknown;
  } | null;
}

export type RendererUrlAuthorizer = (url: string) => boolean;

export function isAllowedRendererUrl(value: string, expectedFilePath: string, packaged: boolean): boolean {
  try {
    const url = new URL(value);
    if (url.username || url.password || url.search || url.hash) return false;
    if (url.protocol === 'http:') {
      return !packaged && (url.hostname === '127.0.0.1' || url.hostname === 'localhost') && url.port === '5173';
    }
    if (url.protocol !== 'file:' || url.hostname !== '') return false;
    return path.resolve(fileURLToPath(url)) === path.resolve(expectedFilePath);
  } catch {
    return false;
  }
}

/**
 * Privileged IPC is authorized only for the active window's exact main frame.
 * The frame identity check is intentionally separate from URL validation:
 * child frames and stale/detached frame events must fail even when their URL
 * happens to be the approved renderer URL.
 */
export function assertAuthorizedRendererFrame(
  activeWindow: AuthorizedWindowLike | null,
  event: IpcFrameEventLike,
  isTrustedRendererUrl: RendererUrlAuthorizer,
): void {
  if (!activeWindow || activeWindow.isDestroyed() || event.sender !== activeWindow.webContents) {
    throw new Error('The IPC sender is not the active lucifold window.');
  }
  const frame = event.senderFrame;
  if (!frame || frame !== activeWindow.webContents.mainFrame || typeof frame.url !== 'string' || !isTrustedRendererUrl(frame.url)) {
    throw new Error('The IPC sender is not the authorized lucifold main frame.');
  }
}
