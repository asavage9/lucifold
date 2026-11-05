import assert from 'node:assert/strict';
import { execFile as execFileCallback, spawn } from 'node:child_process';
import { once } from 'node:events';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import { performInstallationForTest, recoverInterruptedUpdate, runUpdateHelper } from '../src/main/services/update-helper.js';
import { applicationIdentity, assertApplicationBundle, assertStableApplicationBundle, compareVersions, extractVerifiedArchiveForTest, findApplicationBundle, isApprovedTag, isExpectedOrigin, isPathWithin, markUpdateVerified, readUpdateStatus, resolveVerificationUserDataPath, validateArchiveEntries, verifyStagedApplicationOutput, writeUpdateStatus, UpdateService, type CommandRunner, type UpdatePlan } from '../src/main/services/update-service.js';
import { resolveCanonicalApplicationDataPath } from '../src/main/services/application-paths.js';
import { parseUpdaterArguments } from '../src/main/services/verification-arguments.js';

const execFile = promisify(execFileCallback);

async function runGit(cwd: string, args: string[]): Promise<void> {
  await execFile('git', args, { cwd });
}

async function createSshSigningKey(root: string, name = 'release-key'): Promise<{ privateKey: string; publicKey: string }> {
  const privateKey = path.join(root, name);
  await execFile('/usr/bin/ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', 'lucifold-release', '-f', privateKey]);
  return { privateKey, publicKey: (await fs.readFile(`${privateKey}.pub`, 'utf8')).trim() };
}

async function configureSshSigning(source: string, privateKey: string, publicKey: string, allowedSignersPath: string, principal = 'lucifold-release'): Promise<void> {
  await runGit(source, ['config', 'user.email', principal]);
  await runGit(source, ['config', 'gpg.format', 'ssh']);
  await runGit(source, ['config', 'user.signingKey', privateKey]);
  await fs.writeFile(allowedSignersPath, `${principal} namespaces="git" ${publicKey}\n`, { mode: 0o600 });
  await runGit(source, ['config', 'gpg.ssh.allowedSignersFile', allowedSignersPath]);
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
    ? 'const fs=require("fs");const path=require("path");const p=process.argv[1];const s=JSON.parse(fs.readFileSync(p,"utf8"));s.state="verified";s.version=process.argv[2];fs.writeFileSync(p,JSON.stringify(s));fs.writeFileSync(path.join(process.argv[3],"helper-user-data-marker"),"propagated");'
    : 'const fs=require("fs");const p=process.argv[1];const s=JSON.parse(fs.readFileSync(p,"utf8"));fs.rmSync(s.backupPath,{recursive:true,force:true});';
  return `USER_DATA="$2"\nSTATUS="$4"\nVERSION="$5"\n${process.execPath} -e '${code}' "$STATUS" "$VERSION" "$USER_DATA"`;
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
    newVersion: '1.0.3',
    targetExecutable: path.join(targetAppPath, 'Contents', 'MacOS', 'lucifold'),
    transactionId: '22222222-2222-4222-8222-222222222222',
    transactionAuthorization: 'a'.repeat(64),
    expectedAppIdentity: await applicationIdentity(stagedAppPath),
    knownGoodApplicationIdentity: await applicationIdentity(targetAppPath),
  };
  await fs.mkdir(userDataPath, { recursive: true });
  await fs.writeFile(plan.lockPath, JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString(), transactionId: plan.transactionId, transactionAuthorization: plan.transactionAuthorization }), { mode: 0o600 });
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

test('staging validation requires the exact complete arm64 bundle and rejects incomplete or relocated output', async () => {
  const root = await temporaryDirectory('lucifold-staging-validation-');
  const releaseRoot = path.join(root, 'release');
  const wrongLocation = path.join(releaseRoot, 'wrong-location', 'lucifold.app');
  const expected = path.join(releaseRoot, 'mac-arm64', 'lucifold.app');
  await fs.mkdir(releaseRoot, { recursive: true });
  await createFixtureApp(wrongLocation, 'exit 0', 'wrong-location');
  assert.equal(await findApplicationBundle(releaseRoot), null);

  await fs.mkdir(path.join(expected, 'Contents', 'MacOS'), { recursive: true });
  await fs.mkdir(path.join(expected, 'Contents', 'Resources'), { recursive: true });
  await fs.writeFile(path.join(expected, 'Contents', 'MacOS', 'lucifold'), '#!/bin/sh\nexit 0\n');
  await fs.writeFile(path.join(expected, 'Contents', 'Info.plist'), 'incomplete');
  assert.equal(await findApplicationBundle(releaseRoot), expected);
  await assert.rejects(assertApplicationBundle(expected), /incomplete|ENOENT/i);

  await fs.writeFile(path.join(expected, 'Contents', 'Resources', 'app.asar'), 'complete');
  await assert.doesNotReject(assertApplicationBundle(expected));
  await assert.doesNotReject(assertStableApplicationBundle(expected));
  await fs.rm(path.join(expected, 'Contents', 'Resources', 'app.asar'));
  await assert.rejects(assertStableApplicationBundle(expected), /incomplete|ENOENT/i);
  await fs.writeFile(path.join(expected, 'Contents', 'Resources', 'app.asar'), 'delayed-output');
  const relocated = path.join(releaseRoot, 'mac-x64', 'lucifold.app');
  await createFixtureApp(relocated, 'exit 0', 'relocated');
  assert.equal(await findApplicationBundle(releaseRoot), expected);
  await fs.rm(root, { recursive: true, force: true });
});

