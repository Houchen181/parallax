// Shared esbuild settings for the Electron main and preload bundles.
// Both are bundled to single CommonJS files: a sandboxed preload cannot load
// other local modules, and bundling keeps node_modules out of the installer.
export const electronBuildOptions = {
  entryPoints: {
    'main/index': 'src/main/index.ts',
    'preload/index': 'src/preload/index.ts',
  },
  outdir: 'dist',
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  external: ['electron'],
  sourcemap: true,
  logLevel: 'info',
}
