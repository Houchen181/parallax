// Packs the Claude Desktop extension (release/Parallax-<version>.mcpb) from
// mcpb/manifest.json and the plugin's bundled server. Run `npm run pack:mcpb`.
import { execFileSync } from 'node:child_process'
import { cpSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'

const { version } = JSON.parse(readFileSync('package.json', 'utf8'))
const manifest = JSON.parse(readFileSync('mcpb/manifest.json', 'utf8'))
if (manifest.version !== version) throw new Error(`mcpb/manifest.json has version ${manifest.version}, package.json has ${version}`)

const stage = join('dist', 'mcpb')
rmSync(stage, { recursive: true, force: true })
mkdirSync(join(stage, 'server'), { recursive: true })
cpSync('mcpb/manifest.json', join(stage, 'manifest.json'))
cpSync('build/icon.png', join(stage, 'icon.png'))
cpSync('LICENSE', join(stage, 'LICENSE'))
cpSync('plugins/parallax/server', join(stage, 'server'), { recursive: true })

const output = join('release', `Parallax-${version}.mcpb`)
mkdirSync('release', { recursive: true })
const cli = join('node_modules', '@anthropic-ai', 'mcpb', 'dist', 'cli', 'cli.js')
execFileSync(process.execPath, [cli, 'validate', join(stage, 'manifest.json')], { stdio: 'inherit' })
execFileSync(process.execPath, [cli, 'pack', stage, output], { stdio: 'inherit' })