test('staging performs one clean rebuild after an incomplete successful package and preserves the failed manifest', async () => {
  const root = await temporaryDirectory('lucifold-staging-recovery-');
  const expected = path.join(root, 'release', 'mac-arm64', 'lucifold.app');
  let packageAttempts = 0;
  const result = await verifyStagedApplicationOutput(root, async () => {
    packageAttempts += 1;
    if (packageAttempts === 1) {
      await fs.mkdir(path.join(expected, 'Contents', 'MacOS'), { recursive: true });
      await fs.mkdir(path.join(expected, 'Contents', 'Resources', 'app.asar'), { recursive: true });
      await fs.writeFile(path.join(expected, 'Contents', 'MacOS', 'lucifold'), '#!/bin/sh\nexit 0\n');
      await fs.writeFile(path.join(expected, 'Contents', 'Info.plist'), 'incomplete');
      return;
    }
    await createFixtureApp(expected, 'exit 0', 'recovered');
  });
  assert.equal(packageAttempts, 2);
  assert.equal(result.appPath, expected);
  assert.equal(result.attempts.length, 1);
  assert.match(result.attempts[0].error, /incomplete|regular file/i);
  assert.equal(result.attempts[0].manifest.find((entry) => entry.path.endsWith('Contents/Resources/app.asar'))?.type, 'directory');
  await fs.rm(root, { recursive: true, force: true });
});

test('staging fails closed after the bounded rebuild if output remains relocated', async () => {
  const root = await temporaryDirectory('lucifold-staging-recovery-failure-');
  let packageAttempts = 0;
  await assert.rejects(verifyStagedApplicationOutput(root, async () => {
    packageAttempts += 1;
    await createFixtureApp(path.join(root, 'release', 'mac-x64', 'lucifold.app'), 'exit 0', `relocated-${packageAttempts}`);
  }), /did not produce|could not be verified/i);
  assert.equal(packageAttempts, 2);
  await fs.rm(root, { recursive: true, force: true });
});

test('the updater package command disables implicit CI publishing', async () => {
  const manifest = JSON.parse(await fs.readFile(path.resolve('package.json'), 'utf8')) as { scripts?: Record<string, string> };
  assert.equal(manifest.scripts?.['package:dir'], 'npm run build && electron-builder --mac --arm64 --dir --publish never');
});

test('updater argument parsing rejects incomplete, conflicting, duplicate, and malformed verification vectors', () => {
  const status = '/tmp/update-status.json';
  const data = '/tmp/user-data';
  const identity = 'a'.repeat(64);
  assert.deepEqual(parseUpdaterArguments(['electron', '--lucifold-update-verify', status, '1.0.3', identity]), { kind: 'verification', statusPath: status, version: '1.0.3', identity });
  assert.deepEqual(parseUpdaterArguments(['electron', '--user-data-dir', data, '--lucifold-update-verify', status, '1.0.3', identity]), { kind: 'verification', statusPath: status, version: '1.0.3', identity, userDataPath: data });
  for (const argv of [
    ['electron', '--lucifold-update-verify', status, '1.0.3'],
    ['electron', '--lucifold-update-verify', status, '1.0.3', 'bad'],
    ['electron', '--user-data-dir', data],
    ['electron', '--user-data-dir'],
    ['electron', '--lucifold-update-verify', status, '1.0.3', identity, '--lucifold-update-verify', status, '1.0.3', identity],
    ['electron', '--lucifold-update-helper', '/tmp/plan.json', '--lucifold-update-verify', status, '1.0.3', identity],
    ['electron', '--lucifold-update-verify', status, '1.0.3', identity, '--unexpected'],
    ['electron', '--lucifold-update-helper', '/tmp/plan.json', 'extra'],
  ]) assert.equal(parseUpdaterArguments(argv).kind, 'invalid');
  assert.deepEqual(parseUpdaterArguments(['electron', '--lucifold-update-helper', '/tmp/plan.json']), { kind: 'helper', planPath: '/tmp/plan.json' });
});

