import { defineConfig } from 'vite';

export default defineConfig({
  build: {
    lib: {
      entry: 'src/main/preload.ts',
      formats: ['cjs'],
      fileName: () => 'preload.cjs',
    },
    outDir: 'dist/main/main',
    emptyOutDir: false,
    rollupOptions: {
      external: ['electron'],
    },
  },
});
