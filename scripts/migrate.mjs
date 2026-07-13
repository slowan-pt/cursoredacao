// node scripts/migrate.mjs
// Executa a migration SQL no Supabase via conexão direta PostgreSQL.

import pg from 'pg'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const { Client } = pg
const __dirname = path.dirname(fileURLToPath(import.meta.url))

function splitSqlStatements(sql) {
  const withoutLineComments = sql
    .split(/\r?\n/)
    .map((line) => line.trimStart().startsWith('--') ? '' : line)
    .join('\n')

  return withoutLineComments
    .split(';')
    .map((statement) => statement.trim())
    .filter(Boolean)
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
