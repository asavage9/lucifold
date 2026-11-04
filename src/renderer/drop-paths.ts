export function resolveDroppedFilePaths(files: readonly File[], resolvePath: (file: File) => string | null): { paths: string[]; unresolved: number } {
  const paths: string[] = [];
  let unresolved = 0;
  for (const file of files) {
    try {
      const filePath = resolvePath(file);
      if (filePath) paths.push(filePath);
      else unresolved += 1;
    } catch {
      unresolved += 1;
    }
  }
  return { paths, unresolved };
}
