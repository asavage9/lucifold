import { constants as fsConstants, promises as fs } from 'node:fs';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { applicationIdentity, assertApplicationBundle, isApprovedTag, isPathWithin, readUpdateStatus, releaseUpdateLock, syncDirectory, UPDATE_PLAN_VERSION, writeUpdateStatus, type UpdatePlan } from './update-service.js';

const PARENT_EXIT_TIMEOUT = 60_000;
const STARTUP_VERIFY_TIMEOUT = 45_000;

export async function runUpdateHelper(planPath: string, options: { startupVerifyTimeout?: number } = {}): Promise<void> {
  let plan: UpdatePlan | undefined;
  try {
    plan = await readPlan(planPath);
    validatePlan(plan, bundlePathFromExecutable(process.execPath), true);
    await assertLockOwnership(plan);
    await waitForParentExit(plan.parentPid, PARENT_EXIT_TIMEOUT);
    await fs.access(plan.lockPath);
    await assertKnownGoodApplication(plan);
    await fs.mkdir(plan.backupRoot, { recursive: true, mode: 0o700 });
    await syncDirectory(path.dirname(plan.backupRoot));
    await fs.access(path.dirname(plan.targetAppPath), fsConstants.W_OK);
    await writePendingStatus(plan);
    await movePath(plan.targetAppPath, plan.backupPath);
    await movePath(plan.stagedAppPath, plan.targetAppPath);
    await assertApplicationBundle(plan.targetAppPath);
    launchInstalledApp(plan.targetExecutable, ['--lucifold-update-verify', plan.statusPath, plan.newVersion, plan.expectedAppIdentity!]);
    await waitForVerifiedStatus(plan.statusPath, plan.newVersion, options.startupVerifyTimeout ?? STARTUP_VERIFY_TIMEOUT);
    await writeUpdateStatus(plan.statusPath, { state: 'installed', version: plan.newVersion, message: `lucifold ${plan.newVersion} installed and verified successfully.`, timestamp: new Date().toISOString(), backupPath: plan.backupPath, lockPath: plan.lockPath, stagingRoot: plan.stagingRoot, targetAppPath: plan.targetAppPath, transactionId: plan.transactionId, applicationIdentity: plan.expectedAppIdentity, knownGoodApplicationIdentity: plan.knownGoodApplicationIdentity });
    await fs.rm(plan.backupRoot, { recursive: true, force: true }).catch(() => undefined);
    await fs.rm(plan.stagingRoot, { recursive: true, force: true }).catch(() => undefined);
  } catch (error) {
    if (plan && isSafeStatusPath(plan)) {
      await handleInstallationFailure(plan, error);
      await fs.rm(plan.stagingRoot, { recursive: true, force: true }).catch(() => undefined);
    }
    throw error;
  } finally {
    if (plan && isSafeStatusPath(plan)) await releaseOwnedUpdateLock(plan);
  }
}

export async function performInstallationForTest(plan: UpdatePlan, move: typeof movePath = movePath, launch: typeof launchInstalledApp = launchInstalledApp): Promise<void> {
  const effectivePlan: UpdatePlan = { ...plan, transactionId: plan.transactionId ?? randomUUID(), expectedAppIdentity: plan.expectedAppIdentity ?? await applicationIdentity(plan.stagedAppPath), knownGoodApplicationIdentity: plan.knownGoodApplicationIdentity ?? await applicationIdentity(plan.targetAppPath) };
  validatePlan(effectivePlan);
  await fs.mkdir(effectivePlan.backupRoot, { recursive: true, mode: 0o700 });
  try {
    await writePendingStatus(effectivePlan);
    await move(effectivePlan.targetAppPath, effectivePlan.backupPath);
    await move(effectivePlan.stagedAppPath, effectivePlan.targetAppPath);
    await assertApplicationBundle(effectivePlan.targetAppPath);
    launch(effectivePlan.targetExecutable, []);
    await writeUpdateStatus(effectivePlan.statusPath, { state: 'installed', version: effectivePlan.newVersion, message: `lucifold ${effectivePlan.newVersion} installed successfully.`, timestamp: new Date().toISOString(), backupPath: effectivePlan.backupPath, lockPath: effectivePlan.lockPath, stagingRoot: effectivePlan.stagingRoot, targetAppPath: effectivePlan.targetAppPath, transactionId: effectivePlan.transactionId, applicationIdentity: effectivePlan.expectedAppIdentity, knownGoodApplicationIdentity: effectivePlan.knownGoodApplicationIdentity });
  } catch (error) {
    await handleInstallationFailure(effectivePlan, error, move);
    throw error;
  }
}