test('update verification resolves and validates one authenticated user-data path', async () => {
  const root = await temporaryDirectory('lucifold-verification-path-');
  const userDataPath = path.join(root, 'user-data');
  const statusPath = path.join(userDataPath, 'update-status.json');
  const currentAppPath = path.join(root, 'installed', 'lucifold.app');
  const identity = 'a'.repeat(64);
  const lockPath = path.join(userDataPath, 'update.lock');
  const transactionId = '33333333-3333-4333-8333-333333333333';
  const transactionAuthorization = 'c'.repeat(64);
  await fs.mkdir(userDataPath, { recursive: true });
  await fs.writeFile(lockPath, JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString(), transactionId, transactionAuthorization }), { mode: 0o600 });
  await writeUpdateStatus(statusPath, { state: 'pending', version: '1.0.3', message: 'pending', timestamp: new Date().toISOString(), targetAppPath: currentAppPath, transactionId, transactionAuthorization, lockPath, applicationIdentity: identity });
  assert.equal(resolveVerificationUserDataPath(statusPath, '1.0.3', identity, currentAppPath), null);
  assert.equal(resolveVerificationUserDataPath(statusPath, '1.0.3', identity, currentAppPath, userDataPath, userDataPath), userDataPath);
  await assert.rejects(fs.access(path.join(userDataPath, 'session-data')));
  assert.equal(resolveVerificationUserDataPath(statusPath, '1.0.3', identity, currentAppPath, userDataPath, path.join(root, 'redirected-data')), null);
  assert.equal(resolveVerificationUserDataPath(statusPath, '1.0.3', identity, currentAppPath, path.join(root, 'other-data'), userDataPath), null);
  assert.equal(resolveVerificationUserDataPath(statusPath, '1.0.3', 'b'.repeat(64), currentAppPath, undefined, userDataPath), null);
  await fs.rm(lockPath);
  assert.equal(resolveVerificationUserDataPath(statusPath, '1.0.3', identity, currentAppPath, undefined, userDataPath), null);
  await fs.writeFile(lockPath, JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString(), transactionId: '55555555-5555-4555-8555-555555555555' }), { mode: 0o600 });
  assert.equal(resolveVerificationUserDataPath(statusPath, '1.0.3', identity, currentAppPath, undefined, userDataPath), null);
  await fs.writeFile(lockPath, JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString(), transactionId }), { mode: 0o600 });
  const lockHardlink = path.join(userDataPath, 'lock-hardlink');
  await fs.link(lockPath, lockHardlink);
  assert.equal(resolveVerificationUserDataPath(statusPath, '1.0.3', identity, currentAppPath, undefined, userDataPath), null);
  await fs.rm(lockHardlink);
  await fs.symlink(lockPath, lockHardlink);
  await fs.rm(lockPath);
  await fs.rename(lockHardlink, lockPath);
  assert.equal(resolveVerificationUserDataPath(statusPath, '1.0.3', identity, currentAppPath, undefined, userDataPath), null);
  await fs.rm(lockPath);
  await fs.writeFile(lockPath, JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString(), transactionId }), { mode: 0o600 });
  const statusHardlink = path.join(userDataPath, 'status-hardlink');
  await fs.link(statusPath, statusHardlink);
  assert.equal(resolveVerificationUserDataPath(statusHardlink, '1.0.3', identity, currentAppPath, undefined, userDataPath), null);
  await fs.rm(statusHardlink);
  for (const state of ['verified', 'installed', 'failed', 'rolled-back'] as const) {
    await writeUpdateStatus(statusPath, { state, version: '1.0.3', message: state, timestamp: new Date().toISOString(), targetAppPath: currentAppPath, transactionId: '33333333-3333-4333-8333-333333333333', applicationIdentity: identity });
    assert.equal(resolveVerificationUserDataPath(statusPath, '1.0.3', identity, currentAppPath, undefined, userDataPath), null);
  }
  await writeUpdateStatus(statusPath, { state: 'pending', version: '1.0.2', message: 'old', timestamp: new Date().toISOString(), targetAppPath: currentAppPath, transactionId, lockPath, applicationIdentity: identity });
  assert.equal(resolveVerificationUserDataPath(statusPath, '1.0.3', identity, currentAppPath, undefined, userDataPath), null);
  await writeUpdateStatus(statusPath, { state: 'pending', version: '1.0.3', message: 'wrong app', timestamp: new Date().toISOString(), targetAppPath: path.join(root, 'other.app'), transactionId, lockPath, applicationIdentity: identity });
  assert.equal(resolveVerificationUserDataPath(statusPath, '1.0.3', identity, currentAppPath, undefined, userDataPath), null);

  const aliasRoot = path.join(root, 'alias-root');
  const canonicalRoot = path.join(root, 'canonical-root');
  await fs.mkdir(path.join(canonicalRoot, 'user-data'), { recursive: true });
  await fs.symlink(canonicalRoot, aliasRoot, 'dir');
  const aliasedStatusPath = path.join(aliasRoot, 'user-data', 'update-status.json');
  await writeUpdateStatus(path.join(canonicalRoot, 'user-data', 'update-status.json'), { state: 'pending', version: '1.0.3', message: 'aliased', timestamp: new Date().toISOString(), targetAppPath: currentAppPath, transactionId: '33333333-3333-4333-8333-333333333333', applicationIdentity: identity });
  assert.equal(resolveVerificationUserDataPath(aliasedStatusPath, '1.0.3', identity, currentAppPath), null);
  await fs.rm(root, { recursive: true, force: true });
});

test('startup verification accepts only the current application and version once', async () => {
  const root = await temporaryDirectory('lucifold-verification-replay-');
  const appPath = path.join(root, 'installed', 'lucifold.app');
  const userDataPath = path.join(root, 'user-data');
  const statusPath = path.join(userDataPath, 'update-status.json');
  await createFixtureApp(appPath, 'exit 0', 'candidate');
  const identity = await applicationIdentity(appPath);
  const lockPath = path.join(userDataPath, 'update.lock');
  const transactionId = '44444444-4444-4444-8444-444444444444';
  const transactionAuthorization = 'd'.repeat(64);
  await fs.mkdir(userDataPath, { recursive: true });
  await fs.writeFile(lockPath, JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString(), transactionId, transactionAuthorization }), { mode: 0o600 });
  await writeUpdateStatus(statusPath, { state: 'pending', version: '1.0.3', message: 'pending', timestamp: new Date().toISOString(), targetAppPath: appPath, transactionId, transactionAuthorization, lockPath, applicationIdentity: identity });
  assert.equal(await markUpdateVerified(statusPath, '1.0.3', '1.0.3', appPath, identity, userDataPath), true);
  assert.equal((await readUpdateStatus(statusPath))?.state, 'verified');
  assert.equal(await markUpdateVerified(statusPath, '1.0.3', '1.0.3', appPath, identity, userDataPath), false);
  assert.equal(resolveVerificationUserDataPath(statusPath, '1.0.3', identity, appPath, undefined, userDataPath), null);
  await fs.rm(root, { recursive: true, force: true });
});

