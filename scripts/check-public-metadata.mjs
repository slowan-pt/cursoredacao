import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const root = process.cwd()
const requiredFiles = [
  'public/robots.txt',
  'public/sitemap.xml',
  'public/site.webmanifest',
  'public/favicon.svg'
]

const requiredSnippets = new Map([
  ['public/robots.txt', ['Sitemap: https://redacaocomestrategia.com.br/sitemap.xml']],
  ['public/sitemap.xml', ['https://redacaocomestrategia.com.br/']],
  ['public/site.webmanifest', ['Redacao com Estrategia']],
  ['public/index.html', ['rel="canonical"', 'og:url', 'site.webmanifest', 'favicon.svg']],
  ['public/login.html', ['rel="canonical"', 'site.webmanifest', 'favicon.svg']],
  ['public/auth-callback.html', ['rel="canonical"', 'site.webmanifest', 'favicon.svg']]
])

const failures = []

for (const file of requiredFiles) {
  if (!existsSync(join(root, file))) failures.push(`Arquivo ausente: ${file}`)
}

for (const [file, snippets] of requiredSnippets) {
  const path = join(root, file)
  if (!existsSync(path)) {
    failures.push(`Arquivo ausente: ${file}`)
    continue
  }
  const content = readFileSync(path, 'utf8')
  for (const snippet of snippets) {
    if (!content.includes(snippet)) failures.push(`${file} nao contem: ${snippet}`)
  }
}

if (failures.length) {
  console.error('Falha nos metadados publicos:')
  for (const failure of failures) console.error(`- ${failure}`)
  process.exit(1)
}

console.log('Metadados publicos validados.')
