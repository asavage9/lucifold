import { constants as fsConstants, closeSync, fstatSync, ftruncateSync, fsyncSync, openSync, promises as fs, readFileSync, lstatSync, realpathSync, writeSync } from 'node:fs';
import { execFile, spawn } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import type { UpdateCheckResult, UpdateProgress, UpdateStatusRecord } from '../../shared/types.js';

/** The only repository origin accepted by the signed updater. */
export const APPROVED_LUCIFOLD_ORIGIN = 'https://github.com/asavage9/lucifold.git';
/**
 * Anthony's independently verified SSH release-signing public key. This key
 * is trusted independently of downloaded repository contents.
 */
export const APPROVED_LUCIFOLD_RELEASE_SIGNING_KEY = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIGlkdfd6tPwtF57kqCzbkq+49Ryz3zwJIeQ5OMPEZMlf lucifold-release';
export const APPROVED_LUCIFOLD_RELEASE_SIGNING_PRINCIPAL = 'lucifold-release';
export const UPDATE_TAG_PATTERN = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
export const UPDATE_PLAN_VERSION = 2;
const COMMAND_TIMEOUT = 15 * 60 * 1_000;
const BUILD_TIMEOUT = 30 * 60 * 1_000;
const MAX_ARCHIVE_ENTRIES = 50_000;
const MAX_ARCHIVE_BYTES = 4 * 1024 * 1024 * 1024;
const MAX_ARCHIVE_UNPACKED_BYTES = 8 * 1024 * 1024 * 1024;
const CONTROLLED_EXECUTABLES: Record<string, string[]> = {
  git: ['/usr/bin/git', '/opt/homebrew/bin/git', '/usr/local/bin/git'],
  node: ['/usr/local/bin/node', '/opt/homebrew/bin/node', '/usr/bin/node'],
  npm: ['/usr/local/bin/npm', '/opt/homebrew/bin/npm', '/usr/bin/npm'],
  tar: ['/usr/bin/tar', '/usr/bin/bsdtar', '/opt/homebrew/bin/bsdtar'],
  'ssh-keygen': ['/usr/bin/ssh-keygen'],
};

export interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode?: number | null;
  signal?: NodeJS.Signals | null;
  pid?: number;
  startedAt?: string;
  exitedAt?: string;
  closedAt?: string;
}

export type CommandRunner = (command: string, args: string[], cwd?: string, timeout?: number) => Promise<CommandResult>;
export type HelperLauncher = (executable: string, args: string[], cwd: string) => void;

interface StagingCommandEvent {
  command: string;
  args: string[];
  cwd?: string;
  startedAt: string;
  completedAt: string;
  exitedAt?: string;
  closedAt?: string;
  pid?: number;
  pidAliveAfterClose?: boolean;
  exitCode?: number | null;
  signal?: NodeJS.Signals | null;
  stdout?: string;
  stderr?: string;
  error?: { name: string; message: string; exitCode?: number | null; signal?: NodeJS.Signals | null };
}

export interface BundleValidationAttempt {
  attempt: number;
  appPath: string | null;
  error: string;
  manifest: Array<{ path: string; type: string; size?: number; mtimeMs?: number; mode?: number; nlink?: number }>;
}

export interface QuarantineCleanupDiagnostic {
  quarantineRoot: string;
  attempts: number;
  cleaned: boolean;
  errors: string[];
}

export interface RepositoryInspection {
  root: string;
  origin: string;
  packageVersion: string;
  dirty: boolean;
  identity: string;
}

interface RemoteTagReferences {
  direct: string;
  peeled: string;
}

export interface UpdatePlan {
  version: typeof UPDATE_PLAN_VERSION;
  parentPid: number;
  targetAppPath: string;
  stagedAppPath: string;
  stagingRoot: string;
  userDataPath: string;
  backupRoot: string;
  backupPath: string;
  backupOwnershipMarker?: string;
  lockPath: string;
  statusPath: string;
  newVersion: string;
  targetExecutable: string;
  transactionId?: string;
  transactionAuthorization?: string;
  expectedAppIdentity?: string;
  knownGoodApplicationIdentity?: string;
}

export interface UpdateServiceOptions {
  currentVersion: string;
  packaged: boolean;
  currentAppPath?: string;
  currentExecutable: string;
  userDataPath: string;
  tempPath: string;
  sourceCandidates: string[];
  expectedOrigin: string | null;
  commandRunner?: CommandRunner;
  helperLauncher?: HelperLauncher;
  processId?: number;
  /** Test-only dependency injection for disposable signing identities. */
  trustedReleaseSigningKey?: string | null;
  trustedReleaseSigningPrincipal?: string;
}

export class UpdateService {
  private readonly runCommand: CommandRunner;
  private readonly launchHelper: HelperLauncher;
  private readonly processId: number;

  constructor(private readonly options: UpdateServiceOptions) {
    this.runCommand = options.commandRunner ?? runCommand;
    this.launchHelper = options.helperLauncher ?? launchHelper;
    this.processId = options.processId ?? process.pid;
  }

  async checkForUpdates(sourceRepositoryPath: string | null): Promise<UpdateCheckResult> {
    const base = {
      currentVersion: this.options.currentVersion,
      approvedSource: this.options.expectedOrigin ?? undefined,
      canInstall: this.options.packaged && Boolean(this.options.currentAppPath) && Boolean(this.options.expectedOrigin),
    };
    try {
      await this.checkRequiredTools();
    } catch {
      return { ...base, state: 'unavailable', message: 'Git, Node.js, npm, and tar are required for source-based updates.' };
    }

    const source = await this.resolveSourceRepository(sourceRepositoryPath);
    if (!source) {
      return { ...base, state: 'not-configured', message: 'Choose the trusted local lucifold repository before checking for updates.' };
    }
    const inspection = await this.inspectRepository(source);
    if (!inspection.valid) {
      return { ...base, state: inspection.state, sourcePath: source, message: inspection.message };
    }
    if (inspection.repository.dirty) {
      return { ...base, state: 'dirty', sourcePath: source, message: 'The source repository has uncommitted changes. Commit or stash them before updating.' };
    }
    if (!this.options.expectedOrigin) {
      return { ...base, state: 'not-configured', sourcePath: source, message: 'This lucifold build has no approved update origin configured. Source-based updating remains disabled until Anthony establishes one.' };
    }

    try {
      await this.runCommand('git', ['fetch', '--tags', '--no-prune', this.options.expectedOrigin], inspection.repository.root, COMMAND_TIMEOUT);
    } catch (error) {
      return { ...base, state: 'unavailable', sourcePath: source, message: commandFailureMessage(error, 'The approved update source could not be reached while fetching tags.') };
    }

    try {
      const tags = await this.approvedTags(inspection.repository.root);
      const newer = tags.find((tag) => compareVersions(tag.version, this.options.currentVersion) > 0);
      if (!newer) {
        return { ...base, state: 'up-to-date', sourcePath: source, message: `lucifold ${this.options.currentVersion} is up to date.` };
      }
      return {
        ...base,
        state: 'available',
        latestVersion: newer.version,
        tag: newer.tag,
        sourcePath: source,
        message: `lucifold ${newer.version} is ready to install from approved tag ${newer.tag}.`,
      };
    } catch (error) {
      return { ...base, state: 'error', sourcePath: source, message: commandFailureMessage(error, 'The approved version tags could not be read.') };
    }
  }