test('macOS canonical application data ignores a temporary helper HOME', () => {
  assert.equal(resolveCanonicalApplicationDataPath('/tmp/temporary-home/Library/Application Support', 'lucifold', 'darwin', '/Users/tester'), '/Users/tester/Library/Application Support/lucifold');
  assert.throws(() => resolveCanonicalApplicationDataPath('/tmp/app-data', 'lucifold', 'darwin', 'relative-home'), /account home/i);
});

test('real local Git fixture rejects an unsigned lightweight tag after fetch', async () => {
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
  assert.equal(result.state, 'up-to-date');
  assert.equal(result.tag, undefined);
  assert.equal(result.latestVersion, undefined);
  assert.equal(result.canInstall, false);
  await fs.rm(root, { recursive: true, force: true });
});

test('real local Git fixture discovers an annotated newer tag and verifies its peeled commit', async () => {
  const root = await temporaryDirectory('lucifold-update-annotated-git-');
  const remote = path.join(root, 'remote.git');
  const source = path.join(root, 'source');
  await fs.mkdir(source, { recursive: true });
  await execFile('git', ['init', '--bare', remote]);
  await execFile('git', ['init', '-q'], { cwd: source });
  await runGit(source, ['config', 'user.email', 'lucifold-release']);
  await runGit(source, ['config', 'user.name', 'lucifold tests']);
  await runGit(source, ['remote', 'add', 'origin', remote]);
  const signingKey = await createSshSigningKey(root);
  await configureSshSigning(source, signingKey.privateKey, signingKey.publicKey, path.join(root, 'allowed-signers'));
  await fs.writeFile(path.join(source, 'package.json'), JSON.stringify({ name: 'lucifold', version: '1.0.1' }));
  await runGit(source, ['add', 'package.json']);
  await runGit(source, ['commit', '-q', '-m', 'v1.0.1']);
  await runGit(source, ['tag', 'v1.0.1']);
  await fs.writeFile(path.join(source, 'package.json'), JSON.stringify({ name: 'lucifold', version: '1.0.2' }));
  await runGit(source, ['add', 'package.json']);
  await runGit(source, ['commit', '-q', '-m', 'v1.0.2']);
  await runGit(source, ['tag', '-s', 'v1.0.2', '-m', 'lucifold v1.0.2']);
  await runGit(source, ['push', '-q', '--all', 'origin']);
  await runGit(source, ['push', '-q', '--tags', 'origin']);
  await runGit(source, ['tag', '-d', 'v1.0.2']);

  const directListing = (await execFile('git', ['ls-remote', '--tags', remote, 'refs/tags/v1.0.2'])).stdout.trim();
  const fullListing = (await execFile('git', ['ls-remote', '--tags', remote, 'refs/tags/v1.0.2', 'refs/tags/v1.0.2^{}'])).stdout.trim().split(/\r?\n/);
  const directObject = directListing.split(/\s+/)[0];
  const peeledCommit = fullListing.find((line) => line.endsWith('refs/tags/v1.0.2^{}'))?.split(/\s+/)[0];
  assert.match(directObject, /^[0-9a-f]{40}$/i);
  assert.match(peeledCommit ?? '', /^[0-9a-f]{40}$/i);
  assert.notEqual(directObject, peeledCommit);

  const service = new UpdateService({
    currentVersion: '1.0.1',
    packaged: false,
    currentExecutable: '/tmp/lucifold',
    userDataPath: path.join(root, 'data'),
    tempPath: root,
    sourceCandidates: [],
    expectedOrigin: remote,
    trustedReleaseSigningKey: signingKey.publicKey,
    trustedReleaseSigningPrincipal: 'lucifold-release',
  });
  const result = await service.checkForUpdates(source);
  assert.equal(result.state, 'available');
  assert.equal(result.tag, 'v1.0.2');
  assert.equal(result.latestVersion, '1.0.2');
  const untrustedKey = await createSshSigningKey(root, 'untrusted-release-key');
  const untrustedService = new UpdateService({
    currentVersion: '1.0.1',
    packaged: false,
    currentExecutable: '/tmp/lucifold',
    userDataPath: path.join(root, 'untrusted-data'),
    tempPath: root,
    sourceCandidates: [],
    expectedOrigin: remote,
    trustedReleaseSigningKey: untrustedKey.publicKey,
    trustedReleaseSigningPrincipal: 'lucifold-release',
  });
  assert.equal((await untrustedService.checkForUpdates(source)).state, 'up-to-date');
  const unconfiguredTrustService = new UpdateService({
    currentVersion: '1.0.1',
    packaged: false,
    currentExecutable: '/tmp/lucifold',
    userDataPath: path.join(root, 'unconfigured-data'),
    tempPath: root,
    sourceCandidates: [],
    expectedOrigin: remote,
    trustedReleaseSigningKey: null,
  });
  assert.equal((await unconfiguredTrustService.checkForUpdates(source)).state, 'up-to-date');
  await fs.rm(root, { recursive: true, force: true });
});

