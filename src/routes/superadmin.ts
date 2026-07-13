import { Hono } from 'hono'
import type { Env } from '../types'
import { getAdmin } from '../supabase'
import { requireAuth, requireRole } from '../middleware'

const app = new Hono<{ Bindings: Env }>()

function dbError() {
  return { error: 'Erro ao acessar os dados.' }
}

app.use('*', requireAuth, requireRole('SUPERADMIN'))

function slugifySiteName(value: string) {
  const slug = value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return slug || 'professor'
}

async function uniqueSiteSlug(sb: ReturnType<typeof getAdmin>, base: string) {
  let slug = slugifySiteName(base)
  let candidate = slug
  let suffix = 2
  while (true) {
    const { data } = await sb.from('sites').select('id').eq('slug', candidate).maybeSingle()
    if (!data) return candidate
    candidate = `${slug}-${suffix++}`
  }
}

app.get('/stats', async (c) => {
  const sb = getAdmin(c.env)
  const [sites, profiles] = await Promise.all([
    sb.from('sites').select('id', { count: 'exact', head: true }).eq('ativo', true),
    sb.from('profiles').select('id', { count: 'exact', head: true })
  ])
  return c.json({ sites: sites.count ?? 0, users: profiles.count ?? 0 })
})

app.get('/sites', async (c) => {
  const sb = getAdmin(c.env)
  const { data, error } = await sb.from('sites').select('*').order('created_at', { ascending: false })
  if (error) return c.json(dbError(), 500)
  return c.json({ data })
})

app.post('/sites', async (c) => {
  const body = await c.req.json()
  const sb = getAdmin(c.env)
  const { data, error } = await sb.from('sites').insert(body).select().single()
  if (error) return c.json(dbError(), 500)
  return c.json(data, 201)
})

app.patch('/sites/:id', async (c) => {
  const body = await c.req.json()
  const sb = getAdmin(c.env)
  const allowed = ['slug', 'nome_prof', 'bio_prof', 'cor_primaria', 'cor_accent', 'logo_url', 'foto_url', 'domain_custom', 'ativo']
  const update = Object.fromEntries(Object.entries(body).filter(([key]) => allowed.includes(key)))

  if (!Object.keys(update).length) return c.json({ error: 'Nada para atualizar' }, 400)

  const { data, error } = await sb.from('sites')
    .update(update)
    .eq('id', c.req.param('id'))
    .select()
    .single()

  if (error) return c.json(dbError(), 500)
  return c.json(data)
})

app.get('/users', async (c) => {
  const sb = getAdmin(c.env)
  const { data, error } = await sb
    .from('profiles')
    .select('id, nome, role, site_id, ativo, created_at, sites(nome_prof, slug)')
    .order('created_at', { ascending: false })
  if (error) return c.json(dbError(), 500)
  const { data: authUsers } = await sb.auth.admin.listUsers({ page: 1, perPage: 1000 })
  const emailById = new Map((authUsers?.users || []).map((user) => [user.id, user.email || '']))
  return c.json({ data: (data || []).map((profile) => ({ ...profile, email: emailById.get(profile.id) || '' })) })
})

app.post('/users', async (c) => {
  const { email, password, nome, role, site_id } = await c.req.json()
  const sb = getAdmin(c.env)

  const { data, error } = await sb.auth.admin.createUser({
    email,
    password,
    user_metadata: { nome, role },
    email_confirm: true
  })
  if (error) return c.json(dbError(), 500)

  await sb.from('profiles').update({ nome, role, site_id: site_id || null }).eq('id', data.user.id)
  return c.json({ id: data.user.id, email, nome, role }, 201)
})

app.post('/users/:id/approve-professor', async (c) => {
  const id = c.req.param('id')
  const sb = getAdmin(c.env)
  const { data: profile, error: profileError } = await sb
    .from('profiles')
    .select('id, nome, role, site_id, ativo')
    .eq('id', id)
    .single()

  if (profileError || !profile) return c.json({ error: 'Professor não encontrado' }, 404)
  if (!['CORRETOR', 'ADMIN'].includes(profile.role)) {
    return c.json({ error: 'Somente professores podem ser aprovados por aqui.' }, 400)
  }

  let siteId = profile.site_id
  if (!siteId) {
    const nome = profile.nome || 'Professor'
    const slug = await uniqueSiteSlug(sb, nome)
    const { data: site, error: siteError } = await sb
      .from('sites')
      .insert({
        slug,
        nome_prof: nome,
        bio_prof: 'Site independente do professor.',
        cor_primaria: '#1A3A2A',
        cor_accent: '#C5F135',
        ativo: true
      })
      .select('id, slug')
      .single()

    if (siteError || !site) return c.json({ error: siteError?.message || 'Não foi possível criar o site do professor.' }, 500)
    siteId = site.id
  } else {
    await sb.from('sites').update({ ativo: true }).eq('id', siteId)
  }

  const { data, error } = await sb
    .from('profiles')
    .update({ ativo: true, role: 'CORRETOR', site_id: siteId })
    .eq('id', id)
    .select('id, nome, role, site_id, ativo, sites(nome_prof, slug)')
    .single()

  if (error) return c.json(dbError(), 500)
  return c.json(data)
})

app.patch('/users/:id', async (c) => {
  const body = await c.req.json()
  const sb = getAdmin(c.env)
  const update: Record<string, unknown> = {}
  const authUpdate: Record<string, unknown> = {}
  const allowedRoles = ['SUPERADMIN', 'ADMIN', 'CORRETOR', 'ALUNO']
  if (typeof body.nome === 'string' && body.nome.trim()) update.nome = body.nome.trim()
  if (typeof body.role === 'string' && allowedRoles.includes(body.role)) update.role = body.role
  if (typeof body.ativo === 'boolean') update.ativo = body.ativo
  if (typeof body.site_id === 'string' || body.site_id === null) update.site_id = body.role === 'SUPERADMIN' ? null : body.site_id
  if (typeof body.email === 'string' && body.email.trim()) authUpdate.email = body.email.trim().toLowerCase()
  if (typeof body.password === 'string' && body.password.trim()) authUpdate.password = body.password.trim()
  if (update.nome || update.role) {
    authUpdate.user_metadata = Object.fromEntries(Object.entries({ nome: update.nome, role: update.role }).filter(([, value]) => value !== undefined))
  }
  if (!Object.keys(update).length && !Object.keys(authUpdate).length) return c.json({ error: 'Nada para atualizar' }, 400)

  if (Object.keys(authUpdate).length) {
    const { error: authError } = await sb.auth.admin.updateUserById(c.req.param('id'), authUpdate)
    if (authError) return c.json(dbError(), 500)
  }

  if (!Object.keys(update).length) {
    const { data: current, error: currentError } = await sb
      .from('profiles')
      .select('id, nome, role, site_id, ativo, created_at, sites(nome_prof, slug)')
      .eq('id', c.req.param('id'))
      .single()
    if (currentError) return c.json(dbError(), 500)
    return c.json(current)
  }

  const { data, error } = await sb
    .from('profiles')
    .update(update)
    .eq('id', c.req.param('id'))
    .select('id, nome, role, site_id, ativo, created_at, sites(nome_prof, slug)')
    .single()

  if (error) return c.json(dbError(), 500)
  return c.json(data)
})

export { app as superadminRoutes }