  async validateSourceRepository(sourceRepositoryPath: string): Promise<{ ok: true; path: string; message: string } | { ok: false; message: string }> {
    const inspection = await this.inspectRepository(sourceRepositoryPath);
    if (!inspection.valid) return { ok: false, message: inspection.message };
    if (inspection.repository.dirty) return { ok: false, message: 'The selected repository has uncommitted changes. Choose a clean checkout.' };
    if (!this.options.expectedOrigin) {
      return { ok: true, path: inspection.repository.root, message: 'Local source saved. Update discovery will remain disabled until an approved lucifold origin is configured in a future build.' };
    }
    return { ok: true, path: inspection.repository.root, message: 'Approved lucifold source repository saved.' };
  }

  async prepareAndInstall(tag: string, sourceRepositoryPath: string | null, onProgress: (progress: UpdateProgress) => void): Promise<{ accepted: boolean; message: string }> {
    if (!this.options.packaged || !this.options.currentAppPath) {
      return { accepted: false, message: 'Updates can only install from a packaged macOS application.' };
    }
    if (!this.options.expectedOrigin) {
      return { accepted: false, message: 'This build has no approved lucifold update origin configured.' };
    }
    if (!isApprovedTag(tag)) return { accepted: false, message: 'The selected update tag is not an approved stable version tag.' };

    const lockPath = path.join(this.options.userDataPath, 'update.lock');
    let lockAcquired = false;
    let transactionId: string | undefined;
    let transactionAuthorization: string | undefined;
    const commandEvents: StagingCommandEvent[] = [];
    const bundleValidationAttempts: BundleValidationAttempt[] = [];
    let quarantineCleanup: QuarantineCleanupDiagnostic[] = [];
    const source = await this.resolveSourceRepository(sourceRepositoryPath);
    if (!source) return { accepted: false, message: 'The trusted local lucifold repository is not configured.' };

    let stagingRoot: string | undefined;
    try {
      const lock = await acquireUpdateLock(lockPath, this.options.userDataPath);
      transactionId = lock.transactionId;
      transactionAuthorization = lock.transactionAuthorization;
      lockAcquired = true;
      const inspection = await this.inspectRepository(source);
      if (!inspection.valid) throw new Error(inspection.message);
      if (inspection.repository.dirty) throw new Error('The source repository has uncommitted changes. Commit or stash them before updating.');
      if (compareVersions(tag.slice(1), this.options.currentVersion) <= 0) throw new Error('That update is not newer than the installed version.');
      const verifiedCommit = await this.resolveApprovedCommit(inspection.repository.root, tag);
      if (!verifiedCommit) throw new Error('The selected release tag does not exist on the approved remote authority.');
      await this.assertRepositoryStable(inspection.repository);

      onProgress({ phase: 'staging', percent: 5, message: 'Creating a private staging area…' });
      stagingRoot = await fs.mkdtemp(path.join(this.options.tempPath, 'lucifold-update-'));
      const sourceRoot = path.join(stagingRoot, 'source');
      await fs.mkdir(sourceRoot, { recursive: true, mode: 0o700 });
      const archivePath = path.join(stagingRoot, 'source.tar');
      await this.assertRevisionTreeSafe(inspection.repository.root, verifiedCommit);
      await runStagingCommand(this.runCommand, commandEvents, 'git', ['archive', '--format=tar', `--output=${archivePath}`, verifiedCommit], inspection.repository.root, COMMAND_TIMEOUT);
      await this.extractVerifiedArchive(archivePath, sourceRoot);
      await fs.rm(archivePath, { force: true });
      await inspectExtractedTree(sourceRoot);
      await assertPackageVersion(sourceRoot, tag.slice(1));
      await assertBuildConfiguration(sourceRoot);

      onProgress({ phase: 'staging', percent: 20, message: 'Installing clean staging dependencies…' });
      await runStagingCommand(this.runCommand, commandEvents, 'npm', ['ci', '--ignore-scripts', '--no-audit', '--no-fund', '--userconfig', '/dev/null'], sourceRoot, BUILD_TIMEOUT);
      onProgress({ phase: 'staging', percent: 45, message: 'Running type checks and the application build…' });
      await runStagingCommand(this.runCommand, commandEvents, 'npm', ['run', 'typecheck'], sourceRoot, BUILD_TIMEOUT);

      onProgress({ phase: 'staging', percent: 82, message: 'Verifying the staged Apple Silicon application…' });
      const stagedOutput = await verifyStagedApplicationOutput(sourceRoot, async () => {
        await runStagingCommand(this.runCommand, commandEvents, 'npm', ['run', 'package:dir'], sourceRoot, BUILD_TIMEOUT);
      }, bundleValidationAttempts, quarantineCleanup);
      quarantineCleanup = stagedOutput.quarantineCleanup;
      const stagedAppPath = stagedOutput.appPath;
      await fs.access(path.dirname(this.options.currentAppPath), fsConstants.W_OK);

      const backupRoot = path.join(this.options.userDataPath, 'update-backups', `${tag.slice(1)}-${Date.now()}`);
      const backupPath = path.join(backupRoot, path.basename(this.options.currentAppPath));
      const planPath = path.join(stagingRoot, 'update-plan.json');
      const expectedAppIdentity = await applicationIdentity(stagedAppPath);
      const knownGoodApplicationIdentity = await applicationIdentity(this.options.currentAppPath);
      const plan: UpdatePlan = {
        version: UPDATE_PLAN_VERSION,
        parentPid: this.processId,
        targetAppPath: this.options.currentAppPath,
        stagedAppPath,
        stagingRoot,
        userDataPath: this.options.userDataPath,
        backupRoot,
        backupPath,
        backupOwnershipMarker: path.join(backupRoot, '.lucifold-owner'),
        lockPath,
        statusPath: path.join(this.options.userDataPath, 'update-status.json'),
        newVersion: tag.slice(1),
        targetExecutable: path.join(this.options.currentAppPath, 'Contents', 'MacOS', 'lucifold'),
        transactionId,
        transactionAuthorization,
        expectedAppIdentity,
        knownGoodApplicationIdentity,
      };
      await writeDurableFile(planPath, JSON.stringify(plan, null, 2));
      onProgress({ phase: 'installing', percent: 95, message: 'Ready to close lucifold and install the verified update…' });
      this.launchHelper(this.options.currentExecutable, ['--lucifold-update-helper', planPath], stagingRoot);
      return { accepted: true, message: `lucifold ${plan.newVersion} is verified and will install after the app closes.` };
    } catch (error) {
      await preserveStagingFailureEvidence(this.options.tempPath, stagingRoot, commandEvents, error, bundleValidationAttempts, quarantineCleanup);
      if (stagingRoot) await fs.rm(stagingRoot, { recursive: true, force: true }).catch(() => undefined);
      if (lockAcquired) await releaseUpdateLock(lockPath);
      return { accepted: false, message: commandFailureMessage(error, 'The update could not be staged. Your current installation was not changed.') };
    }
  }

  private async resolveSourceRepository(explicitPath: string | null): Promise<string | null> {
    const candidates = explicitPath ? [explicitPath] : this.options.sourceCandidates;
    for (const candidate of candidates) {
      const inspection = await this.inspectRepository(candidate);
      if (inspection.valid) return inspection.repository.root;
      if (explicitPath) return null;
    }
    return null;
  }