test('signed-tag verification pins trusted ssh-keygen against local and inherited Git overrides', async () => {
  const root = await temporaryDirectory('lucifold-update-verifier-override-');
  const remote = path.join(root, 'remote.git');
  const source = path.join(root, 'source');
  const marker = path.join(root, 'untrusted-verifier-ran');
  await fs.mkdir(source, { recursive: true });
  await execFile('git', ['init', '--bare', remote]);
  await execFile('git', ['init', '-q'], { cwd: source });
  await runGit(source, ['config', 'user.email', 'lucifold-release']);
  await runGit(source, ['config', 'user.name', 'lucifold tests']);
  await runGit(source, ['remote', 'add', 'origin', remote]);
  const signingKey = await createSshSigningKey(root);
  await configureSshSigning(source, signingKey.privateKey, signingKey.publicKey, path.join(root, 'allowed-signers'));
  await fs.writeFile(path.join(source, 'package.json'), JSON.stringify({ name: 'lucifold', version: '1.0.1' }));
  await runGit(source, ['add', 'package.json']);
  await runGit(source, ['commit', '-q', '-m', 'v1.0.1']);
  await runGit(source, ['tag', 'v1.0.1']);
  await fs.writeFile(path.join(source, 'package.json'), JSON.stringify({ name: 'lucifold', version: '1.0.2' }));
  await runGit(source, ['add', 'package.json']);
  await runGit(source, ['commit', '-q', '-m', 'v1.0.2']);
  await runGit(source, ['tag', '-s', 'v1.0.2', '-m', 'lucifold v1.0.2']);
  await runGit(source, ['push', '-q', '--all', 'origin']);
  await runGit(source, ['push', '-q', '--tags', 'origin']);
  await runGit(source, ['tag', '-d', 'v1.0.2']);

  const untrustedVerifier = path.join(root, 'untrusted-ssh-keygen');
  await fs.writeFile(untrustedVerifier, `#!/bin/sh\nprintf 'ran' > ${marker}\nexit 1\n`);
  await fs.chmod(untrustedVerifier, 0o700);
  await runGit(source, ['config', 'gpg.ssh.program', untrustedVerifier]);

  const previousEnvironment = {
    GIT_CONFIG_COUNT: process.env.GIT_CONFIG_COUNT,
    GIT_CONFIG_KEY_0: process.env.GIT_CONFIG_KEY_0,
    GIT_CONFIG_VALUE_0: process.env.GIT_CONFIG_VALUE_0,
  };
  process.env.GIT_CONFIG_COUNT = '1';
  process.env.GIT_CONFIG_KEY_0 = 'gpg.ssh.program';
  process.env.GIT_CONFIG_VALUE_0 = untrustedVerifier;
  try {
    const service = new UpdateService({
      currentVersion: '1.0.1',
      packaged: false,
      currentExecutable: '/tmp/lucifold',
      userDataPath: path.join(root, 'data'),
      tempPath: root,
      sourceCandidates: [],
      expectedOrigin: remote,
      trustedReleaseSigningKey: signingKey.publicKey,
      trustedReleaseSigningPrincipal: 'lucifold-release',
    });
    const result = await service.checkForUpdates(source);
    assert.equal(result.state, 'available');
    assert.equal(result.tag, 'v1.0.2');
    assert.equal(await fs.access(marker).then(() => true).catch(() => false), false);
  } finally {
    for (const [key, value] of Object.entries(previousEnvironment)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
  await fs.rm(root, { recursive: true, force: true });
});

test('invalid or unavailable trusted release verifier configuration fails closed', async () => {
  const root = await temporaryDirectory('lucifold-update-invalid-verifier-');
  const expectedOrigin = 'https://github.com/example/lucifold.git';
  await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'lucifold', version: '1.0.1' }));
  const runner: CommandRunner = async (command, args) => {
    if (command !== 'git') return { stdout: 'tool\n', stderr: '' };
    if (args[0] === '--version') return { stdout: 'git version 2.50.0\n', stderr: '' };
    if (args[0] === 'rev-parse' && args[1] === '--show-toplevel') return { stdout: `${root}\n`, stderr: '' };
    if (args[0] === 'config' && args[3] === 'remote.origin.url') return { stdout: `${expectedOrigin}\n`, stderr: '' };
    if (args[0] === 'config' && args[2] === '--get-regexp') return { stdout: '\n', stderr: '' };
    if (args[0] === 'status') return { stdout: '', stderr: '' };
    if (args[0] === 'tag' && args[1] === '--list') return { stdout: 'v1.0.2\n', stderr: '' };
    if (args[0] === 'show') return { stdout: JSON.stringify({ name: 'lucifold', version: '1.0.2' }), stderr: '' };
    if (args[0] === 'ls-remote') return { stdout: `${'a'.repeat(40)}\trefs/tags/v1.0.2\n${'b'.repeat(40)}\trefs/tags/v1.0.2^{}\n`, stderr: '' };
    if (args[0] === 'rev-parse' && args[1] === 'v1.0.2') return { stdout: `${'a'.repeat(40)}\n`, stderr: '' };
    if (args[0] === 'cat-file') return { stdout: 'tag\n', stderr: '' };
    if (args[0] === 'rev-parse' && args[1] === 'v1.0.2^{commit}') return { stdout: `${'b'.repeat(40)}\n`, stderr: '' };
    return { stdout: '', stderr: '' };
  };
  const service = new UpdateService({ currentVersion: '1.0.1', packaged: false, currentExecutable: '/tmp/lucifold', userDataPath: path.join(root, 'data'), tempPath: root, sourceCandidates: [], expectedOrigin, commandRunner: runner, trustedReleaseSigningKey: 'not-an-ssh-ed25519-key' });
  assert.equal((await service.checkForUpdates(root)).state, 'up-to-date');
  await fs.rm(root, { recursive: true, force: true });
});

