// node scripts/migrate.mjs
// Executa a migration SQL no Supabase via conexão direta PostgreSQL.

import pg from 'pg'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const { Client } = pg
const __dirname = path.dirname(fileURLToPath(import.meta.url))

function splitSqlStatements(sql) {
  const statements = []
  let current = ''
  let singleQuote = false
  let doubleQuote = false
  let lineComment = false
  let blockComment = false
  let dollarQuote = ''

  for (let i = 0; i < sql.length; i += 1) {
    const char = sql[i]
    const next = sql[i + 1] || ''

    if (lineComment) {
      current += char
      if (char === '\n') lineComment = false
      continue
    }

    if (blockComment) {
      current += char
      if (char === '*' && next === '/') {
        current += next
        i += 1
        blockComment = false
      }
      continue
    }

    if (dollarQuote) {
      current += char
      if (char === '$' && sql.slice(i, i + dollarQuote.length) === dollarQuote) {
        current += sql.slice(i + 1, i + dollarQuote.length)
        i += dollarQuote.length - 1
        dollarQuote = ''
      }
      continue
    }

    if (!singleQuote && !doubleQuote && char === '-' && next === '-') {
      current += char + next
      i += 1
      lineComment = true
      continue
    }

    if (!singleQuote && !doubleQuote && char === '/' && next === '*') {
      current += char + next
      i += 1
      blockComment = true
      continue
    }

    if (!singleQuote && !doubleQuote && char === '$') {
      const match = sql.slice(i).match(/^\$[A-Za-z_][A-Za-z0-9_]*\$|^\$\$/)
      if (match) {
        dollarQuote = match[0]
        current += dollarQuote
        i += dollarQuote.length - 1
        continue
      }
    }

    if (!doubleQuote && char === "'" && sql[i - 1] !== '\\') {
      singleQuote = !singleQuote
      current += char
      continue
    }

    if (!singleQuote && char === '"') {
      doubleQuote = !doubleQuote
      current += char
      continue
    }

    if (!singleQuote && !doubleQuote && char === ';') {
      const statement = current.trim()
      if (statement) statements.push(statement)
      current = ''
      continue
    }

    current += char
  }

  const tail = current.trim()
  if (tail) statements.push(tail)
  return statements
}

async function migrate() {
  console.log('📦 Executando migration no Supabase...')

  const dbUrl = process.env.SUPABASE_DB_URL
  if (!dbUrl) throw new Error('SUPABASE_DB_URL é obrigatória para executar migrations.')

  const client = new Client({
    connectionString: dbUrl,
    ssl: { rejectUnauthorized: false }
  })
  await client.connect()
  console.log('✅ Conectado ao banco de dados')

  try {
    const migrationsDir = path.join(__dirname, '..', 'migrations')
    const files = fs.readdirSync(migrationsDir)
      .filter((file) => file.endsWith('.sql'))
      .sort()

    for (const file of files) {
      console.log(`\n▶ ${file}`)
      const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf8')

      const statements = splitSqlStatements(sql)

      for (const stmt of statements) {
        try {
          await client.query(stmt)
          const preview = stmt.substring(0, 60).replace(/\n/g, ' ')
          console.log(`  ✓ ${preview}...`)
        } catch (err) {
          if (err.message.includes('already exists') || err.message.includes('does not exist')) {
            console.log(`  ⚠  Ignorado (já existe): ${stmt.substring(0,50)}...`)
          } else {
            console.error(`  ✗ Erro: ${err.message}`)
            console.error(`    Statement: ${stmt.substring(0,80)}`)
          }
        }
      }
    }

    console.log('\n✅ Migration concluída!')
  } catch (err) {
    console.error('❌ Erro de conexão:', err.message)
    process.exit(1)
  } finally {
    await client.end()
  }
}

migrate().catch((err) => {
  console.error(`❌ ${err.message || 'Erro ao executar migrations.'}`)
  process.exit(1)
})
