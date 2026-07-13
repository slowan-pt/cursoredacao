import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'

const root = process.cwd()

function rg(pattern, globs) {
  try {
    const args = ['--files-with-matches', '--hidden', '--glob', '!node_modules/**', '--glob', '!.git/**', '--glob', '!.wrangler/**']
    for (const glob of globs) args.push('--glob', glob)
    args.push(pattern)
    return execFileSync('rg', args, { cwd: root, encoding: 'utf8' })
      .split(/\r?\n/)
      .filter(Boolean)
  } catch (error) {
    if (error.status === 1) return []
    throw error
  }
}

const failures = []

for (const file of rg('TODO|FIXME|HACK|XXX|debugger|@ts-ignore', ['src/**', 'public/**', 'scripts/**'])) {
  failures.push(`Marcador temporario encontrado em ${file}`)
}

for (const file of rg('console\\.log\\(', ['src/**', 'public/**'])) {
  failures.push(`console.log em codigo servido ao usuario: ${file}`)
}

for (const file of rg('document\\.write\\(', ['src/**', 'public/**'])) {
  const content = readFileSync(join(root, file), 'utf8')
  const allowed = file === 'src/routes/site.ts' && content.includes('function renderAssetLoader(assetPath: string)')
  if (!allowed) failures.push(`document.write fora do loader controlado: ${file}`)
}

if (rg('listUsers\\(', ['scripts/**']).length) {
  failures.push('Script local usando auth.admin.listUsers encontrado em scripts/.')
}

if (failures.length) {
  console.error('Auditoria estatica encontrou pendencias:')
  for (const failure of failures) console.error(`- ${failure}`)
  process.exit(1)
}

console.log('Auditoria estatica validada.')
