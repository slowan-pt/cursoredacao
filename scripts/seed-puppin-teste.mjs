import { createClient } from '@supabase/supabase-js'
import { readFileSync } from 'node:fs'

function loadDevVars() {
  try {
    const raw = readFileSync('.dev.vars', 'utf8')
    for (const line of raw.split(/\r?\n/)) {
      const match = line.match(/^([^=#]+)=(.*)$/)
      if (match && !process.env[match[1]]) process.env[match[1]] = match[2]
    }
  } catch {}
}

loadDevVars()

const { SUPABASE_URL, SUPABASE_SERVICE_KEY } = process.env
if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  throw new Error('SUPABASE_URL e SUPABASE_SERVICE_KEY são obrigatórios')
}

const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false }
})

async function findUserByEmail(email) {
  const { data, error } = await sb.auth.admin.listUsers()
  if (error) throw error
  return data.users.find((user) => user.email?.toLowerCase() === email.toLowerCase()) || null
}

async function ensureUser({ email, password, nome, role, site_id, ativo }) {
  const existing = await findUserByEmail(email)
  let user = existing

  if (!user) {
    const { data, error } = await sb.auth.admin.createUser({
      email,
      password,
      user_metadata: { nome, role },
      email_confirm: true
    })
    if (error) throw error
    user = data.user
  } else {
    const { data, error } = await sb.auth.admin.updateUserById(user.id, {
      password,
      user_metadata: { ...(user.user_metadata || {}), nome, role },
      email_confirm: true
    })
    if (error) throw error
    user = data.user
  }

  const { error: profileError } = await sb.from('profiles')
    .upsert({ id: user.id, nome, role, site_id, ativo }, { onConflict: 'id' })
  if (profileError) throw profileError

  return user
}

async function main() {
  const { data: site, error: siteError } = await sb.from('sites')
    .upsert({
      slug: 'puppin-teste',
      nome_prof: 'Puppin Teste',
      bio_prof: 'Site de teste para validar professores, alunos pagos, alunos pendentes, turmas e correções em ambiente independente.',
      cor_primaria: '#173B2F',
      cor_accent: '#C5F135',
      ativo: true
    }, { onConflict: 'slug' })
    .select()
    .single()
  if (siteError) throw siteError

  const turmaBody = {
    site_id: site.id,
    nome: 'Turma Puppin Teste',
    concurso: 'Redação',
    descricao: 'Turma inicial para testar matrícula automática, envio e correção de redações.',
    status: 'ABERTA',
    preco: 197
  }

  const { data: existingTurma, error: existingTurmaError } = await sb.from('turmas')
    .select('*')
    .eq('site_id', site.id)
    .eq('nome', turmaBody.nome)
    .maybeSingle()
  if (existingTurmaError) throw existingTurmaError

  const { data: turma, error: turmaError } = existingTurma
    ? await sb.from('turmas')
      .update(turmaBody)
      .eq('id', existingTurma.id)
      .select()
      .single()
    : await sb.from('turmas')
      .insert(turmaBody)
      .select()
      .single()
  if (turmaError) throw turmaError

  await ensureUser({
    email: 'puppin@gmail.com',
    password: '123456',
    nome: 'Professor Puppin',
    role: 'CORRETOR',
    site_id: site.id,
    ativo: true
  })

  const paidStudents = [
    { email: 'aluno.puppin@gmail.com', nome: 'Aluno Puppin Pago 1' },
    { email: 'aluno2.puppin@gmail.com', nome: 'Aluno Puppin Pago 2' }
  ]

  for (const student of paidStudents) {
    const user = await ensureUser({
      ...student,
      password: '123456',
      role: 'ALUNO',
      site_id: site.id,
      ativo: true
    })
    const { error } = await sb.from('turma_alunos')
      .upsert({
        site_id: site.id,
        turma_id: turma.id,
        aluno_id: user.id,
        ativo: true,
        origem: 'PAGAMENTO'
      }, { onConflict: 'turma_id,aluno_id' })
    if (error) {
      console.log(`Aviso: matrícula por turma não gravada para ${student.email}: ${error.message}`)
    }
  }

  await ensureUser({
    email: 'aluno.pendente.puppin@gmail.com',
    password: '123456',
    nome: 'Aluno Puppin Pendente',
    role: 'ALUNO',
    site_id: site.id,
    ativo: false
  })

  console.log(JSON.stringify({
    site: `/redacao/${site.slug}`,
    professor: 'puppin@gmail.com',
    alunos_pagos: paidStudents.map((student) => student.email),
    aluno_pendente: 'aluno.pendente.puppin@gmail.com',
    senha: '123456'
  }, null, 2))
}

main().catch((error) => {
  console.error(error.message || error)
  process.exit(1)
})
