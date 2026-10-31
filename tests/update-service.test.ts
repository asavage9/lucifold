import assert from 'node:assert/strict';
import { execFile as execFileCallback, spawn } from 'node:child_process';
import { once } from 'node:events';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import { performInstallationForTest, recoverInterruptedUpdate, runUpdateHelper } from '../src/main/services/update-helper.js';
import { applicationIdentity, compareVersions, extractVerifiedArchiveForTest, isApprovedTag, isExpectedOrigin, isPathWithin, readUpdateStatus, validateArchiveEntries, writeUpdateStatus, UpdateService, type CommandRunner, type UpdatePlan } from '../src/main/services/update-service.js';

const execFile = promisify(execFileCallback);

async function runGit(cwd: string, args: string[]): Promise<void> {
  await execFile('git', args, { cwd });
}

async function temporaryDirectory(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

async function deadProcessId(): Promise<number> {
  const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
  const pid = child.pid!;
  await once(child, 'exit');
  return pid;
}

async function createFixtureApp(appPath: string, executableBody: string, marker: string): Promise<void> {
  await fs.mkdir(path.join(appPath, 'Contents', 'MacOS'), { recursive: true });
  await fs.mkdir(path.join(appPath, 'Contents', 'Resources'), { recursive: true });
  await fs.writeFile(path.join(appPath, 'Contents', 'MacOS', 'lucifold'), `#!/bin/sh\n${executableBody}\n`);
  await fs.chmod(path.join(appPath, 'Contents', 'MacOS', 'lucifold'), 0o755);
  await fs.writeFile(path.join(appPath, 'Contents', 'Info.plist'), `fixture-${marker}`);
  await fs.writeFile(path.join(appPath, 'Contents', 'Resources', 'app.asar'), `fixture-${marker}`);
  await fs.writeFile(path.join(appPath, 'marker.txt'), marker);
}

function verificationScript(mode: 'success' | 'fail' | 'remove-backup' | 'sleep'): string {
  if (mode === 'fail') return 'exit 0';
  if (mode === 'sleep') return 'sleep 60';
  const code = mode === 'success'
    ? 'const fs=require("fs");const p=process.argv[1];const s=JSON.parse(fs.readFileSync(p,"utf8"));s.state="verified";s.version=process.argv[2];fs.writeFileSync(p,JSON.stringify(s));'
    : 'const fs=require("fs");const p=process.argv[1];const s=JSON.parse(fs.readFileSync(p,"utf8"));fs.rmSync(s.backupPath,{recursive:true,force:true});';
  return `STATUS="$2"\nVERSION="$3"\n${process.execPath} -e '${code}' "$STATUS" "$VERSION"`;
}

async function createProductionPlan(root: string, mode: 'success' | 'fail' | 'remove-backup' | 'sleep') {
  const stagingRoot = path.join(root, 'lucifold-update-integration');
  const userDataPath = path.join(root, 'data');
  const targetAppPath = path.join(root, 'installed', 'lucifold.app');
  const stagedAppPath = path.join(stagingRoot, 'staged', 'lucifold.app');
  const backupRoot = path.join(userDataPath, 'update-backups', 'integration');
  await fs.mkdir(path.dirname(targetAppPath), { recursive: true });
  await createFixtureApp(targetAppPath, 'exit 0', 'known-good');
  await createFixtureApp(stagedAppPath, verificationScript(mode), 'candidate');
  const plan: UpdatePlan = {
    version: 2,
    parentPid: await deadProcessId(),
    targetAppPath,
    stagedAppPath,
    stagingRoot,
    userDataPath,
    backupRoot,
    backupPath: path.join(backupRoot, 'lucifold.app'),
    lockPath: path.join(userDataPath, 'update.lock'),
    statusPath: path.join(userDataPath, 'update-status.json'),
    newVersion: '1.0.1',
    targetExecutable: path.join(targetAppPath, 'Contents', 'MacOS', 'lucifold'),
    transactionId: '22222222-2222-4222-8222-222222222222',
    expectedAppIdentity: await applicationIdentity(stagedAppPath),
    knownGoodApplicationIdentity: await applicationIdentity(targetAppPath),
  };
  await fs.mkdir(userDataPath, { recursive: true });
  await fs.writeFile(plan.lockPath, JSON.stringify({ pid: process.pid, transactionId: plan.transactionId }));
  return { plan, planPath: path.join(stagingRoot, 'update-plan.json') };
}

test('update validation accepts only stable tags and strict path containment', () => {
  assert.equal(isApprovedTag('v1.0.1'), true);
  assert.equal(isApprovedTag('v1.0.1-rc.1'), false);
  assert.equal(isApprovedTag('v01.0.1'), false);
  assert.equal(compareVersions('1.10.0', '1.9.0') > 0, true);
  assert.throws(() => compareVersions('1.0', '1.0.0'), /semantic version/i);
  assert.equal(isExpectedOrigin('/tmp/lucifold-remote.git', '/tmp/lucifold-remote'), true);
  assert.equal(isExpectedOrigin('https://example.com/lucifold.git', 'https://github.com/example/lucifold'), false);
  assert.equal(isPathWithin('/tmp/lucifold-update-1/source', '/tmp/lucifold-update-1'), true);
  assert.equal(isPathWithin('/tmp/lucifold-update-1/../outside', '/tmp/lucifold-update-1'), false);
  assert.equal(isPathWithin('/tmp/lucifold-update-1', '/tmp/lucifold-update-1'), false);
});

test('real local Git fixture discovers an approved newer lucifold tag after fetch', async () => {
  const root = await temporaryDirectory('lucifold-update-git-');
  const remote = path.join(root, 'remote.git');
  const source = path.join(root, 'source');
  await fs.mkdir(source, { recursive: true });
  await execFile('git', ['init', '--bare', remote]);
  await execFile('git', ['init', '-q'], { cwd: source });
  await runGit(source, ['config', 'user.email', 'lucifold-tests@example.invalid']);
  await runGit(source, ['config', 'user.name', 'lucifold tests']);
  await runGit(source, ['remote', 'add', 'origin', remote]);
  await fs.writeFile(path.join(source, 'package.json'), JSON.stringify({ name: 'lucifold', version: '1.0.0' }));
  await runGit(source, ['add', 'package.json']);
  await runGit(source, ['commit', '-q', '-m', 'v1.0.0']);
  await runGit(source, ['tag', 'v1.0.0']);
  await fs.writeFile(path.join(source, 'package.json'), JSON.stringify({ name: 'lucifold', version: '1.0.1' }));
  await runGit(source, ['add', 'package.json']);
  await runGit(source, ['commit', '-q', '-m', 'v1.0.1']);
  await runGit(source, ['tag', 'v1.0.1']);
  await runGit(source, ['push', '-q', '--all', 'origin']);
  await runGit(source, ['push', '-q', '--tags', 'origin']);
  await runGit(source, ['tag', '-d', 'v1.0.1']);

  const service = new UpdateService({
    currentVersion: '1.0.0',
    packaged: false,
    currentExecutable: '/tmp/lucifold',
    userDataPath: path.join(root, 'data'),
    tempPath: root,
    sourceCandidates: [],
    expectedOrigin: remote,
  });
  const result = await service.checkForUpdates(source);
  assert.equal(result.state, 'available');
  assert.equal(result.tag, 'v1.0.1');
  assert.equal(result.latestVersion, '1.0.1');
  assert.equal(result.canInstall, false);
  await fs.rm(root, { recursive: true, force: true });
});

test('release identity checks ignore local-only tags, URL rewrites, and substituted remote references', async () => {
  const root = await temporaryDirectory('lucifold-update-identity-');
  const expectedOrigin = 'https://github.com/example/lucifold.git';
  await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'lucifold', version: '1.0.1' }));

  const cleanRunner: CommandRunner = async (command, args) => {
    if (command !== 'git') return { stdout: 'tool\n', stderr: '' };
    if (args[0] === 'rev-parse' && args[1] === '--show-toplevel') return { stdout: `${root}\n`, stderr: '' };
    if (args[0] === 'config' && args[3] === 'remote.origin.url') return { stdout: `${expectedOrigin}\n`, stderr: '' };
    if (args[0] === 'config' && args[2] === '--get-regexp') return { stdout: '\n', stderr: '' };
    if (args[0] === 'status') return { stdout: '', stderr: '' };
    if (args[0] === 'tag' && args[1] === '--list') return { stdout: 'v1.0.2\n', stderr: '' };
    if (args[0] === 'show') return { stdout: JSON.stringify({ name: 'lucifold', version: '1.0.2' }), stderr: '' };
    if (args[0] === 'ls-remote') return { stdout: `${'a'.repeat(40)}\trefs/tags/v1.0.2\n`, stderr: '' };
    if (args[0] === 'rev-parse' && args[1] === 'v1.0.2^{commit}') return { stdout: `${'b'.repeat(40)}\n`, stderr: '' };
    return { stdout: '', stderr: '' };
  };
  const localOnlyRunner: CommandRunner = async (command, args) => {
    if (command === 'git' && args[0] === 'ls-remote') return { stdout: '', stderr: '' };
    return cleanRunner(command, args);
  };
  const localOnly = await new UpdateService({ currentVersion: '1.0.1', packaged: false, currentExecutable: '/tmp/lucifold', userDataPath: path.join(root, 'data'), tempPath: root, sourceCandidates: [], expectedOrigin, commandRunner: localOnlyRunner }).checkForUpdates(root);
  assert.equal(localOnly.state, 'up-to-date');

  const substituted = await new UpdateService({ currentVersion: '1.0.1', packaged: false, currentExecutable: '/tmp/lucifold', userDataPath: path.join(root, 'data'), tempPath: root, sourceCandidates: [], expectedOrigin, commandRunner: cleanRunner }).checkForUpdates(root);
  assert.equal(substituted.state, 'up-to-date');

  const rewrittenRunner: CommandRunner = async (command, args) => {
    if (command === 'git' && args[0] === 'config' && args[2] === '--get-regexp') return { stdout: 'url.file:///tmp/rewritten.insteadOf https://github.com/example/lucifold.git\n', stderr: '' };
    return cleanRunner(command, args);
  };
  const rewritten = await new UpdateService({ currentVersion: '1.0.1', packaged: false, currentExecutable: '/tmp/lucifold', userDataPath: path.join(root, 'data'), tempPath: root, sourceCandidates: [], expectedOrigin, commandRunner: rewrittenRunner }).validateSourceRepository(root);
  assert.equal(rewritten.ok, false);

  const unexpectedOrigin = await new UpdateService({ currentVersion: '1.0.1', packaged: false, currentExecutable: '/tmp/lucifold', userDataPath: path.join(root, 'data'), tempPath: root, sourceCandidates: [], expectedOrigin: 'https://github.com/other/lucifold.git', commandRunner: cleanRunner }).validateSourceRepository(root);
  assert.equal(unexpectedOrigin.ok, false);
  await fs.rm(root, { recursive: true, force: true });
});

