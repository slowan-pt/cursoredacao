// Verificacao local de segredos. Nao imprime valores encontrados.
// Uso: node scripts/scan-secrets.mjs

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

const ROOT = process.cwd()
const IGNORED_DIRS = new Set([
  '.git',
  'node_modules',
  'dist',
  'backups',
  '.wrangler'
])

const IGNORED_FILES = new Set([
  '.dev.vars',
  '.env'
])

const PATTERNS = [
  { name: 'postgres_connection_string', regex: /postgres(?:ql)?:\/\/[^\s"'<>]+/i },
  { name: 'jwt_like_token', regex: /eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}/ },
  { name: 'resend_or_generic_secret_key', regex: /\b(?:re_|sk_)[A-Za-z0-9_-]{20,}\b/ },
  { name: 'asaas_like_key', regex: /\bASAA[A-Za-z0-9_-]{16,}\b/i },
  { name: 'inline_supabase_service_key_value', regex: /SUPABASE_SERVICE_KEY\s*=\s*(?!process\.env\b)[^"'`\s#]+/ },
  { name: 'inline_supabase_db_url_value', regex: /SUPABASE_DB_URL\s*=\s*postgres(?:ql)?:\/\/[^\s"'<>]+/i },
  { name: 'hardcoded_seed_password_123456', regex: /password\s*:\s*['"]123456['"]/i }
]

function walk(dir, files = []) {
  for (const entry of readdirSync(dir)) {
    if (IGNORED_DIRS.has(entry)) continue
    const full = join(dir, entry)
    const rel = relative(ROOT, full)
    if (IGNORED_FILES.has(rel)) continue
    if (/^\.env(\.|$)/.test(rel)) continue
    const stat = statSync(full)
    if (stat.isDirectory()) walk(full, files)
    else if (stat.isFile()) files.push(full)
  }
  return files
}

function isProbablyText(buffer) {
  if (!buffer.length) return true
  const sample = buffer.subarray(0, Math.min(buffer.length, 4096))
  return !sample.includes(0)
}

const findings = []

for (const file of walk(ROOT)) {
  const buffer = readFileSync(file)
  if (!isProbablyText(buffer)) continue
  const rel = relative(ROOT, file)
  const lines = buffer.toString('utf8').split(/\r?\n/)
  lines.forEach((line, index) => {
    for (const pattern of PATTERNS) {
      if (pattern.regex.test(line)) {
        findings.push({ file: rel, line: index + 1, pattern: pattern.name })
      }
    }
  })
}

if (findings.length) {
  console.error('Possiveis segredos encontrados. Valores omitidos:')
  for (const item of findings) {
    console.error(`- ${item.file}:${item.line} [${item.pattern}]`)
  }
  process.exit(1)
}

console.log('Nenhum padrao de segredo encontrado na working tree rastreavel.')