export async function recoverInterruptedUpdate(userDataPath: string, currentAppPath: string, currentVersion: string): Promise<void> {
  const statusPath = path.join(userDataPath, 'update-status.json');
  const status = await readUpdateStatus(statusPath);
  if (!status) {
    await recoverStaleLockWithoutStatus(userDataPath);
    return;
  }
  if (!['pending', 'verified'].includes(status.state)) return;
  if (!status.targetAppPath || path.resolve(status.targetAppPath) !== path.resolve(currentAppPath) || !status.backupPath || !status.stagingRoot || !status.lockPath || !status.transactionId) {
    await writeUpdateStatus(statusPath, { state: 'failed', version: status.version, message: 'An interrupted update was found, but its recovery state was incomplete and was not trusted.', timestamp: new Date().toISOString() }).catch(() => undefined);
    return;
  }
  const plan = recoveryPlan(status, userDataPath, currentAppPath);
  if (!plan) {
    await writeUpdateStatus(statusPath, { state: 'failed', version: status.version, message: 'An interrupted update was found, but its recovery paths were outside the approved application and data boundaries.', timestamp: new Date().toISOString() }).catch(() => undefined);
    return;
  }
  try {
    validatePlan(plan, undefined, true);
  } catch (error) {
    await writeUpdateStatus(statusPath, { state: 'failed', version: status.version, message: `An interrupted update was found, but its recovery plan was invalid and no restoration was attempted. ${error instanceof Error ? error.message : ''}`.trim(), timestamp: new Date().toISOString() }).catch(() => undefined);
    return;
  }
  try {
    await assertLockOwnership(plan);
  } catch (error) {
    await writeUpdateStatus(statusPath, { state: 'failed', version: status.version, message: `An interrupted update was found, but its transaction lock could not be verified. ${error instanceof Error ? error.message : ''}`.trim(), timestamp: new Date().toISOString(), backupPath: plan.backupPath, lockPath: plan.lockPath, stagingRoot: plan.stagingRoot, targetAppPath: plan.targetAppPath, transactionId: plan.transactionId, applicationIdentity: plan.expectedAppIdentity }).catch(() => undefined);
    return;
  }
  const verifiedBundleMatches = status.state === 'verified' && status.version === currentVersion && Boolean(status.applicationIdentity) && await applicationIdentity(currentAppPath).then((identity) => identity === status.applicationIdentity).catch(() => false);
  if (verifiedBundleMatches) {
    await writeUpdateStatus(statusPath, { ...status, state: 'installed', message: `lucifold ${currentVersion} completed recovery after startup verification.`, timestamp: new Date().toISOString() });
    await fs.rm(plan.backupRoot, { recursive: true, force: true }).catch(() => undefined);
    await fs.rm(plan.stagingRoot, { recursive: true, force: true }).catch(() => undefined);
    await releaseOwnedUpdateLock(plan);
    return;
  }
  const restored = await restoreBackup(plan);
  if (restored.ok) {
    await writeUpdateStatus(statusPath, { state: 'rolled-back', version: status.version, message: `The interrupted update was not accepted and the previous application was restored. ${restored.message}`, timestamp: new Date().toISOString() });
    await fs.rm(plan.stagingRoot, { recursive: true, force: true }).catch(() => undefined);
  } else {
    await writeUpdateStatus(statusPath, { state: 'failed', version: status.version, message: `The interrupted update could not be recovered. ${restored.message}`, timestamp: new Date().toISOString(), backupPath: plan.backupPath, lockPath: plan.lockPath, stagingRoot: plan.stagingRoot, targetAppPath: plan.targetAppPath }).catch(() => undefined);
  }
  await releaseOwnedUpdateLock(plan);
}

async function recoverStaleLockWithoutStatus(userDataPath: string): Promise<void> {
  const lockPath = path.join(userDataPath, 'update.lock');
  let lock: { pid?: number };
  try {
    lock = JSON.parse(await fs.readFile(lockPath, 'utf8')) as { pid?: number };
  } catch {
    await releaseUpdateLock(lockPath).catch(() => undefined);
    return;
  }
  const pid = lock.pid;
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) {
    await releaseUpdateLock(lockPath).catch(() => undefined);
    return;
  }
  try {
    process.kill(pid, 0);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EPERM') await releaseUpdateLock(lockPath).catch(() => undefined);
  }
}