test('update check reports source not configured when no approved origin is embedded', async () => {
  const root = await temporaryDirectory('lucifold-update-disabled-');
  const runner: CommandRunner = async (command, args) => {
    if (command === 'git' && args[0] === 'rev-parse') return { stdout: `${root}\n`, stderr: '' };
    if (command === 'git' && args[0] === 'config') return { stdout: '\n', stderr: '' };
    if (command === 'git' && args[0] === 'status') return { stdout: '', stderr: '' };
    return { stdout: 'tool\n', stderr: '' };
  };
  await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'lucifold', version: '1.0.1' }));
  const service = new UpdateService({ currentVersion: '1.0.1', packaged: true, currentAppPath: '/tmp/lucifold.app', currentExecutable: '/tmp/lucifold', userDataPath: path.join(root, 'data'), tempPath: root, sourceCandidates: [], expectedOrigin: null, commandRunner: runner });
  const result = await service.checkForUpdates(root);
  assert.equal(result.state, 'not-configured');
  assert.equal(result.canInstall, false);
  await fs.rm(root, { recursive: true, force: true });
});

test('archive validation rejects unsafe paths, entry floods, malformed archives, and extracted symlinks', async () => {
  assert.throws(() => validateArchiveEntries(['/absolute/path']), /unsafe path/i);
  assert.throws(() => validateArchiveEntries(['source/../../escape']), /unsafe path/i);
  assert.throws(() => validateArchiveEntries(['./same', 'same']), /duplicate/i);
  assert.throws(() => validateArchiveEntries(Array.from({ length: 50_001 }, (_, index) => `entry-${index}`)), /too many entries/i);

  const root = await temporaryDirectory('lucifold-archive-safety-');
  const files = path.join(root, 'files');
  const destination = path.join(root, 'destination');
  const archive = path.join(root, 'source.tar');
  await fs.mkdir(files, { recursive: true });
  await fs.mkdir(destination, { recursive: true });
  await fs.writeFile(path.join(files, 'safe.txt'), 'safe');
  await fs.writeFile(path.join(root, 'outside-secret'), 'do not modify');
  await fs.symlink(path.join(root, 'outside-secret'), path.join(files, 'linked.txt'));
  await execFile('tar', ['-cf', archive, '-C', files, '.']);
  await assert.rejects(extractVerifiedArchiveForTest(archive, destination), /symbolic link|special filesystem entry|unsafe link target/i);
  assert.equal(await fs.readFile(path.join(root, 'outside-secret'), 'utf8'), 'do not modify');
  await assert.rejects(fs.access(destination));

  const safeArchive = path.join(root, 'safe.tar');
  const safeDestination = path.join(root, 'safe-destination');
  await execFile('tar', ['-cf', safeArchive, '-C', files, 'safe.txt']);
  await extractVerifiedArchiveForTest(safeArchive, safeDestination);
  assert.equal(await fs.readFile(path.join(safeDestination, 'safe.txt'), 'utf8'), 'safe');

  const hardlinkFiles = path.join(root, 'hardlink-files');
  const hardlinkArchive = path.join(root, 'hardlink.tar');
  await fs.mkdir(hardlinkFiles);
  await fs.writeFile(path.join(hardlinkFiles, 'safe.txt'), 'safe');
  await fs.link(path.join(hardlinkFiles, 'safe.txt'), path.join(hardlinkFiles, 'hard.txt'));
  await execFile('tar', ['-cf', hardlinkArchive, '-C', hardlinkFiles, '.']);
  await fs.mkdir(destination, { recursive: true });
  await assert.rejects(extractVerifiedArchiveForTest(hardlinkArchive, destination), /hard link|special filesystem entry/i);
  await assert.rejects(fs.access(destination));

  const malformed = path.join(root, 'malformed.tar');
  await fs.writeFile(malformed, 'not a tar archive');
  await assert.rejects(extractVerifiedArchiveForTest(malformed, destination), /tar|archive/i);
  await fs.rm(root, { recursive: true, force: true });
});

