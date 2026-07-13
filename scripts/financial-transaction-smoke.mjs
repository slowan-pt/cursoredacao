// Smoke controlado do módulo financeiro transacional.
// Cria dados fictícios marcados como FIN_SMOKE_* e não apaga registros.

import pg from 'pg'

const { Client } = pg

const dbUrl = process.env.SUPABASE_DB_URL
if (!dbUrl) throw new Error('SUPABASE_DB_URL é obrigatória para o smoke financeiro.')

const client = new Client({
  connectionString: dbUrl,
  ssl: { rejectUnauthorized: false }
})

const runId = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)
const prefix = `FIN_SMOKE_${runId}`

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

async function one(sql, params = []) {
  const { rows } = await client.query(sql, params)
  return rows[0] || null
}

async function mustFail(label, fn) {
  try {
    await fn()
  } catch (error) {
    return { label, ok: true, message: String(error.message || '').slice(0, 120) }
  }
  throw new Error(`${label}: deveria falhar, mas passou.`)
}

async function selectScenario() {
  const site = await one("select id, slug from public.sites where slug = 'puppin-teste' and ativo is true")
  assert(site, 'Site puppin-teste ativo não encontrado.')

  const teachers = await client.query(`
    select id, nome
    from public.profiles
    where site_id = $1 and role in ('ADMIN', 'CORRETOR') and ativo is true
    order by created_at asc
    limit 2
  `, [site.id])
  assert(teachers.rows.length >= 2, 'Cenário precisa de professor pai e professor filho ativos.')

  const student = await one(`
    select id, nome
    from public.profiles
    where site_id = $1 and role = 'ALUNO' and ativo is true
    order by created_at asc
    limit 1
  `, [site.id])
  assert(student, 'Cenário precisa de aluno ativo.')

  const turma = await one(`
    select id, nome
    from public.turmas
    where site_id = $1 and status = 'ABERTA'
    order by created_at desc
    limit 1
  `, [site.id])
  assert(turma, 'Cenário precisa de turma aberta.')

  const otherTeacher = await one(`
    select p.id, p.site_id
    from public.profiles p
    where p.site_id <> $1 and p.role in ('ADMIN', 'CORRETOR') and p.ativo is true
    order by p.created_at asc
    limit 1
  `, [site.id])

  return {
    site,
    parent: teachers.rows[0],
    child: teachers.rows[1],
    student,
    turma,
    otherTeacher
  }
}

async function createEntry(scenario, suffix, amountCents) {
  const correction = await one(`
    insert into public.correcoes (
      site_id, turma_id, aluno_id, prof_id, titulo, arquivo_url, tipo_arq, status, nota, finalizada_em, updated_at
    ) values (
      $1, $2, $3, $4, $5, '', 'PDF', 'FINALIZADA', 9.5, now(), now()
    )
    returning id, titulo
  `, [
    scenario.site.id,
    scenario.turma.id,
    scenario.student.id,
    scenario.child.id,
    `${prefix}_${suffix}`
  ])

  const entry = await one(`
    insert into public.correction_compensation_entries (
      site_id, correction_id, child_professor_id, parent_professor_id, aluno_id, turma_id,
      correction_type, status, amount_cents, currency, corrected_at, rule_snapshot_json, metadata,
      created_by, updated_by
    ) values (
      $1, $2, $3, $4, $5, $6,
      'CORRECAO', 'AWAITING_CLOSING', $7, 'BRL', now(),
      '{"source":"FINANCIAL_SMOKE"}'::jsonb, $8::jsonb, $4, $4
    )
    returning id, amount_cents, status
  `, [
    scenario.site.id,
    correction.id,
    scenario.child.id,
    scenario.parent.id,
    scenario.student.id,
    scenario.turma.id,
    amountCents,
    JSON.stringify({ smoke: true, run_id: runId, suffix })
  ])

  return { correction, entry }
}

async function rpc(name, args) {
  return rpcWith(client, name, args)
}