test('real local Git fixture rejects unsigned annotated tags before update discovery', async () => {
  const root = await temporaryDirectory('lucifold-update-unsigned-annotated-');
  const remote = path.join(root, 'remote.git');
  const source = path.join(root, 'source');
  await fs.mkdir(source, { recursive: true });
  await execFile('git', ['init', '--bare', remote]);
  await execFile('git', ['init', '-q'], { cwd: source });
  await runGit(source, ['config', 'user.email', 'lucifold-release']);
  await runGit(source, ['config', 'user.name', 'lucifold tests']);
  await runGit(source, ['remote', 'add', 'origin', remote]);
  const signingKey = await createSshSigningKey(root);
  await fs.writeFile(path.join(source, 'package.json'), JSON.stringify({ name: 'lucifold', version: '1.0.1' }));
  await runGit(source, ['add', 'package.json']);
  await runGit(source, ['commit', '-q', '-m', 'v1.0.1']);
  await runGit(source, ['tag', 'v1.0.1']);
  await fs.writeFile(path.join(source, 'package.json'), JSON.stringify({ name: 'lucifold', version: '1.0.2' }));
  await runGit(source, ['add', 'package.json']);
  await runGit(source, ['commit', '-q', '-m', 'v1.0.2']);
  await runGit(source, ['tag', '-a', 'v1.0.2', '-m', 'lucifold v1.0.2']);
  await runGit(source, ['push', '-q', '--all', 'origin']);
  await runGit(source, ['push', '-q', '--tags', 'origin']);
  await runGit(source, ['tag', '-d', 'v1.0.2']);

  const service = new UpdateService({
    currentVersion: '1.0.1',
    packaged: false,
    currentExecutable: '/tmp/lucifold',
    userDataPath: path.join(root, 'data'),
    tempPath: root,
    sourceCandidates: [],
    expectedOrigin: remote,
    trustedReleaseSigningKey: signingKey.publicKey,
    trustedReleaseSigningPrincipal: 'lucifold-release',
  });
  assert.equal((await service.checkForUpdates(source)).state, 'up-to-date');
  await fs.rm(root, { recursive: true, force: true });
});

test('annotated tag verification rejects missing, malformed, ambiguous, and mismatched remote references', async () => {
  const root = await temporaryDirectory('lucifold-update-tag-references-');
  const expectedOrigin = 'https://github.com/example/lucifold.git';
  await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'lucifold', version: '1.0.2' }));

  const check = async (remoteListing: string): Promise<ReturnType<UpdateService['checkForUpdates']>> => {
    const runner: CommandRunner = async (command, args) => {
      if (command !== 'git') return { stdout: 'tool\n', stderr: '' };
      if (args[0] === 'rev-parse' && args[1] === '--show-toplevel') return { stdout: `${root}\n`, stderr: '' };
      if (args[0] === 'config' && args[3] === 'remote.origin.url') return { stdout: `${expectedOrigin}\n`, stderr: '' };
      if (args[0] === 'config' && args[2] === '--get-regexp') return { stdout: '\n', stderr: '' };
      if (args[0] === 'status') return { stdout: '', stderr: '' };
      if (args[0] === 'tag' && args[1] === '--list') return { stdout: 'v1.0.2\n', stderr: '' };
      if (args[0] === 'show') return { stdout: JSON.stringify({ name: 'lucifold', version: '1.0.2' }), stderr: '' };
      if (args[0] === 'ls-remote') return { stdout: remoteListing, stderr: '' };
      if (args[0] === 'rev-parse' && args[1] === 'v1.0.2^{commit}') return { stdout: `${'b'.repeat(40)}\n`, stderr: '' };
      return { stdout: '', stderr: '' };
    };
    const service = new UpdateService({ currentVersion: '1.0.1', packaged: false, currentExecutable: '/tmp/lucifold', userDataPath: path.join(root, 'data'), tempPath: root, sourceCandidates: [], expectedOrigin, commandRunner: runner });
    return service.checkForUpdates(root);
  };

  const direct = 'a'.repeat(40);
  const peeled = 'c'.repeat(40);
  assert.equal((await check('')).state, 'up-to-date');
  assert.equal((await check(`not-a-sha\trefs/tags/v1.0.2\n`)).state, 'up-to-date');
  assert.equal((await check(`${direct}\trefs/tags/v1.0.2\n${direct}\trefs/tags/v1.0.2\n${peeled}\trefs/tags/v1.0.2^{}\n`)).state, 'up-to-date');
  assert.equal((await check(`${direct}\trefs/tags/v1.0.2\n${peeled}\trefs/tags/v1.0.2^{}\n`)).state, 'up-to-date');
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