test('update installation helper backs up the current app and restores it after a move failure', async () => {
  const root = await temporaryDirectory('lucifold-update-helper-');
  const stagingRoot = path.join(root, 'lucifold-update-test');
  const userDataPath = path.join(root, 'data');
  const targetAppPath = path.join(root, 'installed', 'lucifold.app');
  const stagedAppPath = path.join(stagingRoot, 'lucifold.app');
  const backupRoot = path.join(userDataPath, 'update-backups', '1.0.1-test');
  const plan: UpdatePlan = { version: 2, parentPid: process.pid, targetAppPath, stagedAppPath, stagingRoot, userDataPath, backupRoot, backupPath: path.join(backupRoot, 'lucifold.app'), lockPath: path.join(userDataPath, 'update.lock'), statusPath: path.join(userDataPath, 'update-status.json'), newVersion: '1.0.1', targetExecutable: path.join(targetAppPath, 'Contents', 'MacOS', 'lucifold') };
  await fs.mkdir(targetAppPath, { recursive: true });
  await fs.mkdir(stagedAppPath, { recursive: true });
  await fs.mkdir(path.join(targetAppPath, 'Contents', 'MacOS'), { recursive: true });
  await fs.mkdir(path.join(targetAppPath, 'Contents', 'Resources'), { recursive: true });
  await fs.mkdir(path.join(stagedAppPath, 'Contents', 'MacOS'), { recursive: true });
  await fs.mkdir(path.join(stagedAppPath, 'Contents', 'Resources'), { recursive: true });
  await fs.writeFile(path.join(targetAppPath, 'Contents', 'MacOS', 'lucifold'), 'old-executable');
  await fs.writeFile(path.join(targetAppPath, 'Contents', 'Info.plist'), 'old-info');
  await fs.writeFile(path.join(targetAppPath, 'Contents', 'Resources', 'app.asar'), 'old-asar');
  await fs.writeFile(path.join(stagedAppPath, 'Contents', 'MacOS', 'lucifold'), 'new-executable');
  await fs.writeFile(path.join(stagedAppPath, 'Contents', 'Info.plist'), 'new-info');
  await fs.writeFile(path.join(stagedAppPath, 'Contents', 'Resources', 'app.asar'), 'new-asar');
  await fs.writeFile(path.join(targetAppPath, 'version.txt'), 'old');
  await fs.writeFile(path.join(stagedAppPath, 'version.txt'), 'new');
  await performInstallationForTest(plan, undefined, () => undefined);
  assert.equal(await fs.readFile(path.join(targetAppPath, 'version.txt'), 'utf8'), 'new');
  assert.equal(await fs.readFile(path.join(plan.backupRoot, 'lucifold.app', 'version.txt'), 'utf8'), 'old');
  assert.deepEqual(await readUpdateStatus(plan.statusPath).then((status) => ({ state: status?.state, version: status?.version })), { state: 'installed', version: '1.0.1' });

  const rollbackTarget = path.join(root, 'rollback-installed', 'lucifold.app');
  const rollbackStaging = path.join(root, 'lucifold-update-rollback', 'lucifold.app');
  const rollbackData = path.join(root, 'rollback-data');
  const rollbackBackupRoot = path.join(rollbackData, 'update-backups', 'rollback');
  const rollbackPlan: UpdatePlan = { ...plan, targetAppPath: rollbackTarget, stagedAppPath: rollbackStaging, stagingRoot: path.dirname(rollbackStaging), userDataPath: rollbackData, backupRoot: rollbackBackupRoot, backupPath: path.join(rollbackBackupRoot, 'lucifold.app'), lockPath: path.join(rollbackData, 'update.lock'), statusPath: path.join(rollbackData, 'update-status.json'), targetExecutable: path.join(rollbackTarget, 'Contents', 'MacOS', 'lucifold') };
  await fs.mkdir(rollbackTarget, { recursive: true });
  await fs.mkdir(rollbackStaging, { recursive: true });
  await fs.mkdir(path.join(rollbackTarget, 'Contents', 'MacOS'), { recursive: true });
  await fs.mkdir(path.join(rollbackTarget, 'Contents', 'Resources'), { recursive: true });
  await fs.mkdir(path.join(rollbackStaging, 'Contents', 'MacOS'), { recursive: true });
  await fs.mkdir(path.join(rollbackStaging, 'Contents', 'Resources'), { recursive: true });
  await fs.writeFile(path.join(rollbackTarget, 'Contents', 'MacOS', 'lucifold'), 'old-executable');
  await fs.writeFile(path.join(rollbackTarget, 'Contents', 'Info.plist'), 'old-info');
  await fs.writeFile(path.join(rollbackTarget, 'Contents', 'Resources', 'app.asar'), 'old-asar');
  await fs.writeFile(path.join(rollbackStaging, 'Contents', 'MacOS', 'lucifold'), 'new-executable');
  await fs.writeFile(path.join(rollbackStaging, 'Contents', 'Info.plist'), 'new-info');
  await fs.writeFile(path.join(rollbackStaging, 'Contents', 'Resources', 'app.asar'), 'new-asar');
  await fs.writeFile(path.join(rollbackTarget, 'version.txt'), 'old');
  await fs.writeFile(path.join(rollbackStaging, 'version.txt'), 'new');
  let moveCount = 0;
  const move = async (source: string, destination: string) => {
    moveCount += 1;
    if (moveCount === 2) throw new Error('simulated storage failure');
    await fs.rename(source, destination);
  };
  await assert.rejects(performInstallationForTest(rollbackPlan, move, () => undefined), /simulated storage failure/);
  assert.equal(await fs.readFile(path.join(rollbackTarget, 'version.txt'), 'utf8'), 'old');
  await fs.rm(root, { recursive: true, force: true });
});

