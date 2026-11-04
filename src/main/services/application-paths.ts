import os from 'node:os';
import path from 'node:path';

/**
 * Resolve the application data root without trusting a helper-provided HOME.
 * macOS GUI helpers may run with a temporary HOME, but the OS account home is
 * stable and independently established by the local account database.
 */
export function resolveCanonicalApplicationDataPath(appDataPath: string, appName: string, platform = process.platform, accountHome = platform === 'darwin' ? os.userInfo().homedir : undefined): string {
  if (!appName || path.isAbsolute(appName) || appName.includes(path.sep)) throw new Error('The application name is invalid.');
  if (platform === 'darwin') {
    if (!accountHome || !path.isAbsolute(accountHome)) throw new Error('The macOS account home could not be established.');
    return path.join(accountHome, 'Library', 'Application Support', appName);
  }
  if (!path.isAbsolute(appDataPath)) throw new Error('The application data root is invalid.');
  return path.join(appDataPath, appName);
}