test('signature verification failure stops before source build or helper launch', async () => {
  const root = await temporaryDirectory('lucifold-update-signature-failure-');
  const signingKey = await createSshSigningKey(root);
  const expectedOrigin = 'https://github.com/example/lucifold.git';
  const direct = 'a'.repeat(40);
  const peeled = 'b'.repeat(40);
  await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'lucifold', version: '1.0.1' }));
  const commands: Array<{ command: string; args: string[] }> = [];
  const runner: CommandRunner = async (command, args) => {
    commands.push({ command, args });
    if (command !== 'git') return { stdout: 'tool\n', stderr: '' };
    if (args[0] === 'rev-parse' && args[1] === '--show-toplevel') return { stdout: `${root}\n`, stderr: '' };
    if (args[0] === 'config' && args[3] === 'remote.origin.url') return { stdout: `${expectedOrigin}\n`, stderr: '' };
    if (args[0] === 'config' && args[2] === '--get-regexp') return { stdout: '\n', stderr: '' };
    if (args[0] === 'status') return { stdout: '', stderr: '' };
    if (args[0] === 'ls-remote') return { stdout: `${direct}\trefs/tags/v1.0.2\n${peeled}\trefs/tags/v1.0.2^{}\n`, stderr: '' };
    if (args[0] === 'rev-parse' && args[1] === 'v1.0.2') return { stdout: `${direct}\n`, stderr: '' };
    if (args[0] === 'cat-file') return { stdout: 'tag\n', stderr: '' };
    if (args[0] === 'rev-parse' && args[1] === 'v1.0.2^{commit}') return { stdout: `${peeled}\n`, stderr: '' };
    if (args.includes('verify-tag')) throw new Error('invalid signature');
    return { stdout: '', stderr: '' };
  };
  let helperLaunched = false;
  const service = new UpdateService({
    currentVersion: '1.0.1',
    packaged: true,
    currentAppPath: path.join(root, 'installed', 'lucifold.app'),
    currentExecutable: '/tmp/lucifold',
    userDataPath: path.join(root, 'data'),
    tempPath: root,
    sourceCandidates: [],
    expectedOrigin,
    commandRunner: runner,
    helperLauncher: () => { helperLaunched = true; },
    trustedReleaseSigningKey: signingKey.publicKey,
    trustedReleaseSigningPrincipal: 'lucifold-release',
  });
  const result = await service.prepareAndInstall('v1.0.2', root, () => undefined);
  assert.equal(result.accepted, false);
  assert.match(result.message, /not signed|could not be staged/i);
  assert.equal(helperLaunched, false);
  assert.equal(commands.some(({ command, args }) => command === 'npm' && (args[0] === 'ci' || args[0] === 'run')), false);
  const verificationCommand = commands.find(({ command, args }) => command === 'git' && args.includes('verify-tag'));
  assert.ok(verificationCommand);
  assert.ok(verificationCommand.args.some((arg) => arg.startsWith('gpg.ssh.program=/usr/bin/ssh-keygen')));
  assert.equal(verificationCommand.args.includes('gpg.ssh.revocationFile=/dev/null'), false);
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
  const transactionAuthorization = 'b'.repeat(64);
  await fs.writeFile(lockPath, JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString(), transactionId, transactionAuthorization }), { mode: 0o600 });
  const backupOwnershipMarker = path.join(backupRoot, '.lucifold-owner');
  await fs.writeFile(backupOwnershipMarker, `${transactionAuthorization}\n`, { mode: 0o600 });
  await writeUpdateStatus(statusPath, { state: 'pending', version: '1.0.1', message: 'pending', timestamp: new Date().toISOString(), backupPath: backup, backupRoot, backupOwnershipMarker, lockPath, stagingRoot, targetAppPath: target, transactionId, transactionAuthorization, applicationIdentity: knownGoodIdentity, knownGoodApplicationIdentity: knownGoodIdentity });
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
  assert.equal(await fs.readFile(path.join(plan.userDataPath, 'helper-user-data-marker'), 'utf8'), 'propagated');
  assert.equal((await readUpdateStatus(plan.statusPath))?.state, 'installed');
  await assert.rejects(fs.access(plan.lockPath));
  await assert.rejects(fs.access(plan.backupRoot));
  await assert.rejects(fs.access(plan.stagingRoot));
  for (const [filePath, contents] of preserved) assert.deepEqual(await fs.readFile(filePath), contents);
  await fs.rm(root, { recursive: true, force: true });
});

test('production helper rejects a plan bound to an alternate user-data directory', async () => {
  const root = await temporaryDirectory('lucifold-production-helper-user-data-boundary-');
  const { plan, planPath } = await createProductionPlan(root, 'fail');
  const alternateUserDataPath = path.join(root, 'alternate-data');
  plan.userDataPath = alternateUserDataPath;
  plan.lockPath = path.join(alternateUserDataPath, 'update.lock');
  plan.statusPath = path.join(alternateUserDataPath, 'update-status.json');
  plan.backupRoot = path.join(alternateUserDataPath, 'update-backups', 'integration');
  plan.backupPath = path.join(plan.backupRoot, 'lucifold.app');
  await fs.mkdir(alternateUserDataPath, { recursive: true });
  await fs.writeFile(plan.lockPath, JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString(), transactionId: plan.transactionId, transactionAuthorization: plan.transactionAuthorization }), { mode: 0o600 });
  await fs.writeFile(planPath, JSON.stringify(plan));
  await assert.rejects(runUpdateHelper(planPath, { expectedUserDataPath: path.join(root, 'data') }), /user-data directory/i);
  assert.equal(await fs.readFile(path.join(plan.targetAppPath, 'marker.txt'), 'utf8'), 'known-good');
  await assert.rejects(fs.access(plan.statusPath));
  await fs.rm(root, { recursive: true, force: true });
});

test('production helper rejects a symlinked update-backups boundary before installation', async () => {
  const root = await temporaryDirectory('lucifold-production-helper-backup-boundary-');
  const { plan, planPath } = await createProductionPlan(root, 'fail');
  const outside = path.join(root, 'outside-backups');
  await fs.mkdir(outside, { recursive: true });
  const outsideApp = path.join(outside, 'unauthorized.app');
  const outsideStatus = path.join(outside, 'unauthorized-status.json');
  await createFixtureApp(outsideApp, 'exit 0', 'must-remain');
  await fs.writeFile(outsideStatus, 'must-remain');
  const outsideHashes = [await applicationIdentity(outsideApp), await fs.readFile(outsideStatus, 'utf8')];
  const originalLock = await fs.readFile(plan.lockPath);
  await fs.symlink(outside, path.join(plan.userDataPath, 'update-backups'), 'dir');
  await fs.writeFile(planPath, JSON.stringify(plan));
  await assert.rejects(runUpdateHelper(planPath, { expectedUserDataPath: plan.userDataPath }), /untrusted symlink|canonical boundary/i);
  assert.equal(await fs.readFile(path.join(plan.targetAppPath, 'marker.txt'), 'utf8'), 'known-good');
  assert.deepEqual([await applicationIdentity(outsideApp), await fs.readFile(outsideStatus, 'utf8')], outsideHashes);
  assert.deepEqual(await fs.readFile(plan.lockPath), originalLock);
  await assert.rejects(fs.access(plan.statusPath));
  await fs.access(plan.stagingRoot);
  await fs.rm(root, { recursive: true, force: true });
});