test('failed rollback is reported as failed instead of false rolled-back success', async () => {
  const root = await temporaryDirectory('lucifold-update-rollback-failure-');
  const stagingRoot = path.join(root, 'lucifold-update-failure');
  const data = path.join(root, 'data');
  const target = path.join(root, 'installed', 'lucifold.app');
  const staged = path.join(stagingRoot, 'lucifold.app');
  const backupRoot = path.join(data, 'update-backups', 'failure');
  const plan: UpdatePlan = { version: 2, parentPid: process.pid, targetAppPath: target, stagedAppPath: staged, stagingRoot, userDataPath: data, backupRoot, backupPath: path.join(backupRoot, 'lucifold.app'), lockPath: path.join(data, 'update.lock'), statusPath: path.join(data, 'update-status.json'), newVersion: '1.0.1', targetExecutable: path.join(target, 'Contents', 'MacOS', 'lucifold') };
  await fs.mkdir(path.join(target, 'Contents', 'MacOS'), { recursive: true });
  await fs.mkdir(path.join(target, 'Contents', 'Resources'), { recursive: true });
  await fs.mkdir(path.join(staged, 'Contents', 'MacOS'), { recursive: true });
  await fs.mkdir(path.join(staged, 'Contents', 'Resources'), { recursive: true });
  await fs.writeFile(path.join(target, 'Contents', 'MacOS', 'lucifold'), 'old');
  await fs.writeFile(path.join(target, 'Contents', 'Info.plist'), 'old');
  await fs.writeFile(path.join(target, 'Contents', 'Resources', 'app.asar'), 'old');
  await fs.writeFile(path.join(staged, 'Contents', 'MacOS', 'lucifold'), 'new');
  await fs.writeFile(path.join(staged, 'Contents', 'Info.plist'), 'new');
  await fs.writeFile(path.join(staged, 'Contents', 'Resources', 'app.asar'), 'new');
  let moveCount = 0;
  const move = async (source: string, destination: string) => {
    moveCount += 1;
    if (moveCount >= 2) throw new Error(moveCount === 2 ? 'simulated install failure' : 'simulated restore failure');
    await fs.rename(source, destination);
  };
  await assert.rejects(performInstallationForTest(plan, move, () => undefined), /simulated install failure/);
  const status = await readUpdateStatus(plan.statusPath);
  assert.equal(status?.state, 'failed');
  assert.match(status?.message ?? '', /restoration was not verified/i);
  await fs.rm(root, { recursive: true, force: true });
});