  private async inspectRepository(candidate: string): Promise<{ valid: true; repository: RepositoryInspection } | { valid: false; state: 'invalid-source' | 'error'; message: string }> {
    try {
      const rootResult = await this.runCommand('git', ['rev-parse', '--show-toplevel'], candidate, COMMAND_TIMEOUT);
      const root = path.resolve(rootResult.stdout.trim());
      const rootStat = await fs.lstat(root);
      if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) return { valid: false, state: 'invalid-source', message: 'The selected source repository path is not a stable directory.' };
      const packageJson = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8')) as { name?: string; version?: string };
      if (packageJson.name !== 'lucifold') return { valid: false, state: 'invalid-source', message: 'The selected repository is not the expected lucifold source repository.' };
      let origin = '';
      try {
        const configuredOrigins = (await this.runCommand('git', ['config', '--local', '--get-all', 'remote.origin.url'], root, COMMAND_TIMEOUT)).stdout.split(/\r?\n/).map((value) => value.trim()).filter(Boolean);
        if (this.options.expectedOrigin && configuredOrigins.length !== 1) return { valid: false, state: 'invalid-source', message: 'The trusted source repository must have exactly one local origin URL.' };
        origin = configuredOrigins[0] ?? '';
      } catch {
        if (this.options.expectedOrigin) return { valid: false, state: 'invalid-source', message: 'The selected source repository has no configured origin.' };
      }
      if (this.options.expectedOrigin && !isExpectedOrigin(origin, this.options.expectedOrigin)) {
        return { valid: false, state: 'invalid-source', message: 'The source repository origin is not the approved lucifold update source.' };
      }
      if (this.options.expectedOrigin) {
        try {
          const localTransportConfig = await this.runCommand('git', ['config', '--local', '--get-regexp', '^(remote\\.origin\\.(pushurl)|url\\..*\\.(insteadOf|pushInsteadOf))$'], root, COMMAND_TIMEOUT);
          if (localTransportConfig.stdout.trim()) return { valid: false, state: 'invalid-source', message: 'The source repository contains local transport overrides and cannot be used as a trusted update authority.' };
        } catch {
          // No local transport overrides are the expected result.
        }
      }
      const status = await this.runCommand('git', ['status', '--porcelain', '--untracked-files=all'], root, COMMAND_TIMEOUT);
      return { valid: true, repository: { root, origin, packageVersion: String(packageJson.version ?? ''), dirty: Boolean(status.stdout.trim()), identity: `${rootStat.dev}:${rootStat.ino}` } };
    } catch (error) {
      return { valid: false, state: 'invalid-source', message: commandFailureMessage(error, 'The selected source repository could not be inspected.') };
    }
  }

  private async checkRequiredTools(): Promise<void> {
    await this.runCommand('git', ['--version'], undefined, COMMAND_TIMEOUT);
    await this.runCommand('node', ['--version'], undefined, COMMAND_TIMEOUT);
    await this.runCommand('npm', ['--version'], undefined, COMMAND_TIMEOUT);
    await this.runCommand('tar', ['--version'], undefined, COMMAND_TIMEOUT);
  }

  private async approvedTags(root: string): Promise<Array<{ tag: string; version: string }>> {
    const tags = (await this.runCommand('git', ['tag', '--list', 'v*', '--sort=-v:refname'], root, COMMAND_TIMEOUT)).stdout.split(/\r?\n/).map((tag) => tag.trim()).filter(Boolean);
    const approved: Array<{ tag: string; version: string }> = [];
    for (const tag of tags) {
      if (!isApprovedTag(tag)) continue;
      try {
        const packageJson = JSON.parse((await this.runCommand('git', ['show', `${tag}:package.json`], root, COMMAND_TIMEOUT)).stdout) as { name?: string; version?: string };
        if (packageJson.name === 'lucifold' && packageJson.version === tag.slice(1) && await this.resolveApprovedCommit(root, tag)) {
          approved.push({ tag, version: tag.slice(1) });
        }
      } catch {
        // Ignore tags that do not contain a valid package manifest or verified remote ref.
      }
    }
    return approved.sort((left, right) => compareVersions(right.version, left.version));
  }

  private async assertRevisionTreeSafe(root: string, tag: string): Promise<void> {
    const listing = await this.runCommand('git', ['ls-tree', '-r', '-z', tag], root, COMMAND_TIMEOUT);
    for (const record of listing.stdout.split('\0')) {
      if (!record) continue;
      const mode = record.split(/\s+/, 1)[0];
      if (mode === '120000') throw new Error('The approved update contains a symbolic link and was rejected.');
    }
  }

  private async resolveApprovedCommit(root: string, tag: string): Promise<string | null> {
    if (!this.options.expectedOrigin || !isApprovedTag(tag)) return null;
    const inspection = await this.inspectRepository(root);
    if (!inspection.valid || !isExpectedOrigin(inspection.repository.origin, this.options.expectedOrigin)) {
      throw new Error('The source repository origin is no longer the approved lucifold update source.');
    }
    const remoteReferences = await this.remoteTagReferences(root, tag, this.options.expectedOrigin);
    if (!remoteReferences) return null;
    const localTagObject = (await this.runCommand('git', ['rev-parse', tag], root, COMMAND_TIMEOUT)).stdout.trim();
    const localTagType = (await this.runCommand('git', ['cat-file', '-t', tag], root, COMMAND_TIMEOUT)).stdout.trim();
    if (!/^[0-9a-f]{40}$/i.test(localTagObject) || localTagObject.toLowerCase() !== remoteReferences.direct.toLowerCase() || localTagType !== 'tag') {
      throw new Error(`The approved release tag ${tag} does not match the current remote tag object.`);
    }
    const localCommit = (await this.runCommand('git', ['rev-parse', `${tag}^{commit}`], root, COMMAND_TIMEOUT)).stdout.trim();
    if (!/^[0-9a-f]{40}$/i.test(localCommit) || localCommit.toLowerCase() !== remoteReferences.peeled.toLowerCase()) {
      throw new Error(`The approved release tag ${tag} does not resolve to the current remote commit.`);
    }
    await this.verifyReleaseTagSignature(root, tag);
    return localCommit;
  }

  private async assertRepositoryStable(repository: RepositoryInspection): Promise<void> {
    const current = await this.inspectRepository(repository.root);
    if (!current.valid || current.repository.root !== repository.root || current.repository.identity !== repository.identity || current.repository.origin !== repository.origin || current.repository.packageVersion !== repository.packageVersion || current.repository.dirty) {
      throw new Error('The selected source repository changed after release verification and was rejected.');
    }
  }

  private async remoteTagReferences(root: string, tag: string, approvedOrigin: string): Promise<RemoteTagReferences | null> {
    const directReference = `refs/tags/${tag}`;
    const peeledReference = `${directReference}^{}`;
    const listing = await this.runCommand('git', ['ls-remote', '--tags', approvedOrigin, directReference, peeledReference], root, COMMAND_TIMEOUT);
    const records = listing.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).map((line) => {
      const parts = line.split(/\s+/);
      return parts.length === 2 ? { sha: parts[0], reference: parts[1] } : null;
    });
    if (records.some((record) => !record)) return null;

    const directRecords = records.filter((record): record is { sha: string; reference: string } => record?.reference === directReference);
    const peeledRecords = records.filter((record): record is { sha: string; reference: string } => record?.reference === peeledReference);
    if (records.some((record) => record && record.reference !== directReference && record.reference !== peeledReference)) return null;
    if (directRecords.length > 1 || peeledRecords.length > 1) return null;

    const direct = directRecords[0]?.sha;
    const peeled = peeledRecords[0]?.sha;
    if (direct && !/^[0-9a-f]{40}$/i.test(direct)) return null;
    if (peeled && !/^[0-9a-f]{40}$/i.test(peeled)) return null;
    if (!direct || !peeled || direct === peeled) return null;
    return { direct, peeled };
  }

  private async verifyReleaseTagSignature(root: string, tag: string): Promise<void> {
    const signingKey = this.options.trustedReleaseSigningKey === undefined
      ? APPROVED_LUCIFOLD_RELEASE_SIGNING_KEY
      : this.options.trustedReleaseSigningKey;
    const principal = this.options.trustedReleaseSigningPrincipal ?? APPROVED_LUCIFOLD_RELEASE_SIGNING_PRINCIPAL;
    if (!signingKey || !isValidReleaseSigningKey(signingKey) || !isValidReleaseSigningPrincipal(principal)) {
      throw new Error('The updater has no valid independently trusted lucifold release-signing identity configured.');
    }

    const trustedVerifier = await resolveControlledExecutable('ssh-keygen');
    await fs.mkdir(this.options.tempPath, { recursive: true, mode: 0o700 });
    const verificationRoot = await fs.mkdtemp(path.join(this.options.tempPath, 'lucifold-signature-'));
    const allowedSignersPath = path.join(verificationRoot, 'allowed-signers');
    const revocationPath = path.join(verificationRoot, 'revoked-keys');
    try {
      await writeDurableFile(allowedSignersPath, `${principal} namespaces="git" ${signingKey.trim()}\n`);
      await writeDurableFile(revocationPath, '');
      try {
        await this.runCommand('git', [
          '-c', 'gpg.format=ssh',
          `-c`, `gpg.ssh.program=${trustedVerifier}`,
          '-c', `gpg.ssh.allowedSignersFile=${allowedSignersPath}`,
          '-c', `gpg.ssh.revocationFile=${revocationPath}`,
          'verify-tag', '--', tag,
        ], root, COMMAND_TIMEOUT);
      } catch {
        throw new Error('The approved release tag is not signed by the trusted lucifold release identity.');
      }
    } finally {
      await fs.rm(verificationRoot, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  private async extractVerifiedArchive(archivePath: string, sourceRoot: string): Promise<void> {
    await extractVerifiedArchiveFiles(archivePath, sourceRoot);
  }
}

export function validateArchiveEntries(entries: string[]): void {
  if (entries.length > MAX_ARCHIVE_ENTRIES) throw new Error('The approved update archive contains too many entries.');
  const seen = new Set<string>();
  for (const entry of entries) {
    const normalized = normalizeArchiveEntry(entry);
    if (!normalized || normalized.startsWith('/') || normalized === '..' || normalized.startsWith('../') || normalized.includes('/../')) {
      throw new Error('The approved update archive contains an unsafe path.');
    }
    if (seen.has(normalized)) throw new Error('The approved update archive contains duplicate entries.');
    seen.add(normalized);
  }
}

export async function extractVerifiedArchiveForTest(archivePath: string, sourceRoot: string): Promise<void> {
  await extractVerifiedArchiveFiles(archivePath, sourceRoot);
}

export async function inspectExtractedTreeForTest(root: string): Promise<void> {
  await inspectExtractedTree(root);
}

async function extractVerifiedArchiveFiles(archivePath: string, sourceRoot: string): Promise<void> {
  await fs.mkdir(sourceRoot, { recursive: true, mode: 0o700 });
  if ((await fs.readdir(sourceRoot)).length > 0) throw new Error('The archive staging directory must be empty.');

  // Open both inputs before validation. Tar receives file descriptors rather than
  // reopening the pathname after the listing has been approved. Every archive
  // entry is type-checked before tar is allowed to create anything.
  const noFollowFlag = (fsConstants as typeof fsConstants & { O_NOFOLLOW?: number }).O_NOFOLLOW ?? 0;
  const listingHandle = await fs.open(archivePath, fsConstants.O_RDONLY | noFollowFlag);
  const verboseHandle = await fs.open(archivePath, fsConstants.O_RDONLY | noFollowFlag);
  const extractionHandle = await fs.open(archivePath, fsConstants.O_RDONLY | noFollowFlag);
  let extracted = false;
  try {
    const archiveStat = await listingHandle.stat();
    const verboseStat = await verboseHandle.stat();
    const extractionStat = await extractionHandle.stat();
    if (!archiveStat.isFile() || !verboseStat.isFile() || !extractionStat.isFile() || archiveStat.dev !== verboseStat.dev || archiveStat.ino !== verboseStat.ino || archiveStat.size !== verboseStat.size || archiveStat.dev !== extractionStat.dev || archiveStat.ino !== extractionStat.ino || archiveStat.size !== extractionStat.size) {
      throw new Error('The approved update archive changed while it was being staged.');
    }
    if (archiveStat.size > MAX_ARCHIVE_BYTES) throw new Error('The approved update archive exceeds the archive size limit.');
    const listing = await runCommandFromFileInput('tar', ['-tf', '-'], listingHandle, undefined, COMMAND_TIMEOUT);
    const entries = listing.stdout.split(/\r?\n/).map((entry) => entry.trim()).filter(Boolean);
    validateArchiveEntries(entries);
    const verbose = await runCommandFromFileInput('tar', ['-tvf', '-'], verboseHandle, undefined, COMMAND_TIMEOUT);
    validateArchiveTypesAndBounds(verbose.stdout.split(/\r?\n/).map((entry) => entry.trim()).filter(Boolean), entries.length);
    await runCommandFromFileInput('tar', ['-xf', '-', '-C', sourceRoot], extractionHandle, undefined, COMMAND_TIMEOUT);
    extracted = true;
  } catch (error) {
    await fs.rm(sourceRoot, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  } finally {
    await listingHandle.close().catch(() => undefined);
    await verboseHandle.close().catch(() => undefined);
    await extractionHandle.close().catch(() => undefined);
  }
  if (!extracted) await fs.rm(sourceRoot, { recursive: true, force: true }).catch(() => undefined);
}

function normalizeArchiveEntry(entry: string): string {
  let normalized = path.posix.normalize(entry.trim().replaceAll('\\', '/'));
  while (normalized.startsWith('./')) normalized = normalized.slice(2);
  normalized = normalized.replace(/\/+$/, '');
  return normalized || '.';
}

function validateArchiveTypesAndBounds(lines: string[], expectedEntries: number): void {
  if (lines.length !== expectedEntries) throw new Error('The approved update archive could not be deterministically listed.');
  const months = new Set(['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']);
  let unpackedBytes = 0;
  for (const line of lines) {
    const type = line[0];
    if (!type || !['d', '-'].includes(type)) {
      const marker = line.includes(' link to ') ? ' link to ' : ' -> ';
      const target = marker === ' link to ' ? line.split(marker).pop() : line.split(marker).pop();
      if (target) validateArchiveLinkTarget(target);
      throw new Error('The approved update archive contains a symbolic link, hard link, or special filesystem entry.');
    }
    if (type !== '-') continue;
    const tokens = line.split(/\s+/);
    const dateIndex = tokens.findIndex((token) => months.has(token));
    const sizeToken = dateIndex > 0 ? tokens[dateIndex - 1] : undefined;
    if (!sizeToken || !/^\d+$/.test(sizeToken)) throw new Error('The approved update archive file size could not be validated.');
    unpackedBytes += Number(sizeToken);
    if (!Number.isSafeInteger(unpackedBytes) || unpackedBytes > MAX_ARCHIVE_UNPACKED_BYTES) throw new Error('The approved update archive exceeds the extraction size limit.');
  }
}

function validateArchiveLinkTarget(target: string): void {
  const normalized = path.posix.normalize(target.trim().replaceAll('\\', '/'));
  if (!normalized || normalized.startsWith('/') || normalized === '..' || normalized.startsWith('../') || normalized.includes('/../')) throw new Error('The approved update archive contains an unsafe link target.');
}

async function acquireUpdateLock(lockPath: string, userDataPath: string): Promise<{ transactionId: string; transactionAuthorization: string }> {
  await fs.mkdir(userDataPath, { recursive: true, mode: 0o700 });
  const transactionId = randomUUID();
  const transactionAuthorization = randomBytes(32).toString('hex');
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
  try {
    handle = await fs.open(lockPath, 'wx', 0o600);
    await handle.writeFile(JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString(), transactionId, transactionAuthorization }));
    await handle.sync();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error('Another lucifold update transaction is already in progress.');
    throw error;
  } finally {
    await handle?.close().catch(() => undefined);
  }
  await syncDirectory(path.dirname(lockPath));
  return { transactionId, transactionAuthorization };
}

export async function releaseUpdateLock(lockPath: string): Promise<void> {
  await fs.rm(lockPath, { force: true });
  await syncDirectory(path.dirname(lockPath));
}

async function inspectExtractedTree(root: string): Promise<void> {
  const rootStat = await fs.lstat(root);
  const rootDevice = rootStat.dev;
  const pending = [root];
  let entries = 0;
  let bytes = 0;
  while (pending.length) {
    const current = pending.pop() as string;
    for (const entry of await fs.readdir(current, { withFileTypes: true })) {
      const entryPath = path.join(current, entry.name);
      const stat = await fs.lstat(entryPath);
      entries += 1;
      if (entries > MAX_ARCHIVE_ENTRIES) throw new Error('The approved update archive contains too many entries.');
      if (stat.dev !== rootDevice) throw new Error('The approved update archive crosses a filesystem boundary.');
      if (stat.isSymbolicLink()) throw new Error('The approved update contains a symbolic link and was rejected.');
      if (stat.isDirectory()) {
        pending.push(entryPath);
      } else if (stat.isFile()) {
        bytes += stat.size;
        if (bytes > MAX_ARCHIVE_BYTES) throw new Error('The approved update archive exceeds the extraction size limit.');
      } else {
        throw new Error('The approved update contains an unsupported filesystem entry.');
      }
    }
  }
}

async function assertBuildConfiguration(sourceRoot: string): Promise<void> {
  const packageJson = JSON.parse(await fs.readFile(path.join(sourceRoot, 'package.json'), 'utf8')) as { scripts?: Record<string, unknown> };
  const scripts = packageJson.scripts ?? {};
  const expectedScripts: Record<string, string> = {
    build: 'npm run build:renderer && npm run build:preload && npm run build:main && npm run build:native',
    'build:renderer': 'vite build',
    'build:preload': 'vite build --config vite.preload.config.ts',
    'build:main': 'tsc -p tsconfig.main.json',
    'build:native': 'node scripts/build-native.mjs',
    typecheck: 'tsc -p tsconfig.json --noEmit && tsc -p tsconfig.main.json --noEmit',
    'package:dir': 'npm run build && electron-builder --mac --arm64 --dir --publish never',
  };
  for (const [name, expected] of Object.entries(expectedScripts)) {
    if (scripts[name] !== expected) throw new Error(`The staged build script ${name} is not an approved lucifold build command.`);
  }
  for (const name of ['preinstall', 'install', 'postinstall', 'prepare', 'prebuild', 'postbuild', 'pretypecheck', 'posttypecheck', 'prepackage:dir', 'postpackage:dir']) {
    if (name in scripts) throw new Error(`The staged source contains an unexpected lifecycle script: ${name}.`);
  }
  await fs.access(path.join(sourceRoot, 'package-lock.json'));
  try {
    const lock = JSON.parse(await fs.readFile(path.join(sourceRoot, 'package-lock.json'), 'utf8')) as { lockfileVersion?: unknown; packages?: unknown };
    if (typeof lock.lockfileVersion !== 'number' || !lock.packages || typeof lock.packages !== 'object') throw new Error('The staged dependency lockfile is invalid.');
  } catch (error) {
    throw new Error(`The staged dependency lockfile could not be verified: ${error instanceof Error ? error.message : 'invalid lockfile'}`);
  }
  const forbiddenConfig = path.join(sourceRoot, '.npmrc');
  try {
    await fs.lstat(forbiddenConfig);
    throw new Error('The staged source contains an unapproved .npmrc configuration.');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

export function isApprovedTag(tag: string): boolean {
  return UPDATE_TAG_PATTERN.test(tag);
}

export function compareVersions(left: string, right: string): number {
  const leftParts = parseVersion(left);
  const rightParts = parseVersion(right);
  if (!leftParts || !rightParts) throw new Error('Unsupported semantic version reference.');
  for (let index = 0; index < 3; index += 1) {
    if (leftParts[index] !== rightParts[index]) return leftParts[index] - rightParts[index];
  }
  return 0;
}

export function isExpectedOrigin(origin: string, expectedOrigin: string): boolean {
  return normalizeOrigin(origin) === normalizeOrigin(expectedOrigin);
}

export function isPathWithin(child: string, parent: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return Boolean(relative) && !relative.startsWith('..') && !path.isAbsolute(relative);
}

export async function readUpdateStatus(statusPath: string): Promise<UpdateStatusRecord | null> {
  try {
    const value = JSON.parse(await fs.readFile(statusPath, 'utf8')) as UpdateStatusRecord;
    if (!value || !['pending', 'verified', 'installed', 'failed', 'rolled-back'].includes(value.state) || typeof value.message !== 'string' || typeof value.timestamp !== 'string') return null;
    return value;
  } catch {
    return null;
  }
}

export async function writeUpdateStatus(statusPath: string, status: UpdateStatusRecord): Promise<void> {
  await writeDurableFile(statusPath, JSON.stringify(status, null, 2));
}

export async function writeDurableFile(filePath: string, contents: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
  try {
    handle = await fs.open(temporaryPath, 'wx', 0o600);
    await handle.writeFile(contents);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await fs.rename(temporaryPath, filePath);
    await syncDirectory(path.dirname(filePath));
  } finally {
    await handle?.close().catch(() => undefined);
    await fs.rm(temporaryPath, { force: true }).catch(() => undefined);
  }
}

export async function syncDirectory(directoryPath: string): Promise<void> {
  const directoryFlag = (fsConstants as typeof fsConstants & { O_DIRECTORY?: number }).O_DIRECTORY ?? 0;
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
  try {
    handle = await fs.open(directoryPath, fsConstants.O_RDONLY | directoryFlag);
    await handle.sync().catch((error: unknown) => {
      const code = (error as NodeJS.ErrnoException).code;
      if (!['EINVAL', 'ENOTSUP', 'EISDIR'].includes(String(code))) throw error;
    });
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

export async function applicationIdentity(appPath: string): Promise<string> {
  const files = ['Contents/MacOS/lucifold', 'Contents/Info.plist', 'Contents/Resources/app.asar'];
  const digest = createHash('sha256');
  const electronProcess = process as NodeJS.Process & { noAsar?: boolean };
  const usesElectronAsar = typeof process.versions.electron === 'string';
  const previousNoAsar = electronProcess.noAsar;
  if (usesElectronAsar) electronProcess.noAsar = true;
  try {
    for (const relativePath of files) {
      const filePath = path.join(appPath, relativePath);
      const stat = lstatSync(filePath);
      if (!stat.isFile()) throw new Error(`The application bundle entry ${relativePath} is not a regular file.`);
      digest.update(relativePath);
      digest.update(String(stat.size));
      digest.update(readFileSync(filePath));
    }
  } finally {
    if (usesElectronAsar) electronProcess.noAsar = previousNoAsar;
  }
  return digest.digest('hex');
}

export async function markUpdateVerified(statusPath: string, expectedVersion: string, actualVersion: string, currentAppPath?: string, expectedIdentity?: string, canonicalUserDataPath?: string): Promise<boolean> {
  if (expectedVersion !== actualVersion) return false;
  if (!currentAppPath || !expectedIdentity || !canonicalUserDataPath) return false;
  const authenticated = openAuthenticatedVerificationState(statusPath, expectedVersion, expectedIdentity, currentAppPath, undefined, canonicalUserDataPath);
  if (!authenticated) return false;
  try {
    const { status, statusFd } = authenticated;
    if (status.state !== 'pending' || status.version !== expectedVersion || !status.targetAppPath || path.resolve(status.targetAppPath) !== path.resolve(currentAppPath) || expectedIdentity !== status.applicationIdentity) return false;
    if (expectedIdentity !== await applicationIdentity(currentAppPath)) return false;
    const nextStatus: UpdateStatusRecord = { state: 'verified', version: expectedVersion, message: `lucifold ${expectedVersion} started successfully after update.`, timestamp: new Date().toISOString(), backupPath: status.backupPath, backupRoot: status.backupRoot, backupOwnershipMarker: status.backupOwnershipMarker, lockPath: status.lockPath, stagingRoot: status.stagingRoot, targetAppPath: status.targetAppPath, transactionId: status.transactionId, applicationIdentity: status.applicationIdentity, knownGoodApplicationIdentity: status.knownGoodApplicationIdentity };
    ftruncateSync(statusFd, 0);
    const serializedStatus = JSON.stringify(nextStatus, null, 2);
    writeSync(statusFd, serializedStatus, 0, 'utf8');
    fsyncSync(statusFd);
    return true;
  } finally {
    closeSync(authenticated.statusFd);
    closeSync(authenticated.lockFd);
  }
}

export function resolveVerificationUserDataPath(statusPath: string, expectedVersion: string, expectedIdentity: string, currentAppPath: string, requestedPath?: string, canonicalUserDataPath?: string): string | null {
  const authenticated = openAuthenticatedVerificationState(statusPath, expectedVersion, expectedIdentity, currentAppPath, requestedPath, canonicalUserDataPath);
  if (!authenticated) return null;
  closeSync(authenticated.statusFd);
  closeSync(authenticated.lockFd);
  return authenticated.userDataPath;
}

function openAuthenticatedVerificationState(statusPath: string, expectedVersion: string, expectedIdentity: string, currentAppPath: string, requestedPath?: string, canonicalUserDataPath?: string): { userDataPath: string; status: UpdateStatusRecord; statusFd: number; lockFd: number } | null {
  if (!canonicalUserDataPath || !path.isAbsolute(statusPath) || path.basename(statusPath) !== 'update-status.json' || !isApprovedTag(`v${expectedVersion}`) || !/^[0-9a-f]{64}$/i.test(expectedIdentity) || !path.isAbsolute(currentAppPath) || !path.isAbsolute(canonicalUserDataPath)) return null;
  if (path.resolve(path.dirname(statusPath)) !== path.resolve(canonicalUserDataPath) || path.resolve(statusPath) !== path.resolve(path.join(canonicalUserDataPath, 'update-status.json'))) return null;
  let statusFd: number | undefined;
  let lockFd: number | undefined;
  let authenticated = false;
  try {
    const userDataStat = lstatSync(path.dirname(statusPath));
    const lockPath = path.join(canonicalUserDataPath, 'update.lock');
    if (!userDataStat.isDirectory() || userDataStat.isSymbolicLink() || hasUntrustedSymlink(statusPath) || hasUntrustedSymlink(path.dirname(statusPath))) return null;
    const noFollow = fsConstants.O_NOFOLLOW ?? 0;
    statusFd = openSync(statusPath, fsConstants.O_RDWR | noFollow);
    lockFd = openSync(lockPath, fsConstants.O_RDONLY | noFollow);
    const statusStat = fstatSync(statusFd);
    const lockStat = fstatSync(lockFd);
    if (!statusStat.isFile() || statusStat.nlink !== 1 || !lockStat.isFile() || lockStat.nlink !== 1 || (lockStat.mode & 0o077) !== 0) return null;
    const status = JSON.parse(readFileSync(statusFd, 'utf8')) as UpdateStatusRecord;
    const lock = JSON.parse(readFileSync(lockFd, 'utf8')) as { pid?: unknown; transactionId?: unknown; transactionAuthorization?: unknown; createdAt?: unknown };
    const userDataPath = path.resolve(canonicalUserDataPath);
    if (userDataPath === path.parse(userDataPath).root || status.state !== 'pending' || status.version !== expectedVersion || status.targetAppPath !== path.resolve(currentAppPath) || status.applicationIdentity !== expectedIdentity || !status.lockPath || path.resolve(status.lockPath) !== path.resolve(path.join(userDataPath, 'update.lock')) || !status.transactionId || !/^[0-9a-f-]{36}$/i.test(status.transactionId) || !status.transactionAuthorization || !/^[0-9a-f]{64}$/i.test(status.transactionAuthorization) || lock.transactionId !== status.transactionId || lock.transactionAuthorization !== status.transactionAuthorization || typeof lock.createdAt !== 'string' || typeof lock.pid !== 'number' || !Number.isInteger(lock.pid) || lock.pid <= 0) return null;
    if (requestedPath !== undefined && (!path.isAbsolute(requestedPath) || path.resolve(requestedPath) !== userDataPath)) return null;
    authenticated = true;
    return { userDataPath, status, statusFd, lockFd };
  } catch {
    return null;
  } finally {
    if (!authenticated) {
      if (statusFd !== undefined) closeSync(statusFd);
      if (lockFd !== undefined) closeSync(lockFd);
    }
  }
}

async function assertPackageVersion(sourceRoot: string, expectedVersion: string): Promise<void> {
  const packageJson = JSON.parse(await fs.readFile(path.join(sourceRoot, 'package.json'), 'utf8')) as { name?: string; version?: string };
  if (packageJson.name !== 'lucifold' || packageJson.version !== expectedVersion) throw new Error('The staged source manifest does not match the approved lucifold tag.');
}

async function rejectSymlinks(root: string): Promise<void> {
  const pending = [root];
  while (pending.length) {
    const current = pending.pop() as string;
    for (const entry of await fs.readdir(current, { withFileTypes: true })) {
      const entryPath = path.join(current, entry.name);
      if (entry.isSymbolicLink()) throw new Error('The approved update contains a symbolic link and was rejected.');
      if (entry.isDirectory()) pending.push(entryPath);
    }
  }
}

export async function findApplicationBundle(root: string): Promise<string | null> {
  const expected = path.join(root, 'mac-arm64', 'lucifold.app');
  try {
    const stat = await fs.lstat(expected);
    return stat.isDirectory() && !stat.isSymbolicLink() ? expected : null;
  } catch {
    return null;
  }
}

/**
 * Verify the package output and perform at most one clean rebuild when the
 * packager exits successfully but leaves an incomplete or unstable bundle.
 * A second invalid result remains a hard failure; this is recovery from a
 * known transient output state, not an arbitrary retry loop.
 */
export async function verifyStagedApplicationOutput(
  sourceRoot: string,
  packageCommand: () => Promise<void>,
  attempts: BundleValidationAttempt[] = [],
  quarantineCleanup: QuarantineCleanupDiagnostic[] = [],
): Promise<{ appPath: string; attempts: BundleValidationAttempt[]; quarantineCleanup: QuarantineCleanupDiagnostic[] }> {
  const releaseRoot = path.join(sourceRoot, 'release');
  const quarantineRoots: string[] = [];
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    let appPath: string | null = null;
    try {
      await packageCommand();
      appPath = await findApplicationBundle(releaseRoot);
      if (!appPath) throw new Error('The staged build did not produce a lucifold.app bundle.');
      await assertApplicationBundle(appPath);
      await assertStableApplicationBundle(appPath);
      quarantineCleanup.push(...await cleanupQuarantineRoots(quarantineRoots));
      return { appPath, attempts, quarantineCleanup };
    } catch (error) {
      attempts.push({
        attempt,
        appPath,
        error: error instanceof Error ? error.message : String(error),
        manifest: await captureTreeManifest(releaseRoot),
      });
      if (attempt === 2) {
        quarantineCleanup.push(...await cleanupQuarantineRoots(quarantineRoots));
        throw error;
      }
      const quarantineRoot = await resetBuildOutput(releaseRoot, sourceRoot);
      if (quarantineRoot) quarantineRoots.push(quarantineRoot);
    }
  }
  throw new Error('The staged application could not be verified.');
}

async function resetBuildOutput(releaseRoot: string, sourceRoot: string): Promise<string | undefined> {
  if (!isPathWithin(releaseRoot, sourceRoot)) throw new Error('The staging output directory is outside the extracted source tree.');
  const stat = await fs.lstat(releaseRoot).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  });
  if (stat && (!stat.isDirectory() || stat.isSymbolicLink() || hasUntrustedSymlink(releaseRoot))) throw new Error('The staging output directory is not a trusted directory.');
  let quarantineRoot: string | undefined;
  if (stat) {
    // Move the complete invalid output out of the source tree first. The
    // rebuild must never wait for recursive cleanup of a populated bundle.
    quarantineRoot = path.join(path.dirname(sourceRoot), `.lucifold-release-reset-${randomUUID()}`);
    if (!isPathWithin(quarantineRoot, path.dirname(sourceRoot))) throw new Error('The quarantine directory is outside the staging directory.');
    await fs.rename(releaseRoot, quarantineRoot);
  }
  await fs.mkdir(releaseRoot, { recursive: true, mode: 0o700 });
  return quarantineRoot;
}

async function cleanupQuarantineRoots(quarantineRoots: string[]): Promise<QuarantineCleanupDiagnostic[]> {
  const diagnostics: QuarantineCleanupDiagnostic[] = [];
  for (const quarantineRoot of quarantineRoots) {
    const errors: string[] = [];
    let cleaned = false;
    let attempts = 0;
    for (; attempts < 2; attempts += 1) {
      try {
        await fs.rm(quarantineRoot, { recursive: true, force: true });
        cleaned = true;
        break;
      } catch (error) {
        errors.push(error instanceof Error ? error.message : String(error));
      }
    }
    const diagnostic = { quarantineRoot, attempts, cleaned, errors };
    diagnostics.push(diagnostic);
    if (!cleaned) console.warn(`lucifold staging quarantine cleanup deferred: ${JSON.stringify(diagnostic)}`);
  }
  return diagnostics;
}

export async function assertApplicationBundle(appPath: string): Promise<void> {
  const bundle = await fs.lstat(appPath);
  if (!bundle.isDirectory() || bundle.isSymbolicLink()) throw new Error('The staged application bundle is not a trusted directory.');
  const requiredFiles = [
    path.join(appPath, 'Contents', 'MacOS', 'lucifold'),
    path.join(appPath, 'Contents', 'Info.plist'),
    path.join(appPath, 'Contents', 'Resources', 'app.asar'),
  ];
  for (const filePath of requiredFiles) {
    const stat = await fs.lstat(filePath);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size <= 0) {
      throw new Error(`The staged application bundle is incomplete or unsafe: ${filePath}`);
    }
  }
}

export async function assertStableApplicationBundle(appPath: string): Promise<void> {
  await assertApplicationBundle(appPath);
  const before = await applicationBundleManifest(appPath);
  await new Promise<void>((resolve) => setImmediate(resolve));
  await assertApplicationBundle(appPath);
  const after = await applicationBundleManifest(appPath);
  if (before !== after) throw new Error('The staged application bundle changed during verification.');
}

async function applicationBundleManifest(appPath: string): Promise<string> {
  const files = [
    path.join(appPath, 'Contents', 'MacOS', 'lucifold'),
    path.join(appPath, 'Contents', 'Info.plist'),
    path.join(appPath, 'Contents', 'Resources', 'app.asar'),
  ];
  const manifest = [];
  for (const filePath of files) {
    const stat = await fs.stat(filePath);
    manifest.push({
      path: path.relative(appPath, filePath),
      device: stat.dev,
      inode: stat.ino,
      size: stat.size,
      mtimeMs: stat.mtimeMs,
      mode: stat.mode,
    });
  }
  return JSON.stringify(manifest);
}

async function runStagingCommand(commandRunner: CommandRunner, events: StagingCommandEvent[], command: string, args: string[], cwd: string | undefined, timeout: number): Promise<CommandResult> {
  const startedAt = new Date().toISOString();
  try {
    const result = await commandRunner(command, args, cwd, timeout);
    events.push({ command, args, cwd, startedAt, completedAt: result.closedAt ?? new Date().toISOString(), exitedAt: result.exitedAt, closedAt: result.closedAt, pid: result.pid, pidAliveAfterClose: result.pid === undefined ? undefined : isProcessAlive(result.pid), exitCode: result.exitCode ?? 0, signal: result.signal ?? null, stdout: truncateDiagnostic(result.stdout), stderr: truncateDiagnostic(result.stderr) });
    return result;
  } catch (error) {
    const details = commandErrorDetails(error);
    events.push({ command, args, cwd, startedAt, completedAt: new Date().toISOString(), pid: details.pid, pidAliveAfterClose: details.pid === undefined ? undefined : isProcessAlive(details.pid), exitCode: details.exitCode, signal: details.signal, stdout: truncateDiagnostic(details.stdout), stderr: truncateDiagnostic(details.stderr), error: { name: error instanceof Error ? error.name : 'Error', message: error instanceof Error ? error.message : String(error), exitCode: details.exitCode, signal: details.signal } });
    throw error;
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function commandErrorDetails(error: unknown): { pid?: number; exitCode?: number | null; signal?: NodeJS.Signals | null; stdout?: string; stderr?: string } {
  if (!error || typeof error !== 'object') return {};
  const value = error as Partial<CommandResult>;
  return { pid: value.pid, exitCode: value.exitCode, signal: value.signal, stdout: value.stdout, stderr: value.stderr };
}

function truncateDiagnostic(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  return value.length <= 64 * 1024 ? value : `${value.slice(0, 64 * 1024)}\n[truncated]`;
}

async function preserveStagingFailureEvidence(tempPath: string, stagingRoot: string | undefined, commandEvents: StagingCommandEvent[], error: unknown, bundleValidationAttempts: BundleValidationAttempt[] = [], quarantineCleanup: QuarantineCleanupDiagnostic[] = []): Promise<void> {
  try {
    const evidenceRoot = await fs.mkdtemp(path.join(tempPath, 'lucifold-staging-failure-'));
    const manifest = stagingRoot ? await captureTreeManifest(stagingRoot) : [];
    const payload = {
      createdAt: new Date().toISOString(),
      stagingRoot,
      commandEvents,
      bundleValidationAttempts,
      quarantineCleanup,
      error: {
        name: error instanceof Error ? error.name : 'Error',
        message: error instanceof Error ? error.message : String(error),
        ...commandErrorDetails(error),
      },
      manifest,
    };
    await fs.writeFile(path.join(evidenceRoot, 'staging-failure.json'), JSON.stringify(payload, null, 2), { mode: 0o600 });
  } catch {
    // Failure evidence is best effort and must never change the fail-closed result.
  }
}

async function captureTreeManifest(root: string): Promise<Array<{ path: string; type: string; size?: number; mtimeMs?: number; mode?: number; nlink?: number }>> {
  const result: Array<{ path: string; type: string; size?: number; mtimeMs?: number; mode?: number; nlink?: number }> = [];
  const pending = [root];
  while (pending.length && result.length < 10_000) {
    const current = pending.pop() as string;
    let entries: import('node:fs').Dirent[];
    try {
      entries = await fs.readdir(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const entryPath = path.join(current, entry.name);
      const relative = path.relative(root, entryPath);
      try {
        const stat = await fs.lstat(entryPath);
        const type = stat.isDirectory() ? 'directory' : stat.isFile() ? 'file' : stat.isSymbolicLink() ? 'symlink' : 'other';
        result.push({ path: relative, type, size: stat.size, mtimeMs: stat.mtimeMs, mode: stat.mode, nlink: stat.nlink });
        if (stat.isDirectory() && !stat.isSymbolicLink()) pending.push(entryPath);
      } catch {
        result.push({ path: relative, type: 'unavailable' });
      }
      if (result.length >= 10_000) break;
    }
  }
  return result.sort((a, b) => a.path.localeCompare(b.path));
}

function parseVersion(value: string): [number, number, number] | null {
  const match = value.replace(/^v/, '').match(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

function normalizeOrigin(origin: string): string {
  return origin.trim().replace(/\.git$/i, '').replace(/\/$/, '').toLowerCase();
}

function isValidReleaseSigningKey(value: string): boolean {
  return /^ssh-ed25519\s+[A-Za-z0-9+/=]+(?:\s+[^\r\n]*)?$/.test(value.trim());
}

function isValidReleaseSigningPrincipal(value: string): boolean {
  return /^[A-Za-z0-9._@+-]+$/.test(value);
}

function hasUntrustedSymlink(candidate: string): boolean {
  const resolved = path.resolve(candidate);
  const parsed = path.parse(resolved);
  let current = parsed.root;
  for (const part of resolved.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    try {
      const stat = lstatSync(current);
      if (!stat.isSymbolicLink()) continue;
      const target = realpathSync.native(current);
      const systemAlias = (current === '/var' && target === '/private/var') || (current === '/tmp' && target === '/private/tmp');
      if (!systemAlias) return true;
    } catch {
      return true;
    }
  }
  return false;
}

function commandFailureMessage(error: unknown, fallback: string): string {
  if (!(error instanceof Error)) return fallback;
  const message = error.message.replace(/\s+/g, ' ').trim();
  if (/ENOSPC|no space left/i.test(message)) return 'There is not enough free storage to stage the update.';
  if (/dirty|uncommitted/i.test(message)) return 'The source repository has uncommitted changes.';
  return message ? `${fallback} ${message.slice(0, 220)}` : fallback;
}

function runCommand(command: string, args: string[], cwd?: string, timeout = COMMAND_TIMEOUT): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    void Promise.all([resolveControlledExecutable(command), prepareControlledEnvironment()]).then(([executable]) => {
      const startedAt = new Date().toISOString();
      let exitCode: number | null = null;
      let signal: NodeJS.Signals | null = null;
      let exitedAt: string | undefined;
      let closedAt: string | undefined;
      const child = execFile(executable, args, { cwd, env: controlledChildEnvironment(), timeout, maxBuffer: 8 * 1024 * 1024 }, (error, stdout, stderr) => {
        const output = String(stdout);
        const errors = String(stderr);
        const result: CommandResult = { stdout: output, stderr: errors, exitCode: exitCode ?? (error ? (typeof error.code === 'number' ? error.code : null) : 0), signal, pid: child.pid, startedAt, exitedAt, closedAt: closedAt ?? new Date().toISOString() };
        if (error) {
          const wrapped = Object.assign(new Error(String(errors || output || error.message)), {
            name: error.name,
            exitCode: result.exitCode,
            signal: result.signal,
            pid: result.pid,
            stdout: output,
            stderr: errors,
          });
          reject(wrapped);
          return;
        }
        resolve(result);
      });
      child.on('exit', (code, childSignal) => {
        exitCode = code;
        signal = childSignal;
        exitedAt = new Date().toISOString();
      });
      child.on('close', () => {
        closedAt = new Date().toISOString();
      });
    }).catch(reject);
  });
}

function runCommandFromFileInput(command: string, args: string[], fileHandle: Awaited<ReturnType<typeof fs.open>>, cwd?: string, timeout = COMMAND_TIMEOUT): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    void Promise.all([resolveControlledExecutable(command), prepareControlledEnvironment()]).then(([executable]) => {
      const input = fileHandle.createReadStream({ start: 0, autoClose: false });
      const child = spawn(executable, args, { cwd, env: controlledChildEnvironment(), stdio: [input, 'pipe', 'pipe'] });
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        child.kill('SIGKILL');
        reject(new Error(`${command} timed out.`));
      }, timeout);
      input.on('error', (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        child.kill('SIGKILL');
        reject(error);
      });
      child.stdout?.on('data', (chunk: Buffer) => stdout.push(chunk));
      child.stderr?.on('data', (chunk: Buffer) => stderr.push(chunk));
      child.on('error', (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(error);
      });
      child.on('close', (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        const output = Buffer.concat(stdout).toString();
        const errors = Buffer.concat(stderr).toString();
        if (code !== 0) {
          reject(new Error(errors || output || `${command} exited with status ${code ?? 'unknown'}.`));
        } else {
          resolve({ stdout: output, stderr: errors });
        }
      });
    }).catch(reject);
  });
}

