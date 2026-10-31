import { promises as fs } from 'node:fs';
import path from 'node:path';

export class JsonStore<T extends object> {
  private readonly filePath: string;
  private readonly fallback: T;

  constructor(directory: string, filename: string, fallback: T) {
    this.filePath = path.join(directory, filename);
    this.fallback = fallback;
  }

  async read(): Promise<T> {
    try {
      const raw = await fs.readFile(this.filePath, 'utf8');
      return { ...this.fallback, ...JSON.parse(raw) } as T;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        console.warn(`lucifold could not read ${this.filePath}`, error);
      }
      return { ...this.fallback };
    }
  }

  async write(value: T): Promise<void> {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    const temporaryPath = `${this.filePath}.${process.pid}.tmp`;
    await fs.writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    await fs.rename(temporaryPath, this.filePath);
  }
}
