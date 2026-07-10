// node scripts/setup.mjs
// Cria tabelas, site padrão e os 3 usuários iniciais no Supabase.

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

const SUPABASE_URL = process.env.SUPABASE_URL
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  throw new Error('SUPABASE_URL e SUPABASE_SERVICE_KEY são obrigatórios')
}

const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false }
})

async function main() {
  console.log('🚀 Configurando CursosRedação...\n')

  // 1. Criar site padrão
  const { data: site, error: siteErr } = await sb.from('sites')
    .upsert({ slug: 'default', nome_prof: 'Prof. Sloann Nascimento', ativo: true }, { onConflict: 'slug' })
    .select().single()

  if (siteErr) { console.error('❌ Erro ao criar site:', siteErr.message); process.exit(1) }
  console.log('✅ Site padrão:', site.id)

  const { data: puppinSite, error: puppinErr } = await sb.from('sites')
    .upsert({
      slug: 'puppin-teste',
      nome_prof: 'Puppin Teste',
      bio_prof: 'Site de teste para validar turmas, alunos pendentes, cadastro SSO e a area independente do professor.',
      cor_primaria: '#173B2F',
      cor_accent: '#C5F135',
      ativo: true
    }, { onConflict: 'slug' })
    .select()
    .single()

  if (puppinErr) { console.error('❌ Erro ao criar puppin-teste:', puppinErr.message); process.exit(1) }
  console.log('✅ Site puppin-teste:', puppinSite.id)

  const turmas = [
    { site_id: puppinSite.id, nome: 'Turma Puppin Redação', concurso: 'Concursos militares', descricao: 'Treino guiado, temas semanais e correção individual.', status: 'ABERTA', preco: 197 },
    { site_id: puppinSite.id, nome: 'Puppin Intensivo', concurso: 'Bancas civis', descricao: 'Plano curto para revisar estrutura, repertório e argumentação.', status: 'ABERTA', preco: 247 }
  ]

  for (const turma of turmas) {
    const { data: existing } = await sb.from('turmas')
      .select('id')
      .eq('site_id', turma.site_id)
      .eq('nome', turma.nome)
      .maybeSingle()

    const op = existing
      ? sb.from('turmas').update(turma).eq('id', existing.id)
      : sb.from('turmas').insert(turma)

    const { error } = await op
    if (error) console.log(`⚠️  Turma ${turma.nome}: ${error.message}`)
  }

  // 2. Usuários iniciais
  const users = [
    {
      email: 'sloan.nascimento@gmail.com',
      password: '123456',
      nome: 'Sloann Nascimento',
      role: 'SUPERADMIN',
      site_id: null
    },
    {
      email: 'slowgithub@gmail.com',
      password: 'Prof@cursoreducao123',
      nome: 'Professor',
      role: 'CORRETOR',
      site_id: site.id
    },
    {
      email: 'testeplataformas8@gmail.com',
      password: 'Aluno@cursoreducao123',
      nome: 'Aluno Teste',
      role: 'ALUNO',
      site_id: site.id
    }
  ]

  for (const u of users) {
    const { data, error } = await sb.auth.admin.createUser({
      email: u.email,
      password: u.password,
      user_metadata: { nome: u.nome, role: u.role },
      email_confirm: true
    })

    if (error) {
      if (error.message.includes('already been registered') || error.message.includes('already exists')) {
        console.log(`⚠️  Já existe: ${u.email} — atualizando perfil...`)
        // Busca o usuário existente e atualiza
        const { data: list } = await sb.auth.admin.listUsers()
        const existing = list?.users?.find(x => x.email === u.email)
        if (existing) {
          await sb.from('profiles')
            .update({ nome: u.nome, role: u.role, site_id: u.site_id })
            .eq('id', existing.id)
          console.log(`   ✅ Perfil atualizado: ${u.email} (${u.role})`)
        }
      } else {
        console.error(`❌ Erro ${u.email}:`, error.message)
      }
    } else {
      await sb.from('profiles')
        .update({ nome: u.nome, role: u.role, site_id: u.site_id })
        .eq('id', data.user.id)
      console.log(`✅ Criado: ${u.email} (${u.role}) → senha: ${u.password}`)
    }
  }

  console.log('\n✅ Setup completo!')
  console.log('\n📋 Credenciais de acesso:')
  console.log('   Admin Geral  → sloan.nascimento@gmail.com  / 123456')
  console.log('   Professor    → slowgithub@gmail.com         / Prof@cursoreducao123')
  console.log('   Aluno        → testeplataformas8@gmail.com  / Aluno@cursoreducao123')
}

main().catch(console.error)