async function rpcWith(db, name, args) {
  const keys = Object.keys(args)
  const placeholders = keys.map((key, index) => `${key} => $${index + 1}`).join(', ')
  const { rows } = await db.query(`select public.${name}(${placeholders}) as result`, keys.map((key) => args[key]))
  return rows[0] || null
}

async function concurrentCreateRace(scenario) {
  const race = await createEntry(scenario, 'RACE', 800)
  const dbA = new Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } })
  const dbB = new Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } })
  await Promise.all([dbA.connect(), dbB.connect()])
  try {
    const args = {
      p_site_id: scenario.site.id,
      p_parent_professor_id: scenario.parent.id,
      p_child_professor_id: scenario.child.id,
      p_entry_ids: [race.entry.id],
      p_period_start: null,
      p_period_end: null,
      p_notes: 'Corrida smoke',
      p_idempotency_key: ''
    }
    const attempts = await Promise.allSettled([
      rpcWith(dbA, 'create_teacher_closing', { ...args, p_idempotency_key: `${prefix}:race:a` }),
      rpcWith(dbB, 'create_teacher_closing', { ...args, p_idempotency_key: `${prefix}:race:b` })
    ])
    const okCount = attempts.filter((item) => item.status === 'fulfilled').length
    const failCount = attempts.filter((item) => item.status === 'rejected').length
    assert(okCount === 1 && failCount === 1, 'Corrida de fechamento deveria ter exatamente um sucesso e uma falha.')
    return { test: 'concurrent_create_same_entry', ok: true }
  } finally {
    await Promise.all([dbA.end(), dbB.end()])
  }
}