test('startup recovery restores the known-good app after an interrupted pending transaction', async () => {
  const root = await temporaryDirectory('lucifold-update-recovery-');
  const stagingRoot = path.join(root, 'lucifold-update-pending');
  const data = path.join(root, 'data');
  const target = path.join(root, 'installed', 'lucifold.app');
  const backupRoot = path.join(data, 'update-backups', 'pending');
  const backup = path.join(backupRoot, 'lucifold.app');
  await fs.mkdir(path.join(backup, 'Contents', 'MacOS'), { recursive: true });
  await fs.mkdir(path.join(backup, 'Contents', 'Resources'), { recursive: true });
  await fs.writeFile(path.join(backup, 'Contents', 'MacOS', 'lucifold'), 'known-good');
  await fs.writeFile(path.join(backup, 'Contents', 'Info.plist'), 'known-good');
  await fs.writeFile(path.join(backup, 'Contents', 'Resources', 'app.asar'), 'known-good');
  const knownGoodIdentity = await applicationIdentity(backup);
  await fs.mkdir(target, { recursive: true });
  await fs.writeFile(path.join(target, 'incomplete'), 'partial');
  const statusPath = path.join(data, 'update-status.json');
  const lockPath = path.join(data, 'update.lock');
  const settingsPath = path.join(data, 'settings.json');
  const presetsPath = path.join(data, 'presets.json');
  const originalsPath = path.join(root, 'originals', 'source.jpg');
  const completedExportPath = path.join(root, 'exports', 'source.jpg');
  await fs.mkdir(data, { recursive: true });
  await fs.mkdir(path.dirname(originalsPath), { recursive: true });
  await fs.mkdir(path.dirname(completedExportPath), { recursive: true });
  await fs.writeFile(settingsPath, '{"theme":"dark"}');
  await fs.writeFile(presetsPath, '{"presets":[]}');
  await fs.writeFile(originalsPath, 'original');
  await fs.writeFile(completedExportPath, 'completed export');
  const preservedData = await Promise.all([settingsPath, presetsPath, originalsPath, completedExportPath].map(async (filePath) => [filePath, await fs.readFile(filePath, 'utf8')] as const));
  const transactionId = '11111111-1111-4111-8111-111111111111';
  await fs.writeFile(lockPath, JSON.stringify({ pid: process.pid, transactionId }));
  await writeUpdateStatus(statusPath, { state: 'pending', version: '1.0.1', message: 'pending', timestamp: new Date().toISOString(), backupPath: backup, lockPath, stagingRoot, targetAppPath: target, transactionId, applicationIdentity: knownGoodIdentity, knownGoodApplicationIdentity: knownGoodIdentity });
  await recoverInterruptedUpdate(data, target, '1.0.0');
  assert.equal(await fs.readFile(path.join(target, 'Contents', 'MacOS', 'lucifold'), 'utf8'), 'known-good');
  const status = await readUpdateStatus(statusPath);
  assert.equal(status?.state, 'rolled-back');
  await assert.rejects(fs.access(lockPath));
  for (const [filePath, contents] of preservedData) assert.equal(await fs.readFile(filePath, 'utf8'), contents);
  await fs.rm(root, { recursive: true, force: true });
});

