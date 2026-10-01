// Shared esbuild settings for the Node-side bundles: the Electron main and
// preload scripts, and the local web server (`npm run serve`). Each is bundled
// to a single CommonJS file: a sandboxed preload cannot load other local
// modules, and bundling keeps node_modules out of the installer.
export const electronBuildOptions = {
  entryPoints: {
    'main/index': 'src/main/index.ts',
    'preload/index': 'src/preload/index.ts',
    'server/cli': 'src/server/cli.ts',
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
