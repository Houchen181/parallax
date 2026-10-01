// Builds plugins/parallax/server/parallax-mcp.cjs and the license notices of
// the packages bundled into it. Both are committed: plugin marketplaces install
// straight from this repository, without a build.
import { build } from 'esbuild'
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { PLUGIN_BUNDLE, pluginBuildOptions } from './plugin-options.mjs'

const result = await build({ ...pluginBuildOptions, metafile: true })

// Every package with code in the bundle, found from the bundled file paths.
const packages = new Map()
for (const input of Object.keys(result.metafile.inputs)) {
  const parts = input.split(/[\\/]/)
  const at = parts.lastIndexOf('node_modules')
  if (at < 0) continue
  const length = parts[at + 1].startsWith('@') ? 2 : 1
  const dir = parts.slice(0, at + 1 + length).join('/')
  if (packages.has(dir)) continue
  const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
  const licenseFile = readdirSync(dir).sort().find((name) => /^(licen[cs]e|copying)(\.|$)/i.test(name))
  packages.set(dir, {
    name: pkg.name,
    version: pkg.version,
    license: typeof pkg.license === 'string' ? pkg.license : (pkg.license?.type ?? 'see text'),
    text: licenseFile ? readFileSync(join(dir, licenseFile), 'utf8').trim() : `No license file; package.json says: ${pkg.license ?? 'unknown'}`,
  })
}

const rule = '='.repeat(72)
const notices = [...packages.values()]
  .sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version))
  .map((p) => `${rule}\n${p.name} ${p.version} (${p.license})\n${rule}\n\n${p.text.replace(/\r\n/g, '\n')}\n`)
const noticesFile = join(dirname(PLUGIN_BUNDLE), 'THIRD_PARTY_LICENSES.txt')
writeFileSync(noticesFile, `parallax-mcp.cjs contains code from these packages:\n\n${notices.join('\n')}`)

if (!existsSync(PLUGIN_BUNDLE)) throw new Error('The bundle was not written')
console.log(`Built ${PLUGIN_BUNDLE} (${Math.round(statSync(PLUGIN_BUNDLE).size / 1024)} KB, ${packages.size} packages listed in ${noticesFile})`)