async function main() {
  await client.connect()
  const scenario = await selectScenario()
  const results = []

  const primary = await createEntry(scenario, 'PRIMARY', 1000)
  const createKey = `${prefix}:create:primary`
  const created = await rpc('create_teacher_closing', {
    p_site_id: scenario.site.id,
    p_parent_professor_id: scenario.parent.id,
    p_child_professor_id: scenario.child.id,
    p_entry_ids: [primary.entry.id],
    p_period_start: null,
    p_period_end: null,
    p_notes: 'Smoke financeiro transacional',
    p_idempotency_key: createKey
  })
  assert(created.result.status === 'DRAFT', 'Fechamento inicial não ficou DRAFT.')
  assert(created.result.final_amount_cents === 1000, 'Total inicial incorreto.')

  const createdAgain = await rpc('create_teacher_closing', {
    p_site_id: scenario.site.id,
    p_parent_professor_id: scenario.parent.id,
    p_child_professor_id: scenario.child.id,
    p_entry_ids: [primary.entry.id],
    p_period_start: null,
    p_period_end: null,
    p_notes: 'Retry idempotente',
    p_idempotency_key: createKey
  })
  assert(createdAgain.result.closing_id === created.result.closing_id, 'Idempotência de fechamento não retornou o mesmo fechamento.')
  results.push({ test: 'idempotent_closing_retry', ok: true })

  results.push(await mustFail('duplicate_entry_different_key', () => rpc('create_teacher_closing', {
    p_site_id: scenario.site.id,
    p_parent_professor_id: scenario.parent.id,
    p_child_professor_id: scenario.child.id,
    p_entry_ids: [primary.entry.id],
    p_period_start: null,
    p_period_end: null,
    p_notes: 'Duplicado',
    p_idempotency_key: `${prefix}:create:duplicate`
  })))

  if (scenario.otherTeacher) {
    const cross = await createEntry(scenario, 'CROSS_SITE_DENIED', 300)
    results.push(await mustFail('cross_site_parent_denied', () => rpc('create_teacher_closing', {
      p_site_id: scenario.site.id,
      p_parent_professor_id: scenario.otherTeacher.id,
      p_child_professor_id: scenario.child.id,
      p_entry_ids: [cross.entry.id],
      p_period_start: null,
      p_period_end: null,
      p_notes: 'Cross-site',
      p_idempotency_key: `${prefix}:create:cross`
    })))
  }

  const approved = await rpc('approve_teacher_closing', {
    p_site_id: scenario.site.id,
    p_parent_professor_id: scenario.parent.id,
    p_closing_id: created.result.closing_id,
    p_idempotency_key: `${prefix}:approve:primary`
  })
  assert(approved.result.status === 'APPROVED', 'Fechamento não foi aprovado.')

  const partial = await rpc('register_teacher_payout', {
    p_site_id: scenario.site.id,
    p_parent_professor_id: scenario.parent.id,
    p_closing_id: created.result.closing_id,
    p_amount_cents: 400,
    p_payment_method: 'SMOKE',
    p_reference: `${prefix}-PARTIAL`,
    p_notes: 'Pagamento parcial fictício',
    p_paid_at: null,
    p_idempotency_key: `${prefix}:payout:partial`
  })
  assert(partial.result.closing_status === 'PARTIALLY_PAID', 'Pagamento parcial não deixou status PARTIALLY_PAID.')
  assert(partial.result.remaining_amount_cents === 600, 'Saldo parcial incorreto.')

  const partialAgain = await rpc('register_teacher_payout', {
    p_site_id: scenario.site.id,
    p_parent_professor_id: scenario.parent.id,
    p_closing_id: created.result.closing_id,
    p_amount_cents: 400,
    p_payment_method: 'SMOKE',
    p_reference: `${prefix}-PARTIAL-RETRY`,
    p_notes: 'Retry fictício',
    p_paid_at: null,
    p_idempotency_key: `${prefix}:payout:partial`
  })
  assert(partialAgain.result.payout_id === partial.result.payout_id, 'Idempotência de pagamento parcial falhou.')
  results.push({ test: 'idempotent_partial_payout_retry', ok: true })

  const payoutCount = await one(`
    select count(*)::int as count
    from public.teacher_payouts
    where closing_id = $1 and reference like $2
  `, [created.result.closing_id, `${prefix}%`])
  assert(payoutCount.count === 1, 'Retry de pagamento parcial duplicou payout.')

  results.push(await mustFail('partial_overpay_denied', () => rpc('register_teacher_payout', {
    p_site_id: scenario.site.id,
    p_parent_professor_id: scenario.parent.id,
    p_closing_id: created.result.closing_id,
    p_amount_cents: 601,
    p_payment_method: 'SMOKE',
    p_reference: `${prefix}-PARTIAL-OVERPAY`,
    p_notes: 'Acima do saldo parcial',
    p_paid_at: null,
    p_idempotency_key: `${prefix}:payout:partial-overpay`
  })))

  const final = await rpc('register_teacher_payout', {
    p_site_id: scenario.site.id,
    p_parent_professor_id: scenario.parent.id,
    p_closing_id: created.result.closing_id,
    p_amount_cents: 600,
    p_payment_method: 'SMOKE',
    p_reference: `${prefix}-FINAL`,
    p_notes: 'Pagamento final fictício',
    p_paid_at: null,
    p_idempotency_key: `${prefix}:payout:final`
  })
  assert(final.result.closing_status === 'PAID', 'Pagamento total não deixou status PAID.')
  assert(final.result.remaining_amount_cents === 0, 'Saldo final não zerou.')
  results.push({ test: 'partial_and_total_payout', ok: true })

  results.push(await concurrentCreateRace(scenario))

  results.push(await mustFail('overpay_denied', () => rpc('register_teacher_payout', {
    p_site_id: scenario.site.id,
    p_parent_professor_id: scenario.parent.id,
    p_closing_id: created.result.closing_id,
    p_amount_cents: 1,
    p_payment_method: 'SMOKE',
    p_reference: `${prefix}-OVERPAY`,
    p_notes: 'Acima do saldo',
    p_paid_at: null,
    p_idempotency_key: `${prefix}:payout:overpay`
  })))

  const cancelFlow = await createEntry(scenario, 'CANCEL', 500)
  const cancelClosing = await rpc('create_teacher_closing', {
    p_site_id: scenario.site.id,
    p_parent_professor_id: scenario.parent.id,
    p_child_professor_id: scenario.child.id,
    p_entry_ids: [cancelFlow.entry.id],
    p_period_start: null,
    p_period_end: null,
    p_notes: 'Cancelamento smoke',
    p_idempotency_key: `${prefix}:create:cancel`
  })
  const canceled = await rpc('cancel_teacher_closing', {
    p_site_id: scenario.site.id,
    p_parent_professor_id: scenario.parent.id,
    p_closing_id: cancelClosing.result.closing_id,
    p_reason: 'Smoke de cancelamento',
    p_idempotency_key: `${prefix}:cancel`
  })
  assert(canceled.result.status === 'CANCELED', 'Cancelamento não retornou CANCELED.')
  const released = await one('select status, closing_id from public.correction_compensation_entries where id = $1', [cancelFlow.entry.id])
  assert(released.status === 'AWAITING_CLOSING' && released.closing_id === null, 'Cancelamento não liberou lançamento.')
  results.push({ test: 'cancel_releases_entry', ok: true })

  const reverseFlow = await createEntry(scenario, 'REVERSE', 700)
  const reverseClosing = await rpc('create_teacher_closing', {
    p_site_id: scenario.site.id,
    p_parent_professor_id: scenario.parent.id,
    p_child_professor_id: scenario.child.id,
    p_entry_ids: [reverseFlow.entry.id],
    p_period_start: null,
    p_period_end: null,
    p_notes: 'Estorno smoke',
    p_idempotency_key: `${prefix}:create:reverse`
  })
  await rpc('approve_teacher_closing', {
    p_site_id: scenario.site.id,
    p_parent_professor_id: scenario.parent.id,
    p_closing_id: reverseClosing.result.closing_id,
    p_idempotency_key: `${prefix}:approve:reverse`
  })
  const reversePaid = await rpc('register_teacher_payout', {
    p_site_id: scenario.site.id,
    p_parent_professor_id: scenario.parent.id,
    p_closing_id: reverseClosing.result.closing_id,
    p_amount_cents: 700,
    p_payment_method: 'SMOKE',
    p_reference: `${prefix}-REVERSE`,
    p_notes: 'Pagamento a estornar',
    p_paid_at: null,
    p_idempotency_key: `${prefix}:payout:reverse`
  })
  const reversed = await rpc('reverse_teacher_payout', {
    p_site_id: scenario.site.id,
    p_parent_professor_id: scenario.parent.id,
    p_payout_id: reversePaid.result.payout_id,
    p_reason: 'Smoke de estorno',
    p_idempotency_key: `${prefix}:reverse`
  })
  assert(reversed.result.closing_status === 'APPROVED', 'Estorno não voltou fechamento para APPROVED.')
  results.push({ test: 'reverse_payout', ok: true })

  const audit = await one(`
    select count(*)::int as count
    from public.financial_audit_logs
    where site_id = $1
      and created_at >= now() - interval '10 minutes'
      and metadata::text like $2
  `, [scenario.site.id, `%${prefix}%`])
  assert(audit.count >= 1, 'Auditoria idempotente não foi encontrada.')

  const finalStates = await one(`
    select
      count(*) filter (where status = 'PAID')::int as paid_entries,
      count(*) filter (where status = 'AWAITING_CLOSING' and metadata->>'run_id' = $1)::int as released_entries
    from public.correction_compensation_entries
    where metadata->>'run_id' = $1
  `, [runId])

  console.log(JSON.stringify({
    ok: true,
    run_id: runId,
    site: scenario.site.slug,
    tests: results,
    final_states: finalStates,
    notes: [
      'Dados fictícios mantidos para auditoria.',
      'Nenhum pagamento real ou Asaas produção foi usado.',
      'Notificações via backend não são emitidas por este smoke direto de RPC.'
    ]
  }, null, 2))
}

try {
  await main()
} finally {
  await client.end()
}