test('production helper refuses a pre-existing backup root without deleting its contents', async () => {
  const root = await temporaryDirectory('lucifold-production-helper-owned-backup-');
  const { plan, planPath } = await createProductionPlan(root, 'fail');
  await fs.mkdir(plan.backupRoot, { recursive: true });
  const sentinel = path.join(plan.backupRoot, 'unrelated.txt');
  await fs.writeFile(sentinel, 'must-remain');
  await fs.writeFile(planPath, JSON.stringify(plan));
  const originalLock = await fs.readFile(plan.lockPath);
  await assert.rejects(runUpdateHelper(planPath, { expectedUserDataPath: plan.userDataPath }), /EEXIST|existing|installation/i);
  assert.equal(await fs.readFile(sentinel, 'utf8'), 'must-remain');
  assert.equal(await fs.readFile(path.join(plan.targetAppPath, 'marker.txt'), 'utf8'), 'known-good');
  assert.deepEqual(await fs.readFile(plan.lockPath), originalLock);
  await assert.rejects(fs.access(plan.statusPath));
  await fs.access(plan.stagingRoot);
  await fs.rm(root, { recursive: true, force: true });
});

test('startup recovery does not rewrite an unauthenticated incomplete status record', async () => {
  const root = await temporaryDirectory('lucifold-recovery-unauthorized-status-');
  const data = path.join(root, 'data');
  const appPath = path.join(root, 'installed', 'lucifold.app');
  const statusPath = path.join(data, 'update-status.json');
  await fs.mkdir(path.dirname(appPath), { recursive: true });
  await fs.mkdir(data, { recursive: true, mode: 0o700 });
  await createFixtureApp(appPath, 'exit 0', 'known-good');
  const status = JSON.stringify({ state: 'pending', version: '1.0.3', message: 'forged', timestamp: new Date().toISOString() });
  await fs.writeFile(statusPath, status);
  await recoverInterruptedUpdate(data, appPath, '1.0.2');
  assert.equal(await fs.readFile(statusPath, 'utf8'), status);
  await fs.rm(root, { recursive: true, force: true });
});

test('production helper rejects a staging path that escapes through an ancestor symlink', async () => {
  const root = await temporaryDirectory('lucifold-production-helper-staging-boundary-');
  const { plan, planPath } = await createProductionPlan(root, 'fail');
  const escapedStagingRoot = path.join(root, 'lucifold-update-escape');
  await fs.symlink(path.resolve('.'), escapedStagingRoot, 'dir');
  plan.stagingRoot = escapedStagingRoot;
  plan.stagedAppPath = path.join(escapedStagingRoot, 'staged', 'lucifold.app');
  await fs.writeFile(planPath, JSON.stringify(plan));
  await assert.rejects(runUpdateHelper(planPath), /canonical boundary|untrusted symlink/i);
  assert.equal(await fs.readFile(path.join(plan.targetAppPath, 'marker.txt'), 'utf8'), 'known-good');
  await fs.rm(root, { recursive: true, force: true });
});

test('forced helper termination leaves a recoverable pending transaction and startup recovery restores it', async () => {
  const root = await temporaryDirectory('lucifold-production-helper-interrupted-');
  const { plan, planPath } = await createProductionPlan(root, 'sleep');
  await fs.writeFile(planPath, JSON.stringify(plan));
  const code = 'import { runUpdateHelper } from "./src/main/services/update-helper.ts"; await runUpdateHelper(process.argv.at(-1));';
  const child = spawn(process.execPath, ['--import', 'tsx/esm', '--input-type=module', '-e', code, planPath], { cwd: path.resolve('.'), stdio: 'ignore' });
  const childExit = once(child, 'exit');
  let childExited = false;
  try {
    let recoverable = false;
    for (let attempt = 0; attempt < 150; attempt += 1) {
      const status = await readUpdateStatus(plan.statusPath);
      const backupIdentity = await applicationIdentity(plan.backupPath).catch(() => undefined);
      const targetIdentity = await applicationIdentity(plan.targetAppPath).catch(() => undefined);
      if (status?.state === 'pending' && backupIdentity === plan.knownGoodApplicationIdentity && targetIdentity === plan.expectedAppIdentity) {
        recoverable = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(recoverable, true);
    child.kill('SIGKILL');
    await childExit;
    childExited = true;
    await recoverInterruptedUpdate(plan.userDataPath, plan.targetAppPath, '1.0.0');
    assert.equal(await fs.readFile(path.join(plan.targetAppPath, 'marker.txt'), 'utf8'), 'known-good');
    assert.equal((await readUpdateStatus(plan.statusPath))?.state, 'rolled-back');
    assert.equal(await applicationIdentity(plan.targetAppPath), plan.knownGoodApplicationIdentity);
    await assert.rejects(fs.access(plan.lockPath));
  } finally {
    if (!childExited) {
      child.kill('SIGKILL');
      await childExit;
    }
    await fs.rm(root, { recursive: true, force: true });
  }
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