test('production update helper installs only after startup verification and preserves user data', async () => {
  const root = await temporaryDirectory('lucifold-production-helper-success-');
  const { plan, planPath } = await createProductionPlan(root, 'success');
  const settingsPath = path.join(plan.userDataPath, 'settings.json');
  const presetsPath = path.join(plan.userDataPath, 'presets.json');
  const originalPath = path.join(root, 'originals', 'source.jpg');
  const exportPath = path.join(root, 'exports', 'source.jpg');
  await fs.mkdir(path.dirname(originalPath), { recursive: true });
  await fs.mkdir(path.dirname(exportPath), { recursive: true });
  await fs.writeFile(settingsPath, '{"theme":"dark"}');
  await fs.writeFile(presetsPath, '{"presets":[]}');
  await fs.writeFile(originalPath, 'original');
  await fs.writeFile(exportPath, 'completed export');
  const preserved = await Promise.all([settingsPath, presetsPath, originalPath, exportPath].map(async (filePath) => [filePath, await fs.readFile(filePath)] as const));
  await fs.writeFile(planPath, JSON.stringify(plan));

  await runUpdateHelper(planPath, { startupVerifyTimeout: 2_000 });

  assert.equal(await fs.readFile(path.join(plan.targetAppPath, 'marker.txt'), 'utf8'), 'candidate');
  assert.equal((await readUpdateStatus(plan.statusPath))?.state, 'installed');
  await assert.rejects(fs.access(plan.lockPath));
  await assert.rejects(fs.access(plan.backupRoot));
  await assert.rejects(fs.access(plan.stagingRoot));
  for (const [filePath, contents] of preserved) assert.deepEqual(await fs.readFile(filePath), contents);
  await fs.rm(root, { recursive: true, force: true });
});