function launchHelper(executable: string, args: string[], cwd: string): void {
  const child = spawn(executable, args, { cwd, detached: true, stdio: 'ignore', env: controlledChildEnvironment() });
  child.unref();
}

async function resolveControlledExecutable(command: string): Promise<string> {
  const candidates = CONTROLLED_EXECUTABLES[command];
  if (!candidates) throw new Error(`The updater does not allow executable ${command}.`);
  for (const candidate of candidates) {
    try {
      const candidateStat = await fs.lstat(candidate);
      if (!candidateStat.isSymbolicLink() && !candidateStat.isFile()) continue;
      const canonical = await fs.realpath(candidate);
      const allowedRoot = path.dirname(path.dirname(candidate));
      if (!isPathWithinOrEqual(canonical, allowedRoot)) continue;
      const stat = await fs.stat(canonical);
      if (!stat.isFile() || (stat.mode & 0o022) !== 0 || ![0, typeof process.getuid === 'function' ? process.getuid() : 0].includes(stat.uid)) continue;
      await fs.access(canonical, fsConstants.X_OK);
      return canonical;
    } catch {
      // Try the next fixed system location.
    }
  }
  throw new Error(`The updater could not resolve its controlled ${command} executable.`);
}

function controlledChildEnvironment(): NodeJS.ProcessEnv {
  const safePath = ['/usr/local/bin', '/opt/homebrew/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin'].join(path.delimiter);
  const isolatedRoot = path.join(os.tmpdir(), `lucifold-updater-${process.pid}`);
  return {
    PATH: safePath,
    HOME: path.join(isolatedRoot, 'home'),
    TMPDIR: path.join(isolatedRoot, 'tmp'),
    LANG: 'C',
    LC_ALL: 'C',
    CI: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_SYSTEM: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_TERMINAL_PROMPT: '0',
    GIT_ASKPASS: '/usr/bin/false',
    npm_config_userconfig: '/dev/null',
    npm_config_global: 'false',
  };
}

async function prepareControlledEnvironment(): Promise<void> {
  const isolatedRoot = path.join(os.tmpdir(), `lucifold-updater-${process.pid}`);
  await fs.mkdir(path.join(isolatedRoot, 'home'), { recursive: true, mode: 0o700 });
  await fs.mkdir(path.join(isolatedRoot, 'tmp'), { recursive: true, mode: 0o700 });
}

function isPathWithinOrEqual(child: string, parent: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}