function validatePlan(plan: UpdatePlan, expectedAppPath?: string, requireTransaction = false): void {
  if (!plan || plan.version !== UPDATE_PLAN_VERSION || !Number.isInteger(plan.parentPid) || plan.parentPid <= 0 || !isApprovedTag(`v${plan.newVersion}`) || !plan.targetAppPath?.endsWith('.app') || !plan.stagedAppPath?.endsWith('.app') || !plan.stagingRoot || !plan.userDataPath || !plan.backupRoot || !plan.backupPath || !plan.lockPath || !plan.statusPath || !plan.targetExecutable || [plan.targetAppPath, plan.stagedAppPath, plan.stagingRoot, plan.userDataPath, plan.backupRoot, plan.backupPath, plan.lockPath, plan.statusPath, plan.targetExecutable].some((value) => !path.isAbsolute(value))) throw new Error('The update plan is invalid.');
  if (expectedAppPath && path.resolve(plan.targetAppPath) !== path.resolve(expectedAppPath)) throw new Error('The update plan does not target the running lucifold application.');
  if (!path.basename(plan.stagingRoot).startsWith('lucifold-update-')) throw new Error('The staging directory is not an approved temporary update directory.');
  if (!isPathWithin(plan.stagingRoot, os.tmpdir())) throw new Error('The staging directory is outside the operating system temporary directory.');
  if (!isPathWithin(plan.stagedAppPath, plan.stagingRoot)) throw new Error('The staged application path is outside the staging directory.');
  if (!isPathWithin(plan.backupRoot, path.join(plan.userDataPath, 'update-backups'))) throw new Error('The backup path is outside the update backup directory.');
  if (path.resolve(plan.backupPath) !== path.resolve(path.join(plan.backupRoot, path.basename(plan.targetAppPath)))) throw new Error('The backup application path is invalid.');
  if (path.resolve(plan.lockPath) !== path.resolve(path.join(plan.userDataPath, 'update.lock'))) throw new Error('The update lock path is invalid.');
  if (path.resolve(plan.statusPath) !== path.resolve(path.join(plan.userDataPath, 'update-status.json'))) throw new Error('The update status path is not inside lucifold data.');
  if (path.resolve(plan.targetExecutable) !== path.resolve(path.join(plan.targetAppPath, 'Contents', 'MacOS', 'lucifold'))) throw new Error('The update executable path is invalid.');
  if (path.resolve(plan.targetAppPath) === path.resolve(plan.stagedAppPath)) throw new Error('The target and staged applications must be different paths.');
  if (requireTransaction && (!plan.transactionId || !/^[0-9a-f-]{36}$/i.test(plan.transactionId) || !plan.expectedAppIdentity || !/^[0-9a-f]{64}$/i.test(plan.expectedAppIdentity) || !plan.knownGoodApplicationIdentity || !/^[0-9a-f]{64}$/i.test(plan.knownGoodApplicationIdentity))) throw new Error('The update plan is missing its transaction or application identity.');
}

function isSafeStatusPath(plan: UpdatePlan): boolean {
  try {
    validatePlan(plan, undefined, true);
    return path.resolve(plan.statusPath) === path.resolve(path.join(plan.userDataPath, 'update-status.json')) && path.resolve(plan.lockPath) === path.resolve(path.join(plan.userDataPath, 'update.lock')) && path.basename(plan.stagingRoot).startsWith('lucifold-update-');
  } catch {
    return false;
  }
}

async function readPlan(planPath: string): Promise<UpdatePlan> {
  return JSON.parse(await fs.readFile(planPath, 'utf8')) as UpdatePlan;
}

async function waitForParentExit(parentPid: number, timeout: number): Promise<void> {
  if (parentPid <= 0) return;
  const started = Date.now();
  while (Date.now() - started < timeout) {
    try {
      process.kill(parentPid, 0);
      await new Promise((resolve) => setTimeout(resolve, 250));
    } catch {
      return;
    }
  }
  throw new Error('lucifold did not exit before the installer timeout.');
}

async function waitForVerifiedStatus(statusPath: string, version: string, timeout: number): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    const status = await readUpdateStatus(statusPath);
    if (status?.state === 'verified' && status.version === version) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error('The updated lucifold application did not complete startup verification.');
}

async function assertLockOwnership(plan: UpdatePlan): Promise<void> {
  if (!plan.transactionId) throw new Error('The update plan has no transaction identity.');
  let lock: { transactionId?: string };
  try {
    lock = JSON.parse(await fs.readFile(plan.lockPath, 'utf8')) as { transactionId?: string };
  } catch {
    throw new Error('The update transaction lock is missing or invalid.');
  }
  if (lock.transactionId !== plan.transactionId) throw new Error('The update transaction lock belongs to a different transaction.');
}

