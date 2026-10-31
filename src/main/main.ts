import { app, BrowserWindow, session } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { registerIpc } from './ipc.js';
import { isAllowedRendererUrl } from './ipc-security.js';
import { isApprovedTag, markUpdateVerified } from './services/update-service.js';
import { recoverInterruptedUpdate, runUpdateHelper } from './services/update-helper.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
let pendingStartupVerification: { statusPath: string; version: string; identity: string; appPath: string } | null = null;

function createWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1480,
    height: 920,
    minWidth: 840,
    minHeight: 620,
    title: 'lucifold',
    backgroundColor: '#0B1220',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event, url) => {
    if (!isAllowedRendererNavigation(url)) event.preventDefault();
  });
  const developmentUrl = process.env.ELECTRON_RENDERER_URL;
  const rendererPath = path.resolve(__dirname, '../../renderer/index.html');
  if (!app.isPackaged && developmentUrl && isAllowedRendererUrl(developmentUrl, rendererPath, false)) void window.loadURL(developmentUrl);
  else void window.loadFile(path.join(__dirname, '../../renderer/index.html'));
  window.once('ready-to-show', () => {
    window.show();
    const verification = pendingStartupVerification;
    if (verification) {
      pendingStartupVerification = null;
      void markUpdateVerified(verification.statusPath, verification.version, app.getVersion(), verification.appPath, verification.identity).catch((error) => console.warn('lucifold update verification could not be recorded', error));
    }
  });
  registerIpc(window);
  return window;
}

const helperPlanPath = argumentAfter('--lucifold-update-helper');
const verificationStatusPath = argumentAfter('--lucifold-update-verify');
const verificationVersion = verificationStatusPath ? process.argv[process.argv.indexOf('--lucifold-update-verify') + 2] : undefined;
const verificationIdentity = verificationStatusPath ? process.argv[process.argv.indexOf('--lucifold-update-verify') + 3] : undefined;

app.whenReady().then(async () => {
  if (helperPlanPath) {
    try {
      await runUpdateHelper(helperPlanPath);
      app.quit();
    } catch (error) {
      console.error('lucifold update helper failed', error);
      app.exit(1);
    }
    return;
  }

  if (verificationStatusPath && verificationVersion && verificationIdentity && isSafeVerificationArguments(verificationStatusPath, verificationVersion, verificationIdentity)) {
    const currentAppPath = bundlePathFromExecutable(process.execPath);
    if (currentAppPath) pendingStartupVerification = { statusPath: verificationStatusPath, version: verificationVersion, identity: verificationIdentity, appPath: currentAppPath };
  } else if (app.isPackaged) {
    const currentAppPath = bundlePathFromExecutable(process.execPath);
    if (currentAppPath) await recoverInterruptedUpdate(app.getPath('userData'), currentAppPath, app.getVersion()).catch((error) => console.warn('lucifold interrupted update recovery failed', error));
  }

  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({ responseHeaders: { ...details.responseHeaders, 'Content-Security-Policy': ["default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self' http://127.0.0.1:5173"] } });
  });
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

function argumentAfter(argument: string): string | undefined {
  const index = process.argv.indexOf(argument);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function isAllowedRendererNavigation(value: string): boolean {
  return isAllowedRendererUrl(value, path.resolve(__dirname, '../../renderer/index.html'), app.isPackaged);
}

function isSafeVerificationArguments(statusPath: string, version: string, identity: string): boolean {
  return path.resolve(statusPath) === path.resolve(path.join(app.getPath('userData'), 'update-status.json')) && isApprovedTag(`v${version}`) && /^[0-9a-f]{64}$/i.test(identity);
}

function bundlePathFromExecutable(executablePath: string): string | undefined {
  const parts = path.resolve(executablePath).split(path.sep);
  for (let index = parts.length - 1; index >= 0; index -= 1) {
    if (parts[index].endsWith('.app')) return parts.slice(0, index + 1).join(path.sep) || path.sep;
  }
  return undefined;
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
