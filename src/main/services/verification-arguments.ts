import path from 'node:path';

export type UpdaterArguments =
  | { kind: 'none' }
  | { kind: 'helper'; planPath: string }
  | { kind: 'verification'; statusPath: string; version: string; identity: string; userDataPath?: string }
  | { kind: 'invalid'; message: string };

export function parseUpdaterArguments(argv: string[]): UpdaterArguments {
  const verify = argv.flatMap((value, index) => value === '--lucifold-update-verify' ? [index] : []);
  const helper = argv.flatMap((value, index) => value === '--lucifold-update-helper' ? [index] : []);
  const userData = argv.flatMap((value, index) => value === '--user-data-dir' ? [index] : []);
  if (verify.length > 1 || helper.length > 1 || userData.length > 1) return { kind: 'invalid', message: 'Updater arguments were duplicated.' };
  if (helper.length) {
    if (verify.length || userData.length) return { kind: 'invalid', message: 'Helper and verification arguments cannot be combined.' };
    const planPath = argv[helper[0] + 1];
    if (!planPath || planPath.startsWith('--') || !path.isAbsolute(planPath)) return { kind: 'invalid', message: 'The updater helper plan path is incomplete or unsafe.' };
    if (argv.slice(helper[0] + 2).length) return { kind: 'invalid', message: 'The updater helper arguments contain unexpected trailing values.' };
    return { kind: 'helper', planPath };
  }
  if (!verify.length && !userData.length) return { kind: 'none' };
  if (!verify.length) return { kind: 'invalid', message: 'A user-data override requires authenticated verification arguments.' };
  const index = verify[0];
  const statusPath = argv[index + 1];
  const version = argv[index + 2];
  const identity = argv[index + 3];
  if (!statusPath || !version || !identity || statusPath.startsWith('--') || version.startsWith('--') || identity.startsWith('--')) return { kind: 'invalid', message: 'The updater verification tuple is incomplete.' };
  if (!path.isAbsolute(statusPath) || !/^\d+\.\d+\.\d+$/.test(version) || !/^[0-9a-f]{64}$/i.test(identity)) return { kind: 'invalid', message: 'The updater verification tuple is malformed.' };
  if (userData.length && (!argv[userData[0] + 1] || argv[userData[0] + 1].startsWith('--') || !path.isAbsolute(argv[userData[0] + 1]))) return { kind: 'invalid', message: 'The updater user-data path is incomplete or unsafe.' };
  const firstUpdaterArgument = Math.min(index, userData.length ? userData[0] : index);
  const consumed = new Set([index, index + 1, index + 2, index + 3]);
  if (userData.length) consumed.add(userData[0]).add(userData[0] + 1);
  for (let cursor = firstUpdaterArgument; cursor < argv.length; cursor += 1) if (!consumed.has(cursor)) return { kind: 'invalid', message: 'The updater verification arguments contain unexpected trailing values.' };
  return userData.length ? { kind: 'verification', statusPath, version, identity, userDataPath: argv[userData[0] + 1] } : { kind: 'verification', statusPath, version, identity };
}