async function releaseOwnedUpdateLock(plan: UpdatePlan): Promise<void> {
  try {
    await assertLockOwnership(plan);
    await releaseUpdateLock(plan.lockPath);
  } catch {
    // Never remove a lock that no longer belongs to this transaction.
  }
}

async function movePath(source: string, destination: string): Promise<void> {
  await assertPathAbsent(destination);
  try {
    await fs.rename(source, destination);
    await syncDirectory(path.dirname(source));
    await syncDirectory(path.dirname(destination));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error;
    const partialPath = `${destination}.partial-${randomUUID()}`;
    try {
      await fs.cp(source, partialPath, { recursive: true, errorOnExist: true, force: false });
      await assertApplicationBundle(partialPath);
      await assertCompleteCopy(source, partialPath);
      await fs.rename(partialPath, destination);
      await syncDirectory(path.dirname(destination));
    } finally {
      await fs.rm(partialPath, { recursive: true, force: true }).catch(() => undefined);
    }
    await fs.rm(source, { recursive: true, force: true });
    await syncDirectory(path.dirname(source));
  }
}

async function assertPathAbsent(filePath: string): Promise<void> {
  try {
    await fs.lstat(filePath);
    throw new Error(`The installation destination already exists: ${filePath}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

async function writePendingStatus(plan: UpdatePlan): Promise<void> {
  await writeUpdateStatus(plan.statusPath, { state: 'pending', version: plan.newVersion, message: `lucifold ${plan.newVersion} is preparing a recoverable installation.`, timestamp: new Date().toISOString(), backupPath: plan.backupPath, lockPath: plan.lockPath, stagingRoot: plan.stagingRoot, targetAppPath: plan.targetAppPath, transactionId: plan.transactionId, applicationIdentity: plan.expectedAppIdentity, knownGoodApplicationIdentity: plan.knownGoodApplicationIdentity });
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.lstat(filePath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

async function assertCompleteCopy(source: string, destination: string): Promise<void> {
  const sourceFiles = await bundleFileManifest(source);
  const destinationFiles = await bundleFileManifest(destination);
  if (sourceFiles.size !== destinationFiles.size) throw new Error('The cross-volume application copy is incomplete.');
  for (const [relativePath, sourceEntry] of sourceFiles) {
    const destinationEntry = destinationFiles.get(relativePath);
    if (!destinationEntry || destinationEntry.size !== sourceEntry.size || destinationEntry.digest !== sourceEntry.digest) throw new Error('The cross-volume application copy is incomplete.');
  }
}

async function bundleFileManifest(root: string): Promise<Map<string, { size: number; digest: string }>> {
  const manifest = new Map<string, { size: number; digest: string }>();
  const pending = [root];
  while (pending.length) {
    const current = pending.pop() as string;
    for (const entry of await fs.readdir(current, { withFileTypes: true })) {
      const entryPath = path.join(current, entry.name);
      const stat = await fs.lstat(entryPath);
      if (stat.isSymbolicLink()) throw new Error('The application bundle contains an unexpected symbolic link.');
      if (stat.isDirectory()) {
        pending.push(entryPath);
      } else if (stat.isFile()) {
        const digest = createHash('sha256').update(await fs.readFile(entryPath)).digest('hex');
        manifest.set(path.relative(root, entryPath), { size: stat.size, digest });
      } else {
        throw new Error('The application bundle contains an unsupported filesystem entry.');
      }
    }
  }
  return manifest;
}

async function restoreBackup(plan: UpdatePlan, move: typeof movePath = movePath): Promise<{ ok: true; message: string } | { ok: false; message: string }> {
  try {
    if (!await pathExists(plan.backupPath)) return { ok: false, message: 'The known-good recovery copy is missing.' };
    await assertKnownGoodBackup(plan);
    await fs.rm(plan.targetAppPath, { recursive: true, force: true });
    await move(plan.backupPath, plan.targetAppPath);
    await assertApplicationBundle(plan.targetAppPath);
    await assertKnownGoodApplication(plan);
    return { ok: true, message: 'The known-good application was restored and verified.' };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message.replace(/\s+/g, ' ').slice(0, 220) : 'The previous application could not be restored.' };
  }
}

async function handleInstallationFailure(plan: UpdatePlan, error: unknown, move: typeof movePath = movePath): Promise<void> {
  const message = error instanceof Error ? error.message.replace(/\s+/g, ' ').slice(0, 220) : 'The update installation failed.';
  if (await pathExists(plan.backupPath).catch(() => false)) {
    const restored = await restoreBackup(plan, move);
    if (restored.ok) {
      await writeUpdateStatus(plan.statusPath, { state: 'rolled-back', version: plan.newVersion, message: `The update was not installed and the previous application was restored. ${restored.message} ${message}`, timestamp: new Date().toISOString(), backupPath: plan.backupPath, lockPath: plan.lockPath, stagingRoot: plan.stagingRoot, targetAppPath: plan.targetAppPath, transactionId: plan.transactionId, applicationIdentity: plan.expectedAppIdentity, knownGoodApplicationIdentity: plan.knownGoodApplicationIdentity }).catch(() => undefined);
    } else {
      await writeUpdateStatus(plan.statusPath, { state: 'failed', version: plan.newVersion, message: `The update failed and restoration was not verified. ${restored.message} ${message}`, timestamp: new Date().toISOString(), backupPath: plan.backupPath, lockPath: plan.lockPath, stagingRoot: plan.stagingRoot, targetAppPath: plan.targetAppPath, transactionId: plan.transactionId, applicationIdentity: plan.expectedAppIdentity, knownGoodApplicationIdentity: plan.knownGoodApplicationIdentity }).catch(() => undefined);
    }
    return;
  }
  const targetStillValid = await assertApplicationBundle(plan.targetAppPath).then(() => true).catch(() => false);
  await writeUpdateStatus(plan.statusPath, { state: 'failed', version: plan.newVersion, message: targetStillValid ? `The update was not installed; the existing application remains in place. ${message}` : `The update failed before a verified recovery copy was available. The installation state requires manual recovery. ${message}`, timestamp: new Date().toISOString(), backupPath: plan.backupPath, lockPath: plan.lockPath, stagingRoot: plan.stagingRoot, targetAppPath: plan.targetAppPath, transactionId: plan.transactionId, applicationIdentity: plan.expectedAppIdentity, knownGoodApplicationIdentity: plan.knownGoodApplicationIdentity }).catch(() => undefined);
}

function recoveryPlan(status: NonNullable<Awaited<ReturnType<typeof readUpdateStatus>>>, userDataPath: string, currentAppPath: string): UpdatePlan | null {
  const backupPath = status.backupPath;
  const stagingRoot = status.stagingRoot;
  const lockPath = status.lockPath;
  if (!backupPath || !stagingRoot || !lockPath || !status.transactionId || !status.knownGoodApplicationIdentity || !/^[0-9a-f]{64}$/i.test(status.knownGoodApplicationIdentity) || !isPathWithin(backupPath, path.join(userDataPath, 'update-backups')) || !isPathWithin(stagingRoot, os.tmpdir()) || path.resolve(lockPath) !== path.resolve(path.join(userDataPath, 'update.lock'))) return null;
  const backupRoot = path.dirname(backupPath);
  const newVersion = status.version;
  if (!newVersion || !isApprovedTag(`v${newVersion}`)) return null;
  return { version: UPDATE_PLAN_VERSION, parentPid: process.pid, targetAppPath: currentAppPath, stagedAppPath: path.join(stagingRoot, 'source', 'release', 'mac-arm64', 'lucifold.app'), stagingRoot, userDataPath, backupRoot, backupPath, lockPath, statusPath: path.join(userDataPath, 'update-status.json'), newVersion, targetExecutable: path.join(currentAppPath, 'Contents', 'MacOS', 'lucifold'), transactionId: status.transactionId, expectedAppIdentity: status.applicationIdentity, knownGoodApplicationIdentity: status.knownGoodApplicationIdentity };
}

async function assertKnownGoodApplication(plan: UpdatePlan): Promise<void> {
  if (!plan.knownGoodApplicationIdentity || await applicationIdentity(plan.targetAppPath) !== plan.knownGoodApplicationIdentity) throw new Error('The installed application no longer matches the known-good transaction identity.');
}

async function assertKnownGoodBackup(plan: UpdatePlan): Promise<void> {
  if (!plan.knownGoodApplicationIdentity || await applicationIdentity(plan.backupPath) !== plan.knownGoodApplicationIdentity) throw new Error('The recovery copy does not match the recorded known-good application identity.');
}

function launchInstalledApp(executable: string, args: string[]): void {
  const child = spawn(executable, args, { detached: true, stdio: 'ignore', env: { PATH: '/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin', HOME: process.env.HOME, TMPDIR: process.env.TMPDIR, LANG: process.env.LANG ?? 'C', CI: '1' } });
  child.unref();
}

function bundlePathFromExecutable(executable: string): string | undefined {
  const parts = path.resolve(executable).split(path.sep);
  for (let index = parts.length - 1; index >= 0; index -= 1) {
    if (parts[index].endsWith('.app')) return parts.slice(0, index + 1).join(path.sep) || path.sep;
  }
  return undefined;
}
