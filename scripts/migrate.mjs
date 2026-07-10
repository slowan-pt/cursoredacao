// node scripts/migrate.mjs
// Executa a migration SQL no Supabase via conexão direta PostgreSQL.

import pg from 'pg'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const { Client } = pg
const __dirname = path.dirname(fileURLToPath(import.meta.url))

// URL-encode caracteres especiais da senha: [ → %5B, ] → %5D, @ → %40
const DB_URL = null // não usado diretamente

async function migrate() {
  console.log('📦 Executando migration no Supabase...')

  const configs = [
    {
      host: 'aws-0-sa-east-1.pooler.supabase.com',
      port: 5432,
      database: 'postgres',
      user: 'postgres.qizhulhyodpxoowxmqct',
      password: '[MinhaS3nha@2024]',
      ssl: { rejectUnauthorized: false }
    },
    {
      host: 'db.qizhulhyodpxoowxmqct.supabase.co',
      port: 5432,
      database: 'postgres',
      user: 'postgres',
      password: '[MinhaS3nha@2024]',
      ssl: { rejectUnauthorized: false }
    }
  ]

  let client = null
  let lastErr = null
  for (const config of configs) {
    const attempt = new Client(config)
    try {
      await attempt.connect()
      client = attempt
      console.log(`✅ Conectado ao banco de dados via ${config.host}`)
      break
    } catch (err) {
      lastErr = err
      console.log(`⚠ Falha ao conectar via ${config.host}: ${err.message}`)
      await attempt.end().catch(() => {})
    }
  }
  if (!client) throw lastErr

  try {
    const migrationsDir = path.join(__dirname, '..', 'migrations')
    const files = fs.readdirSync(migrationsDir)
      .filter((file) => file.endsWith('.sql'))
      .sort()

    for (const file of files) {
      console.log(`\n▶ ${file}`)
      const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf8')

      // Executa cada statement separado por ";"
      const statements = sql
        .split(';')
        .map(s => s.trim())
        .filter(s => s.length > 0 && !s.startsWith('--'))

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

migrate()
