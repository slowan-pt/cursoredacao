// Dry-run financeiro: lista correções finalizadas sem lançamento.
// Não cria, altera ou apaga dados.

import pg from 'pg'

const { Client } = pg

function requireDbUrl() {
  const dbUrl = process.env.SUPABASE_DB_URL
  if (!dbUrl) throw new Error('SUPABASE_DB_URL é obrigatória para o dry-run financeiro.')
  return dbUrl
}

function parseArgs() {
  const args = new Map()
  for (const arg of process.argv.slice(2)) {
    const [key, value] = arg.replace(/^--/, '').split('=')
    args.set(key, value || 'true')
  }
  return {
    since: args.get('since') || '1970-01-01',
    limit: Math.max(1, Math.min(1000, Number(args.get('limit') || 100)))
  }
}

const { since, limit } = parseArgs()
const client = new Client({
  connectionString: requireDbUrl(),
  ssl: { rejectUnauthorized: false }
})

await client.connect()
try {
  const result = await client.query(`
    SELECT
      c.id,
      c.site_id,
      s.slug AS site_slug,
      c.prof_id,
      p.nome AS professor_nome,
      c.turma_id,
      t.nome AS turma_nome,
      c.finalizada_em,
      e.id AS compensation_entry_id
    FROM public.correcoes c
    LEFT JOIN public.correction_compensation_entries e ON e.correction_id = c.id
    LEFT JOIN public.sites s ON s.id = c.site_id
    LEFT JOIN public.profiles p ON p.id = c.prof_id
    LEFT JOIN public.turmas t ON t.id = c.turma_id
    WHERE c.status = 'FINALIZADA'
      AND c.finalizada_em >= $1
      AND e.id IS NULL
    ORDER BY c.finalizada_em DESC
    LIMIT $2
  `, [since, limit])

  console.log(JSON.stringify({
    dry_run: true,
    since,
    limit,
    missing_compensation_entries: result.rowCount,
    rows: result.rows.map((row) => ({
      correction_id: row.id,
      site_id: row.site_id,
      site_slug: row.site_slug,
      professor_id: row.prof_id,
      professor_nome: row.professor_nome,
      turma_id: row.turma_id,
      turma_nome: row.turma_nome,
      finalizada_em: row.finalizada_em
    }))
  }, null, 2))
} finally {
  await client.end()
}
