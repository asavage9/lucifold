import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const root = process.cwd();
const source = path.join(root, 'src', 'native', 'lucifold-export-publisher.c');
const outputDirectory = path.join(root, 'dist', 'native');
const output = path.join(outputDirectory, 'lucifold-export-publisher');

if (process.platform !== 'darwin') throw new Error('The lucifold export publisher currently targets macOS only.');
await fs.mkdir(outputDirectory, { recursive: true });
await execFileAsync('/usr/bin/clang', ['-O2', '-Wall', '-Wextra', '-std=c11', '-o', output, source]);
await fs.chmod(output, 0o755);