test('forced helper termination leaves a recoverable pending transaction and startup recovery restores it', async () => {
  const root = await temporaryDirectory('lucifold-production-helper-interrupted-');
  const { plan, planPath } = await createProductionPlan(root, 'sleep');
  await fs.writeFile(planPath, JSON.stringify(plan));
  const code = 'import { runUpdateHelper } from "./src/main/services/update-helper.ts"; await runUpdateHelper(process.argv.at(-1));';
  const child = spawn(process.execPath, ['--import', 'tsx/esm', '--input-type=module', '-e', code, planPath], { cwd: path.resolve('.'), stdio: 'ignore' });
  let pending = false;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const status = await readUpdateStatus(plan.statusPath);
    if (status?.state === 'pending') { pending = true; break; }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(pending, true);
  child.kill('SIGKILL');
  await once(child, 'exit');
  await recoverInterruptedUpdate(plan.userDataPath, plan.targetAppPath, '1.0.0');
  assert.equal(await fs.readFile(path.join(plan.targetAppPath, 'marker.txt'), 'utf8'), 'known-good');
  assert.equal((await readUpdateStatus(plan.statusPath))?.state, 'rolled-back');
  await assert.rejects(fs.access(plan.lockPath));
  await fs.rm(root, { recursive: true, force: true });
});

test('production helper rolls back after failed relaunch and reports failed rollback without a known-good copy', async () => {
  const root = await temporaryDirectory('lucifold-production-helper-failure-');
  const failedLaunch = await createProductionPlan(root, 'fail');
  await fs.writeFile(failedLaunch.planPath, JSON.stringify(failedLaunch.plan));
  await assert.rejects(runUpdateHelper(failedLaunch.planPath, { startupVerifyTimeout: 2 }), /startup verification/i);
  assert.equal(await fs.readFile(path.join(failedLaunch.plan.targetAppPath, 'marker.txt'), 'utf8'), 'known-good');
  assert.equal((await readUpdateStatus(failedLaunch.plan.statusPath))?.state, 'rolled-back');

  const failedRollbackRoot = await temporaryDirectory('lucifold-production-helper-rollback-failure-');
  const failedRollback = await createProductionPlan(failedRollbackRoot, 'remove-backup');
  await fs.writeFile(failedRollback.planPath, JSON.stringify(failedRollback.plan));
  await assert.rejects(runUpdateHelper(failedRollback.planPath, { startupVerifyTimeout: 2 }), /startup verification/i);
  assert.equal((await readUpdateStatus(failedRollback.plan.statusPath))?.state, 'failed');
  assert.match((await readUpdateStatus(failedRollback.plan.statusPath))?.message ?? '', /restoration was not verified|existing application remains/i);
  await fs.rm(root, { recursive: true, force: true });
  await fs.rm(failedRollbackRoot, { recursive: true, force: true });
});
