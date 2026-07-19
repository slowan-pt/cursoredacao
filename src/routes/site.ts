import { Hono } from 'hono'
import type { Env } from '../types'
import { getAdmin } from '../supabase'
import { getConfig } from '../config'
import { getPaymentGateway } from '../payments'
import { getEmailProvider, renderCheckoutReceiptEmail } from '../email'

const app = new Hono<{ Bindings: Env }>()

function dbError() {
  return { error: 'Erro ao acessar os dados.' }
}

function esc(value: unknown) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

function plainText(value: unknown) {
  return String(value ?? '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim()
}

function truncateText(value: unknown, limit = 160) {
  const text = plainText(value)
  return text.length > limit ? `${text.slice(0, limit - 1).trim()}…` : text
}

function sanitizeRichHtml(value: unknown) {
  let html = String(value ?? '')
  html = html.replace(/<\s*(script|iframe|object|embed|style|form|input|button|textarea|select)[^>]*>[\s\S]*?<\s*\/\s*\1\s*>/gi, '')
  html = html.replace(/<\s*(script|iframe|object|embed|style|form|input|button|textarea|select)[^>]*\/?>/gi, '')
  html = html.replace(/\son[a-z]+\s*=\s*(".*?"|'.*?'|[^\s>]+)/gi, '')
  html = html.replace(/\s(href|src)\s*=\s*("|')\s*javascript:[\s\S]*?\2/gi, '')
  html = html.replace(/\sstyle\s*=\s*("|')([^"']*)\1/gi, (_match, quote, style) => {
    const safe = String(style).split(';').map((rule) => {
      const [prop, ...rest] = rule.split(':')
      const key = String(prop || '').trim().toLowerCase()
      const val = rest.join(':').trim()
      if (!['color', 'background-color', 'font-size', 'font-family', 'text-align', 'line-height', 'letter-spacing', 'text-decoration', 'font-weight', 'font-style', 'box-shadow', 'padding', 'border-radius'].includes(key)) return ''
      if (/url\s*\(|expression\s*\(|javascript:/i.test(val)) return ''
      return `${key}:${esc(val)}`
    }).filter(Boolean).join(';')
    return safe ? ` style=${quote}${safe}${quote}` : ''
  })
  return html.replace(/<\/?([a-z0-9-]+)([^>]*)>/gi, (match, tag, attrs) => {
    const allowed = ['b', 'strong', 'i', 'em', 'u', 'p', 'br', 'div', 'span', 'ul', 'ol', 'li', 'a', 'img', 'h2', 'h3', 'h4', 'blockquote', 'font']
    if (!allowed.includes(String(tag).toLowerCase())) return esc(match)
    const safeAttrs = String(attrs || '')
      .replace(/\s(?!href=|src=|alt=|title=|target=|rel=|style=)[a-z0-9:-]+(?:\s*=\s*(".*?"|'.*?'|[^\s>]+))?/gi, '')
      .replace(/\s(href|src)\s*=\s*("|')((?!https?:\/\/|mailto:|data:image\/)[^"']*)\2/gi, '')
    return `<${match.startsWith('</') ? '/' : ''}${tag}${match.startsWith('</') ? '' : safeAttrs}>`
  })
}

function moneyBR(value: unknown) {
  const n = Number(value || 0)
  return n > 0 ? `R$ ${n.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : 'Gratuito'
}

function jsonForScript(value: unknown) {
  return JSON.stringify(value).replaceAll('<', '\\u003c')
}

function makeCheckoutCode() {
  return `PG-${crypto.randomUUID().replaceAll('-', '').slice(0, 10).toUpperCase()}`
}

function normalizeCheckoutPaymentChoice(value: unknown) {
  const raw = String(value || 'PIX').trim().toUpperCase()
  if (raw === 'BOLETO') return 'BOLETO'
  if (raw === 'CREDIT_CARD' || raw === 'CARTAO' || raw === 'CARD' || raw === 'UNDEFINED') return 'CREDIT_CARD'
  return 'PIX'
}

function asaasBillingType(choice: unknown) {
  const type = normalizeCheckoutPaymentChoice(choice)
  return type === 'CREDIT_CARD' ? 'CREDIT_CARD' : type
}

function checkoutBillingLabel(value: unknown) {
  const type = normalizeCheckoutPaymentChoice(value)
  if (type === 'BOLETO') return 'Boleto'
  if (type === 'CREDIT_CARD') return 'Cartão'
  return 'Pix'
}

function normalizePaymentSettings(settings: any = {}) {
  const methods = settings?.payment_methods && typeof settings.payment_methods === 'object' ? settings.payment_methods : {}
  const paymentMethods = {
    pix: methods.pix !== false,
    boleto: methods.boleto === true,
    credit_card: methods.credit_card === true
  }
  if (!paymentMethods.pix && !paymentMethods.boleto && !paymentMethods.credit_card) paymentMethods.pix = true
  return {
    methods: paymentMethods,
    creditCardInstallments: Math.max(1, Math.min(12, Math.floor(Number(settings?.credit_card_installments) || 1))),
    feePayer: String(settings?.payment_fee_payer || 'PROFESSOR').toUpperCase() === 'ALUNO' ? 'ALUNO' : 'PROFESSOR',
    feePercent: Math.max(0, Math.min(30, Number(settings?.payment_fee_percent) || 0))
  }
}

function isPaymentChoiceAllowed(choice: string, settings: ReturnType<typeof normalizePaymentSettings>) {
  if (choice === 'BOLETO') return settings.methods.boleto
  if (choice === 'CREDIT_CARD') return settings.methods.credit_card
  return settings.methods.pix
}

function checkoutChargeAmount(baseAmount: number, choice: string, settings: ReturnType<typeof normalizePaymentSettings>) {
  if (choice !== 'CREDIT_CARD') return baseAmount
  if (settings.feePayer !== 'ALUNO' || settings.feePercent <= 0) return baseAmount
  return Math.round(baseAmount * (1 + settings.feePercent / 100) * 100) / 100
}

function maxCreditCardInstallmentsFor(amount: number, settings: ReturnType<typeof normalizePaymentSettings>) {
  const chargedAmount = checkoutChargeAmount(amount, 'CREDIT_CARD', settings)
  const byAmount = Math.max(1, Math.floor(chargedAmount / 5))
  return Math.max(1, Math.min(settings.creditCardInstallments, byAmount))
}

function onlyDigits(value: unknown) {
  return String(value || '').replace(/\D/g, '')
}

function normalizeCardYear(value: unknown) {
  const digits = onlyDigits(value)
  if (digits.length === 2) return `20${digits}`
  return digits.slice(0, 4)
}

function isValidCpf(value: unknown) {
  const cpf = onlyDigits(value)
  if (cpf.length !== 11 || /^(\d)\1{10}$/.test(cpf)) return false
  const calc = (base: string, factor: number) => {
    const sum = base.split('').reduce((total, digit) => total + Number(digit) * factor--, 0)
    const rest = (sum * 10) % 11
    return rest === 10 ? 0 : rest
  }
  return calc(cpf.slice(0, 9), 10) === Number(cpf[9]) && calc(cpf.slice(0, 10), 11) === Number(cpf[10])
}

function validateCreditCardPayload(card: any) {
  if (onlyDigits(card?.number).length < 13) return { field: 'card_number', error: 'Informe o número completo do cartão.' }
  if (!String(card?.holderName || '').trim()) return { field: 'card_holder', error: 'Informe o nome do titular como aparece no cartão.' }
  if (onlyDigits(card?.expiryMonth).length !== 2) return { field: 'card_month', error: 'Informe o mês de validade com 2 dígitos.' }
  if (normalizeCardYear(card?.expiryYear).length !== 4) return { field: 'card_year', error: 'Informe o ano de validade com 4 dígitos.' }
  if (onlyDigits(card?.ccv).length < 3) return { field: 'card_ccv', error: 'Informe o código de segurança do cartão.' }
  if (onlyDigits(card?.holderPostalCode).length !== 8) return { field: 'card_cep', error: 'Informe o CEP do titular com 8 dígitos.' }
  if (!onlyDigits(card?.holderAddressNumber)) return { field: 'card_address', error: 'Informe o número do endereço do titular.' }
  return null
}

function maskEmail(value: unknown) {
  const email = String(value || '').trim().toLowerCase()
  const [user, domain] = email.split('@')
  if (!user || !domain) return ''
  const visible = user.length <= 2 ? user[0] || '' : `${user[0]}${user[user.length - 1]}`
  return `${visible}${'*'.repeat(Math.max(2, user.length - visible.length))}@${domain}`
}

async function lookupStudentAccountByCpf(sb: ReturnType<typeof getAdmin>, siteId: string, cpf: string) {
  const authUsers = await sb.auth.admin.listUsers()
  let authUser = authUsers.data.users.find((item) => onlyDigits((item.user_metadata as any)?.cpf) === cpf)
  if (!authUser?.id) {
    const { data: paymentMatch } = await sb.from('payments')
      .select('aluno_id')
      .eq('site_id', siteId)
      .eq('raw_summary->>cpf', cpf)
      .not('aluno_id', 'is', null)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle()
    authUser = authUsers.data.users.find((item) => String(item.id) === String(paymentMatch?.aluno_id))
  }
  if (!authUser?.id) {
    const { data: site } = await sb.from('sites')
      .select('allowed_origins')
      .eq('id', siteId)
      .maybeSingle()
    const cms = parseCms(site)
    const lead = Object.values(cms.checkout_leads || {}).find((item: any) => onlyDigits(item?.cpf) === cpf) as any
    const leadUserId = String(lead?.user_id || '').trim()
    const leadEmail = String(lead?.email || '').trim().toLowerCase()
    authUser = authUsers.data.users.find((item) =>
      (leadUserId && String(item.id) === leadUserId) ||
      (leadEmail && String(item.email || '').toLowerCase() === leadEmail)
    )
  }
  if (!authUser?.id) {
    return { exists: false, sameSite: false, active: true, emailHint: '', authUser: null }
  }
  const { data: profile } = await sb.from('profiles')
    .select('role, site_id, ativo')
    .eq('id', authUser.id)
    .maybeSingle()
  const sameSite = String(profile?.site_id || '') === String(siteId)
  const isStudent = String(profile?.role || '').toUpperCase() === 'ALUNO'
  return {
    exists: Boolean(sameSite && isStudent),
    sameSite,
    active: profile?.ativo !== false,
    emailHint: sameSite && isStudent ? maskEmail(authUser.email) : '',
    authUser
  }
}

function tomorrowIsoDate() {
  const date = new Date()
  date.setDate(date.getDate() + 1)
  return date.toISOString().slice(0, 10)
}

async function sendCheckoutReceipt(env: Env, lead: any, turma: any, site: any) {
  if (!getConfig(env).flags.emails) {
    return { sent: false, reason: 'emails-disabled' }
  }
  const appUrl = String(env.APP_URL || 'https://redacaocomestrategia.com.br').replace(/\/+$/, '')
  const sitePath = `${appUrl}/redacao/${encodeURIComponent(String(site?.slug || ''))}`
  const query = new URLSearchParams({
    signup: '1',
    paid: '1',
    turma: String(turma?.id || lead?.turma_id || ''),
    email: String(lead?.email || ''),
    nome: String(lead?.nome || ''),
    checkout_code: String(lead?.checkout_code || lead?.code || '')
  })
  if (lead?.cpf) query.set('cpf', String(lead.cpf))
  const signupUrl = `${sitePath}/login?${query.toString()}`
  const message = renderCheckoutReceiptEmail({
    to: String(lead?.email || ''),
    studentName: String(lead?.nome || 'aluno'),
    courseName: String(turma?.nome || 'Turma'),
    checkoutCode: String(lead?.checkout_code || lead?.code || ''),
    transactionId: String(lead?.transaction_id || ''),
    loginUrl: `${sitePath}/login`,
    signupUrl,
    paymentUrl: lead?.payment_url || undefined
  })
  return getEmailProvider(env).send(message)
}

async function sendVideoCheckoutReceipt(env: Env, lead: any, course: any, site: any) {
  if (!getConfig(env).flags.emails) {
    return { sent: false, reason: 'emails-disabled' }
  }
  const appUrl = String(env.APP_URL || 'https://redacaocomestrategia.com.br').replace(/\/+$/, '')
  const sitePath = `${appUrl}/redacao/${encodeURIComponent(String(site?.slug || ''))}`
  const query = new URLSearchParams({
    signup: '1',
    paid: '1',
    product: 'video',
    course: String(course?.id || lead?.course_id || ''),
    email: String(lead?.email || ''),
    nome: String(lead?.nome || ''),
    checkout_code: String(lead?.checkout_code || lead?.code || '')
  })
  if (lead?.cpf) query.set('cpf', String(lead.cpf))
  const signupUrl = `${sitePath}/login?${query.toString()}`
  const message = renderCheckoutReceiptEmail({
    to: String(lead?.email || ''),
    studentName: String(lead?.nome || 'aluno'),
    courseName: String(course?.title || 'Curso em vídeo'),
    checkoutCode: String(lead?.checkout_code || lead?.code || ''),
    transactionId: String(lead?.transaction_id || ''),
    loginUrl: `${sitePath}/login`,
    signupUrl,
    paymentUrl: lead?.payment_url || undefined
  })
  return getEmailProvider(env).send(message)
}

function parseHex(value: unknown) {
  const raw = String(value ?? '').trim()
  const hex = raw.match(/^#?([0-9a-f]{6})$/i)
  return hex ? `#${hex[1].toUpperCase()}` : null
}

function hexToRgb(hex: string) {
  const clean = hex.replace('#', '')
  return {
    r: parseInt(clean.slice(0, 2), 16),
    g: parseInt(clean.slice(2, 4), 16),
    b: parseInt(clean.slice(4, 6), 16)
  }
}

function contrastText(color: unknown) {
  const hex = parseHex(color) || '#1A3A2A'
  const { r, g, b } = hexToRgb(hex)
  const linear = [r, g, b].map((v) => {
    const c = v / 255
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)
  })
  const luminance = 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2]
  return luminance > 0.52 ? '#111111' : '#FFFFFF'
}

function alphaColor(color: string, alpha: number) {
  const { r, g, b } = hexToRgb(color)
  return `rgba(${r},${g},${b},${alpha})`
}

function defaultTheme(primary = '#1A3A2A', accent = '#C5F135') {
  const brand = parseHex(primary) || '#1A3A2A'
  const hi = parseHex(accent) || '#C5F135'
  return {
    mode: 'auto',
    primary: brand,
    primaryText: contrastText(brand),
    accent: hi,
    accentText: contrastText(hi),
    background: '#F8F7F4',
    card: '#FFFFFF',
    border: '#E8E5E0',
    borderStrong: '#D0CCC4',
    text: '#0F0F0F',
    textSoft: '#3A3A3A',
    textMuted: '#787878',
    success: '#2E7D32',
    warning: '#E8A020',
    danger: '#C84040',
    info: '#1565C0'
  }
}

function normalizeTheme(raw: any, primary: unknown, accent: unknown) {
  const base = defaultTheme(parseHex(primary) || '#1A3A2A', parseHex(accent) || '#C5F135')
  const merged = { ...base, ...(raw || {}) }
  const normalized: Record<string, string> = { mode: String(merged.mode || 'auto') }
  for (const [key, value] of Object.entries(merged)) {
    if (key === 'mode') continue
    normalized[key] = parseHex(value) || (base as any)[key]
  }
  if (normalized.mode === 'auto') {
    normalized.primary = parseHex(primary) || normalized.primary
    normalized.accent = parseHex(accent) || normalized.accent
    normalized.primaryText = contrastText(normalized.primary)
    normalized.accentText = contrastText(normalized.accent)
  }
  return normalized
}

const CMS_PREFIX = 'CMS:'

function defaultCms() {
  return {
    owner_gender: '',
    layout: {
      header_label: 'Redação',
      eyebrow: 'Site independente do professor',
      hero_title: 'Redação com acompanhamento direto.',
      cta_text: 'Criar acesso de aluno',
      profile_text: 'Este site tem turmas, alunos e correções separados dos demais professores da plataforma.',
      turmas_title: 'Escolha sua turma',
      turmas_subtitle: 'Ao criar acesso por aqui, seu cadastro fica vinculado a este professor.',
      posts_title: 'Dicas e materiais',
      posts_intro: 'Publicações, notícias e matérias do professor.',
      profile_side: 'right',
      block_order: ['hero', 'video_courses', 'turmas', 'conteudos', 'aluno'],
      avatar_text: 'PR',
      avatar_image: '',
      profile_display_mode: 'text',
      profile_photo: '',
      profile_photo_original: '',
      profile_photo_remove_bg: false,
      hidden_elements: [],
      extra_blocks: [],
      aluno_title: 'Acesse a plataforma',
      aluno_text: 'Entre para acompanhar turmas, envios de redação e correções.',
      aluno_cta: 'Entrar na area do aluno'
    },
    contact: {
      whatsapp_phone: '5521971214042'
    },
    theme: defaultTheme(),
    posts: [] as any[],
    video_courses: [] as any[],
    turma_settings: {} as Record<string, any>,
    student_credits: {} as Record<string, any>,
    enrollments: {} as Record<string, any>,
    checkout_leads: {} as Record<string, any>,
    notifications: [] as any[]
  }
}

function professorWords(gender: unknown) {
  const normalized = String(gender || '').trim().toUpperCase()
  if (normalized === 'MASCULINO') {
    return {
      singular: 'Professor',
      singularLower: 'professor',
      plural: 'professores',
      independentSite: 'Site independente do professor'
    }
  }
  if (normalized === 'FEMININO') {
    return {
      singular: 'Professora',
      singularLower: 'professora',
      plural: 'professoras',
      independentSite: 'Site independente da professora'
    }
  }
  return {
    singular: 'Professor(a)',
    singularLower: 'professor(a)',
    plural: 'professores',
    independentSite: 'Site independente do professor'
  }
}

function genderedDefaultProfileText(gender: unknown) {
  const words = professorWords(gender)
  return `Este site tem turmas, alunos e correções separados dos demais ${words.plural} da plataforma.`
}

function parseCms(site: any) {
  const raw = (site?.allowed_origins || []).find((item: string) => String(item).startsWith(CMS_PREFIX))
  if (!raw) return defaultCms()
  try {
    const cms = JSON.parse(String(raw).slice(CMS_PREFIX.length))
    return {
      ...defaultCms(),
      ...cms,
      layout: { ...defaultCms().layout, ...(cms.layout || {}) },
      contact: { ...defaultCms().contact, ...(cms.contact || {}) },
      theme: { ...defaultCms().theme, ...(cms.theme || {}) },
      posts: Array.isArray(cms.posts) ? cms.posts : [],
      video_courses: Array.isArray(cms.video_courses) ? cms.video_courses : [],
      turma_settings: cms.turma_settings && typeof cms.turma_settings === 'object' ? cms.turma_settings : {},
      student_credits: cms.student_credits && typeof cms.student_credits === 'object' ? cms.student_credits : {},
      enrollments: cms.enrollments && typeof cms.enrollments === 'object' ? cms.enrollments : {},
      checkout_leads: cms.checkout_leads && typeof cms.checkout_leads === 'object' ? cms.checkout_leads : {},
      notifications: Array.isArray(cms.notifications) ? cms.notifications : []
    }
  } catch {
    return defaultCms()
  }
}

function withCmsOrigins(origins: string[] | null | undefined, cms: unknown) {
  const keep = (origins || []).filter((item) => !String(item).startsWith(CMS_PREFIX))
  return [...keep, `${CMS_PREFIX}${JSON.stringify(cms || defaultCms())}`]
}

async function saveCms(env: Env, siteId: string, cms: ReturnType<typeof parseCms>) {
  const sb = getAdmin(env)
  const { data: site, error: siteErr } = await sb.from('sites').select('allowed_origins').eq('id', siteId).single()
  if (siteErr) return { error: siteErr }
  const { error } = await sb.from('sites')
    .update({ allowed_origins: withCmsOrigins(site.allowed_origins, cms) })
    .eq('id', siteId)
  return { error }
}

function postTypeLabel(value: unknown) {
  return ({ NOTICIA: 'Notícia', MATERIA: 'Matéria', POST: 'Publicação' } as Record<string, string>)[String(value || '').toUpperCase()] || 'Publicação'
}

function postPublicId(post: any) {
  const base = String(post?.id || post?.titulo || Date.now())
  return encodeURIComponent(base.replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 90) || String(post?.id || Date.now()))
}

function marketplaceFallbackTeachers() {
  return [
    {
      slug: 'puppin-teste',
      nome: 'Professora Puppin',
      especialidade: 'Redação para concursos',
      bio: 'Acompanhamento direto, turmas organizadas e correções detalhadas em uma página própria.',
      foto_url: '',
      iniciais: 'PP',
      url: '/redacao/puppin-teste',
      site_ativo: true,
      pacote_ativo: true,
      source: 'fallback'
    },
    {
      slug: 'slow',
      nome: 'Prof. Sloan Nascimento',
      especialidade: 'Redação discursiva e argumentação',
      bio: 'Perfil de demonstração para professores que querem vender correções e organizar alunos.',
      foto_url: '',
      iniciais: 'SN',
      url: '/redacao/slow',
      site_ativo: true,
      pacote_ativo: true,
      source: 'fallback'
    }
  ]
}

function initialsFromName(name: unknown) {
  const parts = String(name || 'Professor')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
  return (parts.map((part) => part[0]).join('') || 'PR').toUpperCase()
}

function sitePackageActive(site: any, cms: any) {
  const plan = cms?.platform_plan || cms?.subscription || cms?.billing || {}
  if (plan?.active === false || plan?.status === 'INACTIVE' || plan?.status === 'EXPIRED') return false
  if (plan?.expires_at) {
    const expires = new Date(`${String(plan.expires_at).slice(0, 10)}T23:59:59.999Z`).getTime()
    if (Number.isFinite(expires) && expires < Date.now()) return false
  }
  return site?.ativo !== false
}

async function loadSite(env: Env, slug: string) {
  const sb = getAdmin(env)
  const { data: site, error } = await sb.from('sites')
    .select('*')
    .eq('slug', slug)
    .eq('ativo', true)
    .single()

  if (error || !site) return null

  const { data: turmas } = await sb.from('turmas')
    .select('id, nome, concurso, descricao, status, preco')
    .eq('site_id', site.id)
    .eq('status', 'ABERTA')
    .order('created_at', { ascending: false })

  return { site, turmas: turmas ?? [] }
}

function renderSitePage(data: { site: any; turmas: any[] }) {
  const { site, turmas } = data
  const cms = parseCms(site)
  const layout = cms.layout
  const words = professorWords(cms.owner_gender)
  const defaultLayout = defaultCms().layout
  const heroEyebrow = layout.eyebrow === defaultLayout.eyebrow ? words.independentSite : layout.eyebrow
  const profileText = layout.profile_text === defaultLayout.profile_text ? genderedDefaultProfileText(cms.owner_gender) : layout.profile_text
  const posts = (cms.posts || [])
    .filter((post: any) => post.status !== 'RASCUNHO')
    .sort((a: any, b: any) => Number(Boolean(b.pinned)) - Number(Boolean(a.pinned)) || String(b.created_at || '').localeCompare(String(a.created_at || '')))
  const videoCourses = (cms.video_courses || [])
    .filter((course: any) => course.status !== 'RASCUNHO' && course.status !== 'OCULTO')
    .sort((a: any, b: any) => Number(Boolean(b.pinned)) - Number(Boolean(a.pinned)) || String(b.created_at || '').localeCompare(String(a.created_at || '')))
  const theme = normalizeTheme(cms.theme, site.cor_primaria, site.cor_accent)
  const brand = theme.primary
  const accent = theme.accent
  const brandText = theme.primaryText
  const accentText = theme.accentText
  const brandTextSoft = alphaColor(brandText, 0.72)
  const brandTextDim = alphaColor(brandText, 0.66)
  const brandBorder = alphaColor(brandText, 0.16)
  const brandTint = alphaColor(brandText, 0.1)
  const whatsappPhone = String(cms.contact?.whatsapp_phone || '5521971214042').replace(/\D/g, '') || '5521971214042'
  const whatsapp = `http://api.whatsapp.com/send?phone=${whatsappPhone}`
  const sitePath = `/redacao/${encodeURIComponent(site.slug)}`
  const loginUrl = `${sitePath}/login`
  const profileSide = layout.profile_side === 'left' ? 'profile-left' : ''
  const profilePhoto = String(layout.profile_photo || '')
  const profilePhotoMode = layout.profile_display_mode === 'photo' && profilePhoto
  const turmaSettings = cms.turma_settings && typeof cms.turma_settings === 'object' ? cms.turma_settings : {}
  const turmaUrl = (id: string) => `${sitePath}/turmas/${encodeURIComponent(id)}`
  const validBlocks = ['hero', 'video_courses', 'turmas', 'conteudos', 'aluno']
  const savedOrder = Array.isArray(layout.block_order) ? layout.block_order.filter((id: string) => validBlocks.includes(id)) : []
  // Migração: se video_courses não estava no block_order salvo, insere antes de turmas
  const missingBlocks = validBlocks.filter(id => !savedOrder.includes(id))
  const blockOrder = [...savedOrder]
  for (const id of missingBlocks) {
    if (id === 'video_courses') {
      const turmasIdx = blockOrder.indexOf('turmas')
      blockOrder.splice(turmasIdx >= 0 ? turmasIdx : 1, 0, id)
    } else {
      blockOrder.push(id)
    }
  }
  const blockOrderCss = blockOrder.map((id, index) => `[data-block="${id}"]{order:${index + 1}}`).join('')
  const positions = layout.positions && typeof layout.positions === 'object' ? layout.positions : {}
  const hiddenElements = new Set(Array.isArray(layout.hidden_elements) ? layout.hidden_elements : [])
  const extraBlocks = Array.isArray(layout.extra_blocks) ? layout.extra_blocks : []
  const textStyles = layout.text_styles && typeof layout.text_styles === 'object' ? layout.text_styles : {}
  const carouselStart = (kind: string, enabled: boolean) => enabled
    ? `<div class="site-carousel" data-carousel="${esc(kind)}"><button type="button" class="carousel-btn carousel-prev" data-carousel-prev aria-label="Ver anteriores">‹</button><div class="${kind === 'turmas' ? 'grid' : 'content-grid'} carousel-track" data-carousel-track>`
    : `<div class="${kind === 'turmas' ? 'grid' : 'content-grid'}">`
  const carouselEnd = (enabled: boolean) => enabled
    ? `</div><button type="button" class="carousel-btn carousel-next" data-carousel-next aria-label="Ver próximos">›</button></div>`
    : `</div>`
  const isHidden = (key: string) => hiddenElements.has(key)
  const clampNum = (value: number, min: number, max: number, fallback: number) => {
    if (!Number.isFinite(value)) return fallback
    return Math.max(min, Math.min(max, value))
  }
  const extraStyle = (block: any, key: string, defaultHeight = 0) => {
    const styles = [
      `width:${clampNum(Number(block.width || 100), 10, 100, 100)}%`
    ]
    const height = Number(block.height || defaultHeight || 0)
    if (Number.isFinite(height) && height > 0) styles.push(`height:${clampNum(height, 30, 900, defaultHeight || 120)}px`)
    const fontSize = Number(block.font_size || 0)
    if (fontSize > 0) styles.push(`font-size:${clampNum(fontSize, 8, 96, 18)}px`)
    if (parseHex(block.text_color)) styles.push(`color:${parseHex(block.text_color)}`)
    if (parseHex(block.background_color)) styles.push(`background:${parseHex(block.background_color)}`)
    const borderWidth = clampNum(Number(block.border_width || 0), 0, 24, 0)
    const borderColor = parseHex(block.border_color)
    if (borderWidth > 0) styles.push(`border:${borderWidth}px solid ${borderColor || 'currentColor'}`)
    const radius = Number(block.border_radius || 0)
    if (Number.isFinite(radius) && radius > 0) styles.push(`border-radius:${clampNum(radius, 0, 80, 0)}px`)
    const padding = Number(block.padding || 0)
    if (Number.isFinite(padding) && padding > 0) styles.push(`padding:${clampNum(padding, 0, 80, 0)}px`)
    if (['left', 'center', 'right', 'justify'].includes(String(block.text_align || ''))) styles.push(`text-align:${block.text_align}`)
    if (['400', '600', '700', '800', '900'].includes(String(block.font_weight || ''))) styles.push(`font-weight:${block.font_weight}`)
    if (block.font_family) styles.push(`font-family:${String(block.font_family).replace(/[^a-zA-Z0-9 ,'-]/g, '')}`)
    if (block.font_style === 'italic') styles.push('font-style:italic')
    if (block.text_decoration === 'underline') styles.push('text-decoration:underline')
    const zIndex = Number(block.z_index || 0)
    if (Number.isFinite(zIndex) && zIndex) styles.push(`z-index:${clampNum(zIndex, 0, 999, 1)}`)
    styles.push(moveTransform(key))
    return styles.filter(Boolean).join(';')
  }
  const editableStyle = (key: string) => {
    const s = textStyles[key] || {}
    const styles: string[] = []
    if (s.font_family) styles.push(`font-family:${String(s.font_family).replace(/[^a-zA-Z0-9 ,'-]/g, '')}`)
    const fontSize = Number(s.font_size || 0)
    if (fontSize > 0) styles.push(`font-size:${clampNum(fontSize, 8, 96, 16)}px`)
    if (parseHex(s.color)) styles.push(`color:${parseHex(s.color)}`)
    if (['400', '600', '700', '800', '900'].includes(String(s.font_weight || ''))) styles.push(`font-weight:${s.font_weight}`)
    if (s.font_style === 'italic') styles.push('font-style:italic')
    if (s.text_decoration === 'underline') styles.push('text-decoration:underline')
    if (['left', 'center', 'right', 'justify'].includes(String(s.text_align || ''))) styles.push(`text-align:${s.text_align}`)
    const zIndex = Number(s.z_index || 0)
    if (Number.isFinite(zIndex) && zIndex) styles.push(`position:relative;z-index:${clampNum(zIndex, 0, 999, 1)}`)
    return styles.length ? ` style="${esc(styles.join(';'))}"` : ''
  }
  const imageFit = (block: any) => ['contain', 'cover', 'fill'].includes(String(block.object_fit || '')) ? String(block.object_fit) : 'cover'
  const moveStyle = (key: string) => {
    if (isHidden(key)) return ' style="display:none"'
    const pos = positions[key]
    const x = Number(pos?.x || 0)
    const y = Number(pos?.y || 0)
    if (!Number.isFinite(x) || !Number.isFinite(y) || (!x && !y)) return ''
    return ` style="transform:translate(${x}px,${y}px)"`
  }
  const moveTransform = (key: string) => {
    const pos = positions[key]
    const x = Number(pos?.x || 0)
    const y = Number(pos?.y || 0)
    if (!Number.isFinite(x) || !Number.isFinite(y) || (!x && !y)) return ''
    return `transform:translate(${x}px,${y}px);`
  }
  const extraHtml = (target: string) => extraBlocks
    .filter((block: any) => block?.id && !isHidden(`extra:${block.id}`) && (block.target || 'hero') === target)
    .map((block: any) => {
      const key = `extra:${block.id}`
      if (block.type === 'image') {
        return `<div class="site-extra site-extra-image" data-extra-id="${esc(block.id)}" data-extra-type="image" data-move-key="${esc(key)}" style="${extraStyle(block, key, 220)}">
          <img src="${esc(block.src || '')}" alt="${esc(block.alt || 'Imagem do site')}" data-site-image style="object-fit:${esc(imageFit(block))}">
        </div>`
      }
      if (block.type === 'avatar') {
        const avatarSrc = block.src || block.image || ''
        return `<div class="site-extra site-extra-avatar" data-extra-id="${esc(block.id)}" data-extra-type="avatar" data-move-key="${esc(key)}" style="${extraStyle(block, key, Number(block.height || 120) || 120)}">
          <div class="site-extra-avatar-circle" data-edit="extra.${esc(block.id)}.text">${avatarSrc ? `<img src="${esc(avatarSrc)}" alt="${esc(block.alt || 'Avatar')}">` : esc(block.text || 'PR')}</div>
        </div>`
      }
      return `<div class="site-extra site-extra-text" data-extra-id="${esc(block.id)}" data-extra-type="text" data-move-key="${esc(key)}" style="${extraStyle(block, key)}">
        <div data-edit="extra.${esc(block.id)}.text">${esc(block.text || 'Novo texto')}</div>
      </div>`
    }).join('')
  const blockTools = (target: string) => `<div class="block-tools" data-block-tools="${esc(target)}">
    <button type="button" onclick="addTextFromSite('${esc(target)}')">+ Texto</button>
    <button type="button" onclick="addImageFromSite('${esc(target)}')">+ Imagem</button>
    <button type="button" onclick="addAvatarFromSite('${esc(target)}')">+ Avatar</button>
  </div>`

  return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(site.nome_prof)} — Redação</title>
<meta name="description" content="${esc(site.bio_prof || profileText || `Site público de ${words.singularLower} na plataforma Redação com Estratégia.`)}">
<meta property="og:type" content="website">
<meta property="og:title" content="${esc(site.nome_prof)} — Redação">
<meta property="og:description" content="${esc(site.bio_prof || profileText || `Turmas, conteúdos e correções em um site próprio de ${words.singularLower}.`)}">
<meta property="og:url" content="https://redacaocomestrategia.com.br${esc(sitePath)}">
<link rel="icon" href="/favicon-writing.svg" type="image/svg+xml">
<meta name="theme-color" content="${esc(brand)}">
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700;800;900&display=swap" rel="stylesheet">
<style>
*{box-sizing:border-box;margin:0;padding:0}
:root{--brand:${esc(brand)};--brand-text:${esc(brandText)};--brand-text-soft:${esc(brandTextSoft)};--brand-text-dim:${esc(brandTextDim)};--brand-border:${esc(brandBorder)};--brand-tint:${esc(brandTint)};--accent:${esc(accent)};--accent-text:${esc(accentText)};--surface:${esc(theme.background)};--ink:${esc(theme.text)};--ink2:${esc(theme.textSoft)};--ink3:${esc(theme.textMuted)};--card:${esc(theme.card)};--border:${esc(theme.border)};--border2:${esc(theme.borderStrong)};--danger:${esc(theme.danger)};--gold:${esc(theme.warning)};--success:${esc(theme.success)};--info:${esc(theme.info)};--r:8px;--r2:12px}
body{font-family:'Inter',system-ui,sans-serif;background:var(--surface);color:var(--ink);-webkit-font-smoothing:antialiased}
a{text-decoration:none;color:inherit}
.nav{height:64px;background:var(--brand);color:var(--brand-text);display:flex;align-items:center;justify-content:space-between;padding:0 6%;position:sticky;top:0;z-index:10}
.brand{display:flex;align-items:center;gap:10px;font-weight:800}
.mark{background:var(--accent);color:var(--accent-text);font-size:10px;font-weight:900;padding:3px 9px;border-radius:5px;text-transform:uppercase}
.nav-actions{display:flex;gap:10px;align-items:center}
.nav-link{font-size:13px;color:var(--brand-text-soft)}
.btn{display:inline-flex;align-items:center;justify-content:center;border:none;border-radius:var(--r);padding:11px 18px;font-size:13px;font-weight:800;cursor:pointer;transition:all .2s}
.btn:hover{transform:translateY(-2px)}
.btn-accent{background:var(--accent);color:var(--accent-text)}
.btn-dark{background:var(--brand);color:var(--brand-text)}
.btn-light{background:#fff;color:var(--brand)}
.hero{background:var(--brand);color:var(--brand-text);padding:80px 6% 72px;display:grid;grid-template-columns:minmax(0,1fr) 340px;gap:48px;align-items:center}
.hero.profile-left .profile{grid-column:1;grid-row:1}.hero.profile-left .hero-copy{grid-column:2;grid-row:1}
.site-blocks{display:flex;flex-direction:column}
.eyebrow{display:inline-flex;background:var(--brand-tint);border:1px solid var(--brand-border);padding:6px 13px;border-radius:999px;font-size:11px;font-weight:800;text-transform:uppercase;color:var(--brand-text-soft);margin-bottom:24px}
h1{font-size:clamp(36px,5vw,62px);line-height:1.02;letter-spacing:-1px;font-weight:900;max-width:720px}
.hero p{color:var(--brand-text-soft);line-height:1.7;margin:20px 0 32px;max-width:560px}
.hero-actions{display:flex;gap:12px;flex-wrap:wrap}
.profile{background:var(--brand-tint);border:1px solid var(--brand-border);border-radius:16px;padding:26px}
.avatar{width:76px;height:76px;border-radius:50%;background:var(--accent);color:var(--accent-text);display:flex;align-items:center;justify-content:center;font-size:26px;font-weight:900;margin-bottom:18px}
.avatar img{width:100%;height:100%;object-fit:cover;border-radius:50%}
.profile h2{font-size:18px;margin-bottom:8px}
.profile p{font-size:13px;margin:0;color:var(--brand-text-dim)}
.profile.photo-only{padding:0;background:transparent;border:0;overflow:hidden;display:flex;align-items:center;justify-content:center}
.profile-photo-main{display:block;width:100%;max-height:430px;object-fit:contain;border-radius:16px}
.section{padding:72px 6%}
.section-head{display:flex;align-items:end;justify-content:space-between;gap:24px;margin-bottom:26px}
.tag{font-size:11px;font-weight:800;color:var(--brand);text-transform:uppercase;letter-spacing:.08em;margin-bottom:8px}
.title{font-size:32px;font-weight:900;letter-spacing:-.5px}
.sub{font-size:14px;color:var(--ink3);margin-top:6px}
.grid{display:grid;grid-template-columns:repeat(3,1fr);gap:18px}
.site-carousel{position:relative}
.site-carousel .carousel-track{display:flex;gap:18px;overflow-x:auto;scroll-snap-type:x mandatory;scroll-behavior:smooth;scrollbar-width:none;padding:2px 2px 8px}
.site-carousel .carousel-track::-webkit-scrollbar{display:none}
.site-carousel .card,.site-carousel .post-card{flex:0 0 calc((100% - 36px)/3);scroll-snap-align:start}
.carousel-btn{position:absolute;top:50%;transform:translateY(-50%);z-index:8;width:42px;height:42px;border:1px solid var(--border);border-radius:50%;background:var(--card);color:var(--brand);font-size:28px;font-weight:900;line-height:1;display:flex;align-items:center;justify-content:center;cursor:pointer;box-shadow:0 14px 34px rgba(0,0,0,.14);transition:transform .18s,background .18s,color .18s}
.carousel-btn:hover{background:var(--brand);color:var(--brand-text);transform:translateY(-50%) scale(1.04)}
.carousel-prev{left:-20px}.carousel-next{right:-20px}
.card{background:var(--card);border:1px solid var(--border);border-radius:var(--r2);padding:24px;display:flex;flex-direction:column;gap:14px;transition:transform .32s ease,box-shadow .32s ease,border-color .32s ease}
.card:hover{transform:translateY(-6px);box-shadow:0 22px 48px rgba(0,0,0,.12);border-color:var(--border2)}
.course-cover{display:block;width:min(100%,260px);aspect-ratio:2/3;border-radius:16px;overflow:hidden;background:#050505;margin:0 auto 10px}
.course-cover img{width:100%;height:100%;object-fit:contain;background:#050505;display:block;transition:transform .55s ease,filter .35s ease}
.card:hover .course-cover img{transform:scale(1.045);filter:saturate(1.06)}
.course-cover-placeholder{width:100%;height:100%;display:flex;align-items:center;justify-content:center;color:var(--brand-text);font-size:34px;font-weight:900;letter-spacing:.08em;background:linear-gradient(135deg,var(--brand),rgba(0,0,0,.35))}
.course-card-link{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-top:auto}
.course-arrow{width:38px;height:38px;border-radius:50%;background:var(--accent);color:var(--accent-text);display:inline-flex;align-items:center;justify-content:center;font-size:24px;font-weight:900;transition:transform .25s ease}
.card:hover .course-arrow{transform:translate(3px,-3px)}
.video-badge{display:inline-flex;align-items:center;gap:6px;width:max-content;border-radius:999px;background:var(--brand-tint);border:1px solid var(--brand-border);color:var(--brand);font-size:11px;font-weight:900;text-transform:uppercase;padding:6px 10px}
.video-course-card .course-cover{background:#0d0d0d}
.video-course-card .desc{min-height:66px}
.video-meta{display:flex;gap:8px;flex-wrap:wrap;font-size:11px;color:var(--ink3);font-weight:700}
.video-meta span{background:rgba(0,0,0,.04);border:1px solid var(--border);border-radius:999px;padding:5px 9px}
.card h3{font-size:17px}
.meta{font-size:12px;color:var(--ink3)}
.desc{font-size:13px;color:var(--ink2);line-height:1.6;min-height:42px}
.price{font-size:18px;font-weight:900;color:var(--brand);margin-top:auto}
.band{background:var(--card);border-top:1px solid var(--border);border-bottom:1px solid var(--border);text-align:center}
.band p{color:var(--ink3);margin:8px auto 24px;max-width:520px}
.content-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:18px}
.post-card{background:var(--card);border:1px solid var(--border);border-radius:var(--r2);padding:22px;display:flex;flex-direction:column;gap:12px;min-height:282px;overflow:hidden}
.post-card .post-type{font-size:10px;font-weight:900;color:var(--brand);text-transform:uppercase;letter-spacing:.08em}
.post-card h3{font-size:18px;line-height:1.25;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.post-card p{font-size:13px;color:var(--ink2);line-height:1.65;min-height:62px}
.post-body{font-size:13px;color:var(--ink2);line-height:1.7;border-top:1px solid var(--border);padding-top:12px;margin-top:2px}
.post-card .read-more{margin-top:auto;align-self:flex-start}
.rich-output img{max-width:100%;border-radius:12px;display:block;margin:12px 0}.rich-output ul,.rich-output ol{padding-left:24px;margin:10px 0}.rich-output li{margin:5px 0}.rich-output a{color:var(--brand);font-weight:800;text-decoration:underline}.rich-output blockquote{border-left:4px solid var(--accent);padding:8px 12px;background:rgba(0,0,0,.04);border-radius:8px;margin:12px 0}.rich-output p{margin:0 0 12px}
.reveal{opacity:0;transform:translateY(28px);transition:opacity .7s ease,transform .7s ease}
.reveal.is-visible{opacity:1;transform:none}
@media(prefers-reduced-motion:reduce){.reveal,.card,.btn,.course-cover img,.course-arrow{transition:none!important;transform:none!important}.reveal{opacity:1}}
footer{background:#111;color:rgba(255,255,255,.45);padding:34px 6%;font-size:12px}
.whatsapp-float{position:fixed;right:22px;bottom:22px;width:58px;height:58px;border-radius:50%;background:#25D366;color:#fff;display:flex;align-items:center;justify-content:center;box-shadow:0 12px 28px rgba(0,0,0,.22);z-index:200;transition:transform .2s,box-shadow .2s,background .2s;border:3px solid #fff}
.whatsapp-float:hover{background:#1fbd5b;transform:translateY(-2px);box-shadow:0 16px 34px rgba(0,0,0,.28)}
.whatsapp-float svg{width:32px;height:32px;display:block}
.edit-bar{position:fixed;left:50%;bottom:18px;transform:translateX(-50%);z-index:500;background:#111;color:#fff;border-radius:12px;padding:10px;display:none;gap:8px;align-items:center;box-shadow:0 16px 40px rgba(0,0,0,.26)}
.edit-bar.on{display:flex}.edit-bar span{font-size:12px;color:rgba(255,255,255,.72);font-weight:800}.edit-bar .btn{padding:9px 12px}
.edit-bar.dirty #save-site-btn{animation:savePulse .9s ease-in-out infinite}
.text-toolbar{position:fixed;left:20px;top:20px;z-index:760;background:#111;color:#fff;border-radius:10px;padding:8px;display:none;align-items:center;gap:5px;box-shadow:0 18px 48px rgba(0,0,0,.32)}
.text-toolbar.on{display:flex;flex-wrap:wrap}
.text-toolbar button{width:30px;height:30px;border:1px solid rgba(255,255,255,.16);background:#fff;color:#111;border-radius:6px;font-size:14px;font-weight:900;cursor:pointer;display:inline-flex;align-items:center;justify-content:center}
.text-toolbar button:hover{background:var(--accent);color:var(--accent-text)}
.text-toolbar select,.text-toolbar input{height:30px;border:1px solid rgba(255,255,255,.16);border-radius:6px;background:#fff;color:#111;font-size:12px;font-family:inherit;padding:0 6px}
.text-toolbar input[type="number"]{width:56px}.text-toolbar input[type="color"]{width:34px;padding:2px}
.text-toolbar .sep{width:1px;height:24px;background:rgba(255,255,255,.18);margin:0 3px}
.edit-only{display:none}.editing .edit-only{display:inline-flex}
.editing [data-edit]{outline:2px dashed rgba(255,255,255,.45);outline-offset:5px;border-radius:6px;cursor:text}
.editing .section [data-edit],.editing .post-card [data-edit]{outline-color:rgba(26,58,42,.28)}
.editing [data-edit]:focus{outline-style:solid;background:rgba(255,255,255,.08)}
.edit-add{height:34px;padding:8px 12px}
.edit-block,[data-move-key]{position:relative;will-change:transform}
.editing .edit-block,.editing [data-move-key]{touch-action:none}
.block-tools{display:none;position:absolute;right:10px;top:18px;z-index:130;flex-direction:column;gap:8px}
.editing .block-tools{display:flex}
.block-tools button{width:72px;min-height:40px;border:2px solid #111;border-radius:7px;background:#fff;color:#d65f8e;font-size:11px;font-weight:900;cursor:pointer;box-shadow:4px 4px 0 #111}
.block-tools button:hover{transform:translateY(-1px)}
.editing [data-move-key]{outline:2px dashed rgba(14,165,233,.48);outline-offset:-8px;cursor:grab}
.editing [data-move-key].dragging{cursor:grabbing;z-index:90}
.editing [data-move-key].site-selected{outline:3px solid #EF4444;outline-offset:-8px}
.editing [data-edit],.editing a,.editing button{touch-action:auto}
.site-extra-slot{display:flex;flex-direction:column;gap:14px;margin-top:18px}
.site-extra{background:transparent;max-width:100%;min-width:60px;min-height:34px;resize:both;overflow:hidden}
.site-extra-text{font-size:20px;line-height:1.65;color:inherit}.site-extra-text>div{height:100%;overflow:auto}
.site-extra-image img{display:block;width:100%;height:100%;border-radius:inherit;user-select:none;-webkit-user-drag:none;pointer-events:none}
.site-extra-avatar{display:inline-flex;align-items:center;justify-content:center;width:120px;height:120px}
.site-extra-avatar-circle{width:100%;height:100%;border-radius:50%;background:var(--accent);color:var(--accent-text);display:flex;align-items:center;justify-content:center;font-size:28px;font-weight:900;overflow:hidden}
.site-extra-avatar-circle img{width:100%;height:100%;object-fit:cover;display:block}
.site-modal-bg{position:fixed;inset:0;background:rgba(17,17,17,.42);z-index:700;display:none;align-items:center;justify-content:center;padding:18px}
.site-modal-bg.on{display:flex}
.site-modal{width:min(980px,96vw);max-height:92vh;overflow:auto;background:#fff;color:#111;border-radius:14px;box-shadow:0 28px 80px rgba(0,0,0,.32);padding:20px}
.site-modal-head{display:flex;align-items:center;justify-content:space-between;gap:16px;margin-bottom:16px}
.site-modal-head strong{font-size:17px}.site-modal-close{border:0;background:#f2f2f2;border-radius:8px;width:34px;height:34px;font-size:20px;cursor:pointer}
.site-modal-grid{display:grid;grid-template-columns:minmax(0,1fr) minmax(300px,.92fr);gap:18px}
.site-modal label{display:block;font-size:12px;font-weight:900;color:#333;margin:0 0 6px}.site-modal input,.site-modal textarea,.site-modal select{width:100%;border:1px solid #d8d8d8;border-radius:8px;padding:11px 12px;font:inherit;font-size:14px;margin-bottom:12px}
.site-modal textarea{min-height:92px;resize:vertical}.site-modal-actions{display:flex;justify-content:flex-end;gap:10px;margin-top:8px}
.site-preview-box{background:#f8f7f4;border:1px solid #e5e1db;border-radius:12px;padding:16px;min-height:260px}.site-preview-box .card,.site-preview-box .post-card{box-shadow:0 12px 30px rgba(0,0,0,.06)}
.site-modal-alert{display:none;margin-top:10px;background:#fff2f2;color:#b91c1c;border:1px solid #fecaca;border-radius:8px;padding:10px 12px;font-size:13px;font-weight:700}
@keyframes savePulse{0%,100%{box-shadow:0 0 0 0 rgba(197,241,53,.55);transform:translateY(0)}50%{box-shadow:0 0 0 7px rgba(197,241,53,0);transform:translateY(-1px)}}
${blockOrderCss}
@media(max-width:860px){.hero{grid-template-columns:1fr}.hero.profile-left .profile,.hero.profile-left .hero-copy{grid-column:auto;grid-row:auto}.grid,.content-grid{grid-template-columns:1fr}.site-carousel{padding:0 36px}.site-carousel .carousel-track{scroll-padding:0 36px}.site-carousel .card,.site-carousel .post-card{flex:0 0 min(100%,320px);scroll-snap-align:center}.carousel-prev{left:0}.carousel-next{right:0}.section-head{display:block}.nav-actions .nav-link{display:none}.edit-bar{left:12px;right:12px;transform:none;flex-wrap:wrap;justify-content:center}.site-modal-grid{grid-template-columns:1fr}}
</style>
</head>
<body>
<nav class="nav">
  <a class="brand" href="${sitePath}"><span class="mark">${esc(layout.header_label || defaultCms().layout.header_label)}</span><span>${esc(site.nome_prof)}</span></a>
  <div class="nav-actions">
    <a class="nav-link" href="#turmas">Turmas</a>
    ${isHidden('block:video_courses') ? '' : '<a class="nav-link" href="#cursos-video">Cursos em vídeo</a>'}
    ${isHidden('block:conteudos') ? '' : '<a class="nav-link" href="#conteudos">Conteúdos</a>'}
    <a class="btn btn-light" href="${loginUrl}">Entrar</a>
  </div>
</nav>

<main class="site-blocks" id="site-blocks">
<section class="hero ${profileSide} edit-block reveal" id="hero" data-block="hero" data-move-key="block:hero"${moveStyle('block:hero')}>
  ${blockTools('hero')}
  <div class="hero-copy" data-move-key="hero:text"${moveStyle('hero:text')}>
    <div class="eyebrow" data-edit="layout.eyebrow"${editableStyle('layout.eyebrow')}>${esc(heroEyebrow)}</div>
    <h1 data-edit="layout.hero_title"${editableStyle('layout.hero_title')}>${esc(layout.hero_title)}</h1>
    <p data-edit="site.bio_prof"${editableStyle('site.bio_prof')}>${esc(site.bio_prof || 'Turmas, materiais e correções organizadas em uma área própria para alunos.')}</p>
    <div class="hero-actions">
      <a class="btn btn-accent" href="${loginUrl}&signup=1" data-edit="layout.cta_text"${editableStyle('layout.cta_text')}>${esc(layout.cta_text)}</a>
    </div>
    <div class="site-extra-slot" data-extra-slot="hero">${extraHtml('hero')}</div>
  </div>
  ${profilePhotoMode ? `<aside class="profile photo-only" data-move-key="hero:profile"${moveStyle('hero:profile')}>
    <img class="profile-photo-main" src="${esc(profilePhoto)}" alt="Foto de ${esc(site.nome_prof)}">
  </aside>` : `<aside class="profile" data-move-key="hero:profile"${moveStyle('hero:profile')}>
    ${!isHidden('hero:avatar') ? `<div class="avatar" data-move-key="hero:avatar"${moveStyle('hero:avatar')}>${layout.avatar_image ? `<img src="${esc(layout.avatar_image)}" alt="Avatar">` : esc(layout.avatar_text || (site.nome_prof || 'PR').slice(0, 2).toUpperCase())}</div>` : ''}
    <h2 data-edit="site.nome_prof"${editableStyle('site.nome_prof')}>${esc(site.nome_prof)}</h2>
    <p data-edit="layout.profile_text"${editableStyle('layout.profile_text')}>${esc(profileText)}</p>
  </aside>`}
</section>

<section class="section edit-block reveal" id="turmas" data-block="turmas" data-move-key="block:turmas"${moveStyle('block:turmas')}>
  ${blockTools('turmas')}
  <div class="section-head">
    <div>
      <div class="tag">Turmas abertas</div>
      <div class="title" data-edit="layout.turmas_title"${editableStyle('layout.turmas_title')}>${esc(layout.turmas_title)}</div>
      <div class="sub" data-edit="layout.turmas_subtitle"${editableStyle('layout.turmas_subtitle')}>${esc(layout.turmas_subtitle)}</div>
    </div>
    <div style="display:flex;gap:10px;flex-wrap:wrap">
      <button type="button" class="btn btn-accent edit-only edit-add" onclick="addTurmaFromSite()">+ Turma</button>
      <a class="btn btn-dark" href="${loginUrl}">Acessar plataforma</a>
    </div>
  </div>
  <div class="site-extra-slot" data-extra-slot="turmas">${extraHtml('turmas')}</div>
  ${carouselStart('turmas', turmas.length > 3)}
    ${turmas.length ? turmas.map((t) => {
      const settings = turmaSettings[t.id] || {}
      const image = String(settings.imagem_url || '')
      return `
      <article class="card reveal" data-move-key="turma:${esc(t.id)}"${moveStyle(`turma:${t.id}`)}>
        <a class="course-cover" href="${turmaUrl(t.id)}" aria-label="Ver detalhes de ${esc(t.nome)}">
          ${image ? `<img src="${esc(image)}" alt="${esc(t.nome)}">` : `<div class="course-cover-placeholder">${esc(String(t.nome || 'TR').slice(0, 2).toUpperCase())}</div>`}
        </a>
        <div class="meta">${esc(t.concurso)} · ${esc(t.status)}</div>
        <h3>${esc(t.nome)}</h3>
        <div class="desc">${esc(t.descricao || 'Acompanhamento, proposta de temas e correção individual.')}</div>
        <div class="price">${moneyBR(t.preco)}</div>
        <a class="course-card-link" href="${turmaUrl(t.id)}"><span>Ver detalhes</span><span class="course-arrow">↗</span></a>
      </article>
    `}).join('') : `
      <article class="card" data-move-key="turma:empty"${moveStyle('turma:empty')}>
        <div class="meta">Em preparação</div>
        <h3>Novas turmas em breve</h3>
        <div class="desc">O professor ainda esta organizando as primeiras turmas deste site.</div>
        <a class="btn btn-accent" href="${whatsapp}" data-whatsapp-link target="_blank" rel="noopener">Perguntar no WhatsApp</a>
      </article>
    `}
  ${carouselEnd(turmas.length > 3)}
</section>

<section class="section edit-block reveal" id="cursos-video" data-block="video_courses" data-move-key="block:video_courses"${moveStyle('block:video_courses')}>
  ${blockTools('video_courses')}
  <div class="section-head">
    <div>
      <div class="tag">Cursos em vídeo</div>
      <div class="title">${esc(layout.video_courses_title || 'Cursos em vídeo')}</div>
      <div class="sub">${esc(layout.video_courses_intro || 'Aulas gravadas, materiais de apoio e acompanhamento dentro da plataforma.')}</div>
    </div>
    <a class="btn btn-dark" href="${loginUrl}">Entrar na plataforma</a>
  </div>
  <div class="site-extra-slot" data-extra-slot="video_courses">${extraHtml('video_courses')}</div>
  ${carouselStart('video_courses', videoCourses.length > 3)}
    ${videoCourses.length ? videoCourses.map((course: any) => {
      const cover = String(course.cover_url || '')
      const duration = Number(course.duration_hours || 0)
      const lessons = Number(course.lessons_count || 0)
      return `
      <article class="card video-course-card reveal" data-move-key="video:${esc(course.id || course.title)}"${moveStyle(`video:${course.id || course.title}`)}>
        <a class="course-cover" href="${sitePath}/videos/${encodeURIComponent(String(course.id || ''))}" aria-label="Acessar ${esc(course.title || 'Curso em vídeo')}">
          ${cover ? `<img src="${esc(cover)}" alt="${esc(course.title || 'Curso em vídeo')}">` : `<div class="course-cover-placeholder">▶</div>`}
        </a>
        <span class="video-badge">▶ Curso protegido</span>
        <h3>${esc(course.title || 'Curso em vídeo')}</h3>
        <div class="desc">${esc(truncateText(course.summary || course.description || 'Aulas em vídeo com acesso restrito aos alunos matriculados.', 155))}</div>
        <div class="video-meta">
          ${duration > 0 ? `<span>${esc(String(duration).replace('.', ','))}h de aulas</span>` : ''}
          ${lessons > 0 ? `<span>${lessons} aula(s)</span>` : ''}
          <span>continua de onde parou</span>
        </div>
        <div class="price">${moneyBR(Number(course.price || 0))}</div>
        <a class="course-card-link" href="${sitePath}/videos/${encodeURIComponent(String(course.id || ''))}"><span>Acessar curso</span><span class="course-arrow">↗</span></a>
      </article>
    `}).join('') : `
      <article class="card video-course-card" data-move-key="video:empty"${moveStyle('video:empty')}>
        <span class="video-badge">▶ Em preparação</span>
        <h3>Cursos em vídeo em breve</h3>
        <div class="desc">O professor ainda está preparando as primeiras aulas gravadas deste site.</div>
        <a class="btn btn-accent" href="${whatsapp}" data-whatsapp-link target="_blank" rel="noopener">Perguntar no WhatsApp</a>
      </article>
    `}
  ${carouselEnd(videoCourses.length > 3)}
</section>

<section class="section edit-block reveal" id="conteudos" data-block="conteudos" data-move-key="block:conteudos"${moveStyle('block:conteudos')}>
  ${blockTools('conteudos')}
  <div class="section-head">
    <div>
      <div class="tag">Conteúdos</div>
      <div class="title" data-edit="layout.posts_title"${editableStyle('layout.posts_title')}>${esc(layout.posts_title)}</div>
      <div class="sub" data-edit="layout.posts_intro"${editableStyle('layout.posts_intro')}>${esc(layout.posts_intro)}</div>
    </div>
    <button type="button" class="btn btn-accent edit-only edit-add" onclick="addPostFromSite()">+ Publicação</button>
  </div>
  <div class="site-extra-slot" data-extra-slot="conteudos">${extraHtml('conteudos')}</div>
  ${carouselStart('posts', posts.length > 3)}
    ${posts.length ? posts.map((post: any) => `
      <article class="post-card reveal" data-move-key="post:${esc(post.id || post.titulo)}"${moveStyle(`post:${post.id || post.titulo}`)}>
        <div class="post-type">${esc(postTypeLabel(post.tipo))}${post.pinned ? ' · Destaque' : ''}</div>
        <h3>${esc(post.titulo)}</h3>
        <p>${esc(truncateText(post.resumo || post.conteudo, 155))}</p>
        ${post.conteudo ? `<div class="post-body">${esc(truncateText(post.conteudo, 95))}</div>` : ''}
        <a class="btn btn-dark read-more" href="${sitePath}/conteudos/${postPublicId(post)}" target="_blank" rel="noopener">Ler completo</a>
      </article>
    `).join('') : `
      <article class="post-card" data-move-key="post:empty"${moveStyle('post:empty')}>
        <div class="post-type">Em preparação</div>
        <h3>Conteúdos em breve</h3>
        <p>O professor ainda está preparando as primeiras publicações deste site.</p>
      </article>
    `}
  ${carouselEnd(posts.length > 3)}
</section>

<section class="section band edit-block reveal" data-block="aluno" data-move-key="block:aluno"${moveStyle('block:aluno')}>
  ${blockTools('aluno')}
  <div class="tag">Área do aluno</div>
  <div class="title" data-edit="layout.aluno_title"${editableStyle('layout.aluno_title')}>${esc(layout.aluno_title)}</div>
  <p data-edit="layout.aluno_text"${editableStyle('layout.aluno_text')}>${esc(layout.aluno_text)}</p>
  <a class="btn btn-dark" href="${loginUrl}" data-edit="layout.aluno_cta"${editableStyle('layout.aluno_cta')}>${esc(layout.aluno_cta)}</a>
  <div class="site-extra-slot" data-extra-slot="aluno">${extraHtml('aluno')}</div>
</section>
</main>

<footer class="edit-block" data-move-key="block:footer"${moveStyle('block:footer')}>${blockTools('footer')}${esc(site.nome_prof)} · Plataforma CursosRedação<div class="site-extra-slot" data-extra-slot="footer">${extraHtml('footer')}</div></footer>
<div class="edit-bar" id="edit-bar">
  <span>Modo edição do professor</span>
  <button type="button" class="btn btn-light" onclick="openSelectedExtraStyle()">Editar selecionado</button>
  <button type="button" class="btn btn-light" title="Trazer para frente" onclick="changeSelectedLayer(1)">⬆</button>
  <button type="button" class="btn btn-light" title="Enviar para trás" onclick="changeSelectedLayer(-1)">⬇</button>
  <button type="button" class="btn btn-light" onclick="deleteSelectedSiteElement()">Excluir selecionado</button>
  <button type="button" class="btn btn-light" onclick="undoSiteChange()">Desfazer</button>
  <button type="button" class="btn btn-light" onclick="setCurrentAsDefaultModel()">Definir modelo como padrão</button>
  <button type="button" class="btn btn-light" onclick="resetSiteToDefault()">Voltar ao padrão</button>
  <button type="button" class="btn btn-light" onclick="editWhatsappNumber()">WhatsApp</button>
  <button type="button" class="btn btn-accent" id="save-site-btn" onclick="saveInlineSite()">Salvar alterações</button>
  <button type="button" class="btn btn-light" onclick="location.href='${sitePath}'">Sair da edição</button>
</div>
<div class="text-toolbar" id="text-toolbar" aria-label="Barra de formatação">
  <select id="tb-font" title="Fonte" onchange="applyTextToolbarValue('font_family',this.value)">
    <option value="Inter, system-ui, sans-serif">Inter</option>
    <option value="Arial, sans-serif">Arial</option>
    <option value="Georgia, serif">Georgia</option>
    <option value="'Times New Roman', serif">Times</option>
    <option value="'Courier New', monospace">Courier</option>
  </select>
  <input id="tb-size" type="number" min="8" max="96" value="16" title="Tamanho" onchange="applyTextToolbarValue('font_size',this.value)">
  <button type="button" title="Negrito" onclick="toggleTextToolbarStyle('font_weight','800','400')">B</button>
  <button type="button" title="Itálico" onclick="toggleTextToolbarStyle('font_style','italic','normal')"><i>I</i></button>
  <button type="button" title="Sublinhado" onclick="toggleTextToolbarStyle('text_decoration','underline','none')"><u>U</u></button>
  <input id="tb-color" type="color" value="#111111" title="Cor da fonte" onchange="applyTextToolbarValue('color',this.value)">
  <span class="sep"></span>
  <button type="button" title="Alinhar à esquerda" onclick="applyTextToolbarValue('text_align','left')">☰</button>
  <button type="button" title="Centralizar" onclick="applyTextToolbarValue('text_align','center')">≡</button>
  <button type="button" title="Alinhar à direita" onclick="applyTextToolbarValue('text_align','right')">☷</button>
  <button type="button" title="Justificar" onclick="applyTextToolbarValue('text_align','justify')">▤</button>
  <span class="sep"></span>
  <button type="button" title="Trazer para frente" onclick="changeSelectedLayer(1)">⬆</button>
  <button type="button" title="Enviar para trás" onclick="changeSelectedLayer(-1)">⬇</button>
</div>
<a class="whatsapp-float" href="${whatsapp}" data-whatsapp-link target="_blank" rel="noopener" aria-label="Falar no WhatsApp">
  <svg viewBox="0 0 32 32" aria-hidden="true">
    <path fill="currentColor" d="M16.02 3.2A12.73 12.73 0 0 0 5.11 22.5L3.2 29l6.68-1.78A12.72 12.72 0 1 0 16.02 3.2Zm0 23.18c-2.05 0-3.96-.6-5.57-1.65l-.4-.25-3.96 1.05 1.06-3.84-.26-.4a10.34 10.34 0 1 1 9.13 5.09Zm5.67-7.75c-.31-.16-1.84-.91-2.13-1.01-.29-.11-.5-.16-.71.15-.21.31-.82 1.01-1 1.22-.18.21-.37.24-.68.08-.31-.16-1.31-.48-2.5-1.54-.92-.82-1.55-1.84-1.73-2.15-.18-.31-.02-.48.14-.64.14-.14.31-.37.47-.55.16-.18.21-.31.31-.52.11-.21.05-.39-.03-.55-.08-.16-.71-1.71-.97-2.34-.25-.61-.51-.52-.71-.53h-.6c-.21 0-.55.08-.84.39-.29.31-1.1 1.08-1.1 2.63s1.13 3.05 1.29 3.26c.16.21 2.23 3.4 5.39 4.76.75.32 1.34.52 1.8.66.76.24 1.45.21 1.99.13.61-.09 1.84-.75 2.1-1.47.26-.72.26-1.34.18-1.47-.08-.13-.29-.21-.6-.37Z"/>
  </svg>
</a>
<div class="site-modal-bg" id="site-edit-modal">
  <div class="site-modal">
    <div class="site-modal-head">
      <strong id="site-modal-title">Adicionar</strong>
      <button type="button" class="site-modal-close" onclick="closeSiteEditModal()">×</button>
    </div>
    <div class="site-modal-grid">
      <form id="site-modal-form" onsubmit="saveSiteModal(event)"></form>
      <aside>
        <label>Prévia no site</label>
        <div class="site-preview-box" id="site-modal-preview"></div>
      </aside>
    </div>
    <div class="site-modal-alert" id="site-modal-alert"></div>
  </div>
</div>
<script>
const SITE_SLUG = ${jsonForScript(site.slug)}
const SITE_PATH = ${jsonForScript(sitePath)}
const INITIAL_CMS = ${jsonForScript(cms)}
const DEFAULT_CMS = ${jsonForScript(defaultCms())}
const DEFAULT_SITE = {
  nome_prof: ${jsonForScript(site.nome_prof || '')},
  bio_prof: '',
  cor_primaria: '#1A3A2A',
  cor_accent: '#C5F135'
}
let inlineCms = JSON.parse(JSON.stringify(INITIAL_CMS))
let inlineSite = {
  nome_prof: ${jsonForScript(site.nome_prof || '')},
  bio_prof: ${jsonForScript(site.bio_prof || '')},
  cor_primaria: ${jsonForScript(brand)},
  cor_accent: ${jsonForScript(accent)},
  theme: ${jsonForScript(theme)}
}
let hasUnsavedChanges = false
let siteModalMode = null
let siteDragState = null
let siteDragReady = false
let resizeObserverReady = false
let undoStack = []
let activeEditKey = null
let selectedSiteMoveKey = null
let editingExtraId = null
let activeTextEl = null

function textOf(selector) {
  const el = document.querySelector(selector)
  return el ? el.innerText.trim() : ''
}

function escHtml(value) {
  return String(value || '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

function postTypeLabelClient(value) {
  return ({ NOTICIA: 'Notícia', MATERIA: 'Matéria', POST: 'Publicação' })[String(value || '').toUpperCase()] || 'Publicação'
}

function setEditables(enabled) {
  document.body.classList.toggle('editing', enabled)
  document.getElementById('edit-bar')?.classList.toggle('on', enabled)
  if (enabled) applySavedBlockOrder()
  if (enabled) enableSiteDragging()
  if (enabled) enableResizeTracking()
  document.querySelectorAll('[data-edit]').forEach(el => {
    el.setAttribute('contenteditable', enabled ? 'true' : 'false')
    el.setAttribute('spellcheck', 'true')
    el.addEventListener('focus', () => {
      beginEditSnapshot(el.dataset.edit)
      showTextToolbar(el)
    })
    el.addEventListener('input', markDirty)
    el.addEventListener('paste', markDirty)
    el.addEventListener('blur', () => setTimeout(() => {
      if (!document.getElementById('text-toolbar')?.matches(':hover') && document.activeElement?.id !== 'tb-size') hideTextToolbar()
      markDirty()
    }, 180))
    el.addEventListener('click', (evt) => {
      if (document.body.classList.contains('editing')) evt.preventDefault()
      showTextToolbar(el)
    })
  })
}

function showTextToolbar(el) {
  activeTextEl = el
  activeEditKey = el.dataset.edit
  const bar = document.getElementById('text-toolbar')
  if (!bar) return
  syncTextToolbarControls(el)
  const rect = el.getBoundingClientRect()
  const top = Math.max(8, rect.top - 46)
  const left = Math.max(8, Math.min(window.innerWidth - 520, rect.left))
  bar.style.top = top + 'px'
  bar.style.left = left + 'px'
  bar.classList.add('on')
}

function hideTextToolbar() {
  document.getElementById('text-toolbar')?.classList.remove('on')
}

function getStoredTextStyle(key) {
  inlineCms.layout = { ...(inlineCms.layout || {}) }
  inlineCms.layout.text_styles = { ...(inlineCms.layout.text_styles || {}) }
  inlineCms.layout.text_styles[key] = { ...(inlineCms.layout.text_styles[key] || {}) }
  return inlineCms.layout.text_styles[key]
}

function syncTextToolbarControls(el) {
  const computed = getComputedStyle(el)
  const font = document.getElementById('tb-font')
  const size = document.getElementById('tb-size')
  const color = document.getElementById('tb-color')
  if (font) font.value = getStoredTextStyle(el.dataset.edit).font_family || 'Inter, system-ui, sans-serif'
  if (size) size.value = String(Math.round(parseFloat(computed.fontSize) || 16))
  if (color) color.value = rgbToHex(computed.color) || '#111111'
}

function rgbToHex(value) {
  const nums = String(value || '').match(/\d+/g)
  if (!nums || nums.length < 3) return ''
  return '#' + nums.slice(0, 3).map(n => Math.max(0, Math.min(255, Number(n))).toString(16).padStart(2, '0')).join('')
}

function applyTextStyleToElement(el, style) {
  if ('font_family' in style) el.style.fontFamily = style.font_family || ''
  if ('font_size' in style) el.style.fontSize = style.font_size ? style.font_size + 'px' : ''
  if ('color' in style) el.style.color = style.color || ''
  if ('font_weight' in style) el.style.fontWeight = style.font_weight || ''
  if ('font_style' in style) el.style.fontStyle = style.font_style === 'italic' ? 'italic' : ''
  if ('text_decoration' in style) el.style.textDecoration = style.text_decoration === 'underline' ? 'underline' : ''
  if ('text_align' in style) el.style.textAlign = style.text_align || ''
  if ('z_index' in style) {
    el.style.position = 'relative'
    el.style.zIndex = String(style.z_index || 0)
  }
}

function selectedExtraBlockFromText() {
  const extra = activeTextEl?.closest('[data-extra-id]')
  if (!extra) return null
  return findExtraBlock(extra.dataset.extraId)
}

function applyTextToolbarValue(key, value) {
  if (!activeTextEl) return
  pushUndoSnapshot('text-toolbar:' + key)
  const extraBlock = selectedExtraBlockFromText()
  if (extraBlock) {
    const host = activeTextEl.closest('[data-extra-id]')
    const blockKey = key === 'color' ? 'text_color' : key
    extraBlock[blockKey] = key === 'font_size' ? Number(value || 0) : value
    if (key === 'font_family') host.style.fontFamily = value || ''
    if (key === 'font_size') host.style.fontSize = value ? value + 'px' : ''
    if (key === 'font_weight') host.style.fontWeight = value || ''
    if (key === 'font_style') host.style.fontStyle = value === 'italic' ? 'italic' : ''
    if (key === 'text_decoration') host.style.textDecoration = value === 'underline' ? 'underline' : ''
    if (key === 'text_align') host.style.textAlign = value || ''
    if (key === 'color') host.style.color = value || ''
  } else {
    const style = getStoredTextStyle(activeTextEl.dataset.edit)
    style[key] = key === 'font_size' ? Number(value || 0) : value
    applyTextStyleToElement(activeTextEl, { [key]: style[key] })
  }
  syncTextToolbarControls(activeTextEl)
  markDirty()
}

function toggleTextToolbarStyle(key, onValue, offValue) {
  if (!activeTextEl) return
  const extraBlock = selectedExtraBlockFromText()
  const current = extraBlock
    ? (key === 'color' ? extraBlock.text_color : extraBlock[key])
    : getStoredTextStyle(activeTextEl.dataset.edit)[key]
  applyTextToolbarValue(key, current === onValue ? offValue : onValue)
}

function changeSelectedLayer(direction) {
  pushUndoSnapshot('layer')
  if (selectedSiteMoveKey?.startsWith('extra:')) {
    const id = selectedSiteMoveKey.replace('extra:', '')
    const block = findExtraBlock(id)
    const el = document.querySelector('[data-extra-id="' + CSS.escape(id) + '"]')
    if (!block || !el) return
    block.z_index = Math.max(0, Math.min(999, Number(block.z_index || 1) + direction))
    el.style.zIndex = String(block.z_index)
    markDirty()
    return
  }
  if (activeTextEl) {
    const style = getStoredTextStyle(activeTextEl.dataset.edit)
    style.z_index = Math.max(0, Math.min(999, Number(style.z_index || 1) + direction))
    applyTextStyleToElement(activeTextEl, { z_index: style.z_index })
    markDirty()
  }
}

function selectSiteElement(el) {
  document.querySelectorAll('[data-move-key].site-selected').forEach(item => item.classList.remove('site-selected'))
  if (!el) { selectedSiteMoveKey = null; return }
  selectedSiteMoveKey = el.dataset.moveKey
  el.classList.add('site-selected')
  showEditorMessage('Elemento selecionado')
}

function clone(value) {
  return JSON.parse(JSON.stringify(value))
}

function captureEditorState() {
  return {
    site: clone(inlineSite),
    cms: clone(inlineCms),
    texts: Array.from(document.querySelectorAll('[data-edit]')).map(el => ({
      key: el.dataset.edit,
      text: el.innerText
    })),
    positions: Array.from(document.querySelectorAll('[data-move-key]')).map(el => ({
      key: el.dataset.moveKey,
      x: Number(el.dataset.moveX || 0),
      y: Number(el.dataset.moveY || 0)
    }))
  }
}

function pushUndoSnapshot(reason = '') {
  const snap = captureEditorState()
  const last = undoStack[undoStack.length - 1]
  if (last && JSON.stringify(last) === JSON.stringify(snap)) return
  undoStack.push(snap)
  if (undoStack.length > 60) undoStack.shift()
}

function beginEditSnapshot(key) {
  if (activeEditKey === key) return
  activeEditKey = key
  pushUndoSnapshot('text:' + key)
}

function applyEditorState(state) {
  if (!state) return
  inlineSite = clone(state.site)
  inlineCms = clone(state.cms)
  state.texts.forEach(item => {
    const el = document.querySelector('[data-edit="' + item.key + '"]')
    if (el) el.innerText = item.text
  })
  document.querySelectorAll('[data-move-key]').forEach(el => {
    el.dataset.moveX = '0'
    el.dataset.moveY = '0'
    el.style.transform = ''
  })
  state.positions.forEach(item => {
    const el = document.querySelector('[data-move-key="' + CSS.escape(item.key) + '"]')
    if (el) setMovePosition(el, item.x, item.y)
  })
  applyRuntimeTextStyles()
  updateRuntimeSiteChrome()
}

function updateRuntimeSiteChrome() {
  const theme = inlineCms.theme || inlineSite.theme || {}
  document.documentElement.style.setProperty('--brand', theme.primary || inlineSite.cor_primaria || '#1A3A2A')
  document.documentElement.style.setProperty('--brand-text', theme.primaryText || '#FFFFFF')
  document.documentElement.style.setProperty('--accent', theme.accent || inlineSite.cor_accent || '#C5F135')
  document.documentElement.style.setProperty('--accent-text', theme.accentText || '#1A2A00')
  document.documentElement.style.setProperty('--surface', theme.background || '#F8F7F4')
  document.documentElement.style.setProperty('--card', theme.card || '#FFFFFF')
  document.documentElement.style.setProperty('--border', theme.border || '#E8E5E0')
  document.documentElement.style.setProperty('--ink', theme.text || '#111111')
  document.documentElement.style.setProperty('--ink2', theme.textSoft || '#3A3A3A')
  document.documentElement.style.setProperty('--ink3', theme.textMuted || '#787878')
  const phone = String(inlineCms.contact?.whatsapp_phone || '5521971214042').replace(/\D/g, '') || '5521971214042'
  const href = 'http://api.whatsapp.com/send?phone=' + phone
  document.querySelectorAll('.whatsapp-float,[data-whatsapp-link]').forEach(link => link.href = href)
}

function applyRuntimeTextStyles() {
  const styles = inlineCms.layout?.text_styles || {}
  document.querySelectorAll('[data-edit]').forEach(el => {
    const style = styles[el.dataset.edit] || {}
    applyTextStyleToElement(el, style)
  })
}

function undoSiteChange() {
  activeEditKey = null
  const previous = undoStack.pop()
  if (!previous) {
    clearDirty('Nada para desfazer')
    setTimeout(() => { if (!hasUnsavedChanges) clearDirty('Modo edição do professor') }, 1400)
    return
  }
  applyEditorState(previous)
  markDirty()
  const label = document.querySelector('#edit-bar span')
  if (label) label.textContent = undoStack.length ? 'Alteração desfeita' : 'Voltou ao início da edição'
}

async function resetSiteToDefault() {
  const ok = confirm('Isso vai voltar o site ao padrão inicial de quando ele foi criado. Publicações, textos editados, posições movidas, cores e WhatsApp personalizado serão removidos. Deseja continuar?')
  if (!ok) return
  pushUndoSnapshot('reset-default')
  const savedDefault = inlineCms.model_default ? clone(inlineCms.model_default) : clone(DEFAULT_CMS)
  const savedDefaultSite = inlineCms.model_default_site ? clone(inlineCms.model_default_site) : clone(DEFAULT_SITE)
  inlineCms = savedDefault
  inlineCms.model_default = clone(savedDefault)
  inlineCms.model_default_site = clone(savedDefaultSite)
  inlineSite = savedDefaultSite
  const res = await fetch('/api/admin/site', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...inlineSite, cms: inlineCms })
  })
  if (!res.ok) {
    showEditorMessage('Erro ao voltar ao padrão')
    return
  }
  location.href = SITE_PATH
}

async function setCurrentAsDefaultModel() {
  if (!confirm('Definir o modelo atual como padrão deste professor? Depois, Voltar ao padrão retornará para este modelo.')) return
  const payload = collectInlineSite()
  const model = clone(payload.cms)
  delete model.model_default
  delete model.model_default_site
  inlineCms.model_default = model
  inlineCms.model_default_site = clone(payload)
  delete inlineCms.model_default_site.cms
  const res = await fetch('/api/admin/site', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...payload, cms: inlineCms })
  })
  if (!res.ok) {
    showEditorMessage('Erro ao definir padrão')
    return
  }
  clearDirty('Modelo padrão atualizado')
}

function showEditorMessage(message) {
  const label = document.querySelector('#edit-bar span')
  if (label) label.textContent = message
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max)
}

function movableBoundaryFor(el) {
  if (el.dataset.block) return document.getElementById('site-blocks') || document.body
  if (el.classList.contains('site-extra')) return el.closest('[data-block],footer') || el.parentElement || document.body
  return el.parentElement || document.getElementById('site-blocks') || document.body
}

function setMovePosition(el, x, y) {
  el.dataset.moveX = String(Math.round(x))
  el.dataset.moveY = String(Math.round(y))
  el.style.transform = 'translate(' + Math.round(x) + 'px,' + Math.round(y) + 'px)'
}

function applySavedPositions() {
  const positions = inlineCms.layout?.positions || {}
  document.querySelectorAll('[data-move-key]').forEach(el => {
    const pos = positions[el.dataset.moveKey] || {}
    const x = Number(pos.x || 0)
    const y = Number(pos.y || 0)
    if (Number.isFinite(x) && Number.isFinite(y)) setMovePosition(el, x, y)
  })
}

function persistCurrentPositions() {
  const positions = {}
  document.querySelectorAll('[data-move-key]').forEach(el => {
    const x = Number(el.dataset.moveX || 0)
    const y = Number(el.dataset.moveY || 0)
    if (x || y) positions[el.dataset.moveKey] = { x: Math.round(x), y: Math.round(y) }
  })
  inlineCms.layout = { ...(inlineCms.layout || {}), positions }
}

function enableSiteDragging() {
  applySavedPositions()
  if (siteDragReady) return
  siteDragReady = true
  document.addEventListener('click', (evt) => {
    if (!document.body.classList.contains('editing')) return
    if (evt.target.closest('button,input,textarea,select,.site-modal-bg,.edit-bar')) return
    const el = evt.target.closest('[data-move-key]')
    if (el) selectSiteElement(el)
  })
  document.addEventListener('pointerdown', startSiteDrag)
  document.addEventListener('pointermove', moveSiteDrag)
  document.addEventListener('pointerup', endSiteDrag)
  document.addEventListener('pointercancel', endSiteDrag)
}

function enableResizeTracking() {
  if (resizeObserverReady || !window.ResizeObserver) return
  resizeObserverReady = true
  const observer = new ResizeObserver(entries => {
    if (!document.body.classList.contains('editing')) return
    const realResize = entries.some(entry => entry.target.matches('.site-extra'))
    if (realResize) markDirty()
  })
  document.querySelectorAll('.site-extra').forEach(el => observer.observe(el))
}

function startSiteDrag(evt) {
  if (!document.body.classList.contains('editing')) return
  if (evt.button !== undefined && evt.button !== 0) return
  if (evt.target.closest('[data-edit],button,a,input,textarea,select,.site-modal-bg,.edit-bar')) return
  const el = evt.target.closest('[data-move-key]')
  if (!el) return
  if (el.classList.contains('site-extra')) {
    const box = el.getBoundingClientRect()
    if (evt.clientX > box.right - 20 && evt.clientY > box.bottom - 20) return
  }
  selectSiteElement(el)
  activeEditKey = null
  pushUndoSnapshot('drag:' + el.dataset.moveKey)
  const bounds = movableBoundaryFor(el).getBoundingClientRect()
  const rect = el.getBoundingClientRect()
  const startX = Number(el.dataset.moveX || 0)
  const startY = Number(el.dataset.moveY || 0)
  siteDragState = {
    el,
    pointerId: evt.pointerId,
    originClientX: evt.clientX,
    originClientY: evt.clientY,
    startX,
    startY,
    minX: startX + bounds.left - rect.left,
    maxX: startX + bounds.right - rect.right,
    minY: startY + bounds.top - rect.top,
    maxY: startY + bounds.bottom - rect.bottom,
    moved: false
  }
  el.classList.add('dragging')
  el.setPointerCapture?.(evt.pointerId)
  evt.preventDefault()
}

function moveSiteDrag(evt) {
  const drag = siteDragState
  if (!drag || evt.pointerId !== drag.pointerId) return
  const nextX = clamp(drag.startX + evt.clientX - drag.originClientX, drag.minX, drag.maxX)
  const nextY = clamp(drag.startY + evt.clientY - drag.originClientY, drag.minY, drag.maxY)
  setMovePosition(drag.el, nextX, nextY)
  if (Math.abs(nextX - drag.startX) > 2 || Math.abs(nextY - drag.startY) > 2) drag.moved = true
}

function endSiteDrag(evt) {
  const drag = siteDragState
  if (!drag || evt.pointerId !== drag.pointerId) return
  drag.el.classList.remove('dragging')
  drag.el.releasePointerCapture?.(evt.pointerId)
  if (drag.moved) {
    persistCurrentPositions()
    markDirty()
  }
  siteDragState = null
}

function editWhatsappNumber() {
  const current = String(inlineCms.contact?.whatsapp_phone || '').replace(/\D/g, '')
  const next = prompt('WhatsApp com DDD e país. Ex: 5521971214042', current)
  if (next === null) return
  const digits = String(next).replace(/\D/g, '')
  if (digits.length < 10) {
    alert('Informe DDD e número. Ex: 5521971214042')
    return
  }
  pushUndoSnapshot('whatsapp')
  inlineCms.contact = { ...(inlineCms.contact || {}), whatsapp_phone: digits }
  const href = 'http://api.whatsapp.com/send?phone=' + digits
  document.querySelectorAll('.whatsapp-float,[data-whatsapp-link]').forEach(link => link.href = href)
  markDirty()
}

function applySavedBlockOrder() {
  const wrap = document.getElementById('site-blocks')
  const order = Array.isArray(inlineCms.layout?.block_order) ? inlineCms.layout.block_order : ['hero','video_courses','turmas','conteudos','aluno']
  order.forEach(id => {
    const block = document.querySelector('[data-block="' + id + '"]')
    if (wrap && block) wrap.appendChild(block)
  })
}

function markDirty() {
  if (document.activeElement?.dataset?.edit) activeEditKey = document.activeElement.dataset.edit
  hasUnsavedChanges = true
  const bar = document.getElementById('edit-bar')
  bar?.classList.add('dirty')
  const label = bar?.querySelector('span')
  if (label) label.textContent = 'Alterações pendentes'
}

function clearDirty(message = 'Salvo') {
  hasUnsavedChanges = false
  activeEditKey = null
  const bar = document.getElementById('edit-bar')
  bar?.classList.remove('dirty')
  const label = bar?.querySelector('span')
  if (label) label.textContent = message
}

async function bootProfessorEditMode() {
  const params = new URLSearchParams(location.search)
  if (params.get('edit') !== '1') return
  params.delete('edit')
  const clean = location.pathname + (params.toString() ? '?' + params.toString() : '') + location.hash
  history.replaceState(null, '', clean)
  return
  const meRes = await fetch('/api/auth/me')
  if (!meRes.ok) return
  const me = await meRes.json()
  if (!['ADMIN','CORRETOR','SUPERADMIN'].includes(me.role)) return
  const siteRes = await fetch('/api/admin/site')
  if (!siteRes.ok) return
  const site = await siteRes.json()
  if (me.role !== 'SUPERADMIN' && site.slug !== SITE_SLUG) return
  inlineCms = site.cms || inlineCms
  inlineSite = {
    nome_prof: site.nome_prof || inlineSite.nome_prof,
    bio_prof: site.bio_prof || inlineSite.bio_prof,
    cor_primaria: site.cor_primaria || inlineSite.cor_primaria,
    cor_accent: site.cor_accent || inlineSite.cor_accent
  }
  setEditables(true)
  clearDirty('Modo edição do professor')
}

function collectInlineSite() {
  activeEditKey = null
  const layout = { ...(inlineCms.layout || {}) }
  document.querySelectorAll('[data-edit^="layout."]').forEach(el => {
    layout[el.dataset.edit.replace('layout.', '')] = el.innerText.trim()
  })
  inlineSite.nome_prof = textOf('[data-edit="site.nome_prof"]') || inlineSite.nome_prof
  inlineSite.bio_prof = textOf('[data-edit="site.bio_prof"]') || inlineSite.bio_prof
  const extraBlocks = Array.isArray(layout.extra_blocks) ? layout.extra_blocks : []
  extraBlocks.forEach(block => {
    const box = document.querySelector('[data-extra-id="' + CSS.escape(block.id) + '"]')
    if (block?.type === 'text' || block?.type === 'avatar') {
      const txt = textOf('[data-edit="extra.' + CSS.escape(block.id) + '.text"]')
      if (txt) block.text = txt
    }
    if (box?.parentElement) {
      block.width = Math.max(10, Math.min(100, Math.round((box.offsetWidth / box.parentElement.clientWidth) * 100)))
      block.height = Math.max(0, Math.round(box.offsetHeight || 0))
    }
  })
  inlineCms.layout = layout
  persistCurrentPositions()
  return { ...inlineSite, cms: inlineCms }
}

async function saveInlineSite() {
  const bar = document.getElementById('edit-bar')
  const old = bar.querySelector('span').textContent
  bar.querySelector('span').textContent = 'Salvando...'
  const res = await fetch('/api/admin/site', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(collectInlineSite())
  })
  if (res.ok) {
    clearDirty('Salvo')
    setTimeout(() => { if (!hasUnsavedChanges) clearDirty('Modo edição do professor') }, 1800)
  } else {
    bar.querySelector('span').textContent = 'Erro ao salvar'
    setTimeout(() => { bar.querySelector('span').textContent = old }, 1800)
  }
}

function currentBlockOrder() {
  return Array.from(document.querySelectorAll('[data-block]')).map(el => el.dataset.block)
}

function persistBlockOrder() {
  inlineCms.layout = { ...(inlineCms.layout || {}), block_order: currentBlockOrder() }
}

function addTextFromSite(target = 'hero') {
  siteModalMode = 'extra-text'
  editingExtraId = null
  document.getElementById('site-modal-title').textContent = 'Novo texto'
  document.getElementById('site-modal-alert').style.display = 'none'
  document.getElementById('site-modal-form').innerHTML =
    blockTargetSelectHtml(target) +
    '<label>Texto</label>' +
    '<textarea id="modal-extra-text" placeholder="Digite o texto que será inserido no site"></textarea>' +
    extraStyleFieldsHtml({ font_size: 20, text_color: '', background_color: '', border_width: 0, border_radius: 8, padding: 0, text_align: 'left', font_weight: '400' }) +
    '<div class="site-modal-actions">' +
    '<button type="button" class="btn btn-light" onclick="closeSiteEditModal()">Cancelar</button>' +
    '<button type="submit" class="btn btn-accent">Inserir texto</button>' +
    '</div>'
  bindSiteModalPreview()
  updateSiteModalPreview()
  document.getElementById('site-edit-modal').classList.add('on')
  document.getElementById('modal-extra-text').focus()
}

function addImageFromSite(target = 'hero') {
  siteModalMode = 'extra-image'
  editingExtraId = null
  document.getElementById('site-modal-title').textContent = 'Nova imagem'
  document.getElementById('site-modal-alert').style.display = 'none'
  document.getElementById('site-modal-form').innerHTML =
    blockTargetSelectHtml(target) +
    '<label>URL da imagem</label>' +
    '<input id="modal-extra-image" placeholder="https://...">' +
    '<label>Ou carregar imagem</label>' +
    '<input id="modal-extra-file" type="file" accept="image/*">' +
    '<label>Descrição da imagem</label>' +
    '<input id="modal-extra-alt" placeholder="Descrição curta">' +
    extraStyleFieldsHtml({ height: 220, border_width: 0, border_radius: 12, padding: 0, object_fit: 'cover' }) +
    '<div class="site-modal-actions">' +
    '<button type="button" class="btn btn-light" onclick="closeSiteEditModal()">Cancelar</button>' +
    '<button type="submit" class="btn btn-accent">Inserir imagem</button>' +
    '</div>'
  bindSiteModalPreview()
  updateSiteModalPreview()
  document.getElementById('site-edit-modal').classList.add('on')
  document.getElementById('modal-extra-image').focus()
}

function addAvatarFromSite(target = 'hero') {
  siteModalMode = 'extra-avatar'
  editingExtraId = null
  document.getElementById('site-modal-title').textContent = 'Novo avatar'
  document.getElementById('site-modal-alert').style.display = 'none'
  document.getElementById('site-modal-form').innerHTML =
    blockTargetSelectHtml(target) +
    '<label>Texto do avatar</label>' +
    '<input id="modal-extra-text" maxlength="8" value="PR">' +
    '<label>URL de imagem para o avatar</label>' +
    '<input id="modal-extra-image" placeholder="https://...">' +
    '<label>Ou carregar imagem</label>' +
    '<input id="modal-extra-file" type="file" accept="image/*">' +
    extraStyleFieldsHtml({ width: 22, height: 120, font_size: 28, border_width: 0, border_radius: 80, padding: 0, font_weight: '900', text_align: 'center' }) +
    '<div class="site-modal-actions">' +
    '<button type="button" class="btn btn-light" onclick="closeSiteEditModal()">Cancelar</button>' +
    '<button type="submit" class="btn btn-accent">Inserir avatar</button>' +
    '</div>'
  bindSiteModalPreview()
  updateSiteModalPreview()
  document.getElementById('site-edit-modal').classList.add('on')
  document.getElementById('modal-extra-text').focus()
}

function blockTargetSelectHtml(selectedTarget = 'hero') {
  function opt(value, label) {
    return '<option value="' + value + '"' + (selectedTarget === value ? ' selected' : '') + '>' + label + '</option>'
  }
  return '<label>Bloco do site</label>' +
    '<select id="modal-extra-target">' +
    opt('hero', 'Cabeçalho') +
    opt('turmas', 'Escolha a turma') +
    opt('conteudos', 'Postagens') +
    opt('aluno', 'Área do aluno / links úteis') +
    opt('footer', 'Rodapé') +
    '</select>'
}

function extraStyleFieldsHtml(values = {}) {
  function v(key, fallback = '') {
    return escHtml(values[key] === undefined || values[key] === null ? fallback : values[key])
  }
  return '<div style="display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px">' +
    '<div><label>Largura (%)</label><input id="modal-extra-width" type="number" min="10" max="100" value="' + v('width', 100) + '"></div>' +
    '<div><label>Altura (px)</label><input id="modal-extra-height" type="number" min="0" max="900" value="' + v('height', '') + '" placeholder="automática"></div>' +
    '<div><label>Tamanho da fonte</label><input id="modal-extra-font-size" type="number" min="8" max="96" value="' + v('font_size', '') + '" placeholder="padrão"></div>' +
    '<div><label>Peso da fonte</label><select id="modal-extra-font-weight">' +
      '<option value=""' + (!values.font_weight ? ' selected' : '') + '>Padrão</option>' +
      '<option value="400"' + (String(values.font_weight) === '400' ? ' selected' : '') + '>Normal</option>' +
      '<option value="700"' + (String(values.font_weight) === '700' ? ' selected' : '') + '>Negrito</option>' +
      '<option value="900"' + (String(values.font_weight) === '900' ? ' selected' : '') + '>Extra forte</option>' +
    '</select></div>' +
    '<div><label>Fonte</label><select id="modal-extra-font-family">' +
      '<option value="Inter, system-ui, sans-serif"' + ((values.font_family || '').includes('Inter') ? ' selected' : '') + '>Inter</option>' +
      '<option value="Arial, sans-serif"' + ((values.font_family || '') === 'Arial, sans-serif' ? ' selected' : '') + '>Arial</option>' +
      '<option value="Georgia, serif"' + ((values.font_family || '') === 'Georgia, serif' ? ' selected' : '') + '>Georgia</option>' +
      '<option value="Courier New, monospace"' + ((values.font_family || '') === 'Courier New, monospace' ? ' selected' : '') + '>Courier</option>' +
    '</select></div>' +
    '<div><label>Estilo</label><select id="modal-extra-font-style">' +
      '<option value=""' + (!values.font_style ? ' selected' : '') + '>Normal</option>' +
      '<option value="italic"' + (values.font_style === 'italic' ? ' selected' : '') + '>Itálico</option>' +
    '</select></div>' +
    '<div><label>Sublinhado</label><select id="modal-extra-decoration">' +
      '<option value=""' + (!values.text_decoration ? ' selected' : '') + '>Não</option>' +
      '<option value="underline"' + (values.text_decoration === 'underline' ? ' selected' : '') + '>Sim</option>' +
    '</select></div>' +
    '<div><label>Cor do texto</label><input id="modal-extra-text-color" type="color" value="' + v('text_color', '#111111') + '"></div>' +
    '<div><label>Cor de fundo</label><input id="modal-extra-bg-color" type="color" value="' + v('background_color', '#FFFFFF') + '"></div>' +
    '<div><label>Cor da borda</label><input id="modal-extra-border-color" type="color" value="' + v('border_color', '#E8E5E0') + '"></div>' +
    '<div><label>Espessura borda</label><input id="modal-extra-border-width" type="number" min="0" max="24" value="' + v('border_width', 0) + '"></div>' +
    '<div><label>Arredondamento</label><input id="modal-extra-border-radius" type="number" min="0" max="80" value="' + v('border_radius', 0) + '"></div>' +
    '<div><label>Espaçamento interno</label><input id="modal-extra-padding" type="number" min="0" max="80" value="' + v('padding', 0) + '"></div>' +
    '<div><label>Alinhamento</label><select id="modal-extra-text-align">' +
      '<option value="left"' + ((values.text_align || 'left') === 'left' ? ' selected' : '') + '>Esquerda</option>' +
      '<option value="center"' + (values.text_align === 'center' ? ' selected' : '') + '>Centro</option>' +
      '<option value="right"' + (values.text_align === 'right' ? ' selected' : '') + '>Direita</option>' +
      '<option value="justify"' + (values.text_align === 'justify' ? ' selected' : '') + '>Justificado</option>' +
    '</select></div>' +
    '<div><label>Encaixe da imagem</label><select id="modal-extra-object-fit">' +
      '<option value="cover"' + ((values.object_fit || 'cover') === 'cover' ? ' selected' : '') + '>Preencher</option>' +
      '<option value="contain"' + (values.object_fit === 'contain' ? ' selected' : '') + '>Conter</option>' +
      '<option value="fill"' + (values.object_fit === 'fill' ? ' selected' : '') + '>Esticar</option>' +
    '</select></div>' +
    '<div><label>Camada</label><input id="modal-extra-z-index" type="number" min="0" max="999" value="' + v('z_index', 1) + '"></div>' +
    '</div>'
}

function readExtraStyleFromModal() {
  function num(id, fallback = 0) {
    const value = Number(document.getElementById(id)?.value || fallback)
    return Number.isFinite(value) ? value : fallback
  }
  function value(id) {
    return document.getElementById(id)?.value || ''
  }
  return {
    width: Math.max(10, Math.min(100, num('modal-extra-width', 100))),
    height: Math.max(0, Math.min(900, num('modal-extra-height', 0))),
    font_size: Math.max(0, Math.min(96, num('modal-extra-font-size', 0))),
    font_weight: value('modal-extra-font-weight'),
    font_family: value('modal-extra-font-family'),
    font_style: value('modal-extra-font-style'),
    text_decoration: value('modal-extra-decoration'),
    text_color: value('modal-extra-text-color'),
    background_color: value('modal-extra-bg-color'),
    border_color: value('modal-extra-border-color'),
    border_width: Math.max(0, Math.min(24, num('modal-extra-border-width', 0))),
    border_radius: Math.max(0, Math.min(80, num('modal-extra-border-radius', 0))),
    padding: Math.max(0, Math.min(80, num('modal-extra-padding', 0))),
    text_align: value('modal-extra-text-align'),
    object_fit: value('modal-extra-object-fit'),
    z_index: Math.max(0, Math.min(999, num('modal-extra-z-index', 1)))
  }
}

function modalExtraStyleAttr() {
  const s = readExtraStyleFromModal()
  let css = 'width:' + s.width + '%;'
  if (s.height) css += 'height:' + s.height + 'px;overflow:hidden;'
  if (s.font_size) css += 'font-size:' + s.font_size + 'px;'
  if (s.font_weight) css += 'font-weight:' + s.font_weight + ';'
  if (s.font_family) css += 'font-family:' + s.font_family + ';'
  if (s.font_style === 'italic') css += 'font-style:italic;'
  if (s.text_decoration === 'underline') css += 'text-decoration:underline;'
  if (s.text_color) css += 'color:' + s.text_color + ';'
  if (s.background_color) css += 'background:' + s.background_color + ';'
  if (s.border_width) css += 'border:' + s.border_width + 'px solid ' + (s.border_color || 'currentColor') + ';'
  if (s.border_radius) css += 'border-radius:' + s.border_radius + 'px;'
  if (s.padding) css += 'padding:' + s.padding + 'px;'
  if (s.text_align) css += 'text-align:' + s.text_align + ';'
  if (s.z_index) css += 'z-index:' + s.z_index + ';position:relative;'
  return css
}

function findExtraBlock(id) {
  const list = Array.isArray(inlineCms.layout?.extra_blocks) ? inlineCms.layout.extra_blocks : []
  return list.find(block => block.id === id)
}

function openSelectedExtraStyle() {
  if (!selectedSiteMoveKey || !selectedSiteMoveKey.startsWith('extra:')) {
    showEditorMessage('Selecione um texto, imagem ou avatar inserido')
    return
  }
  const id = selectedSiteMoveKey.replace('extra:', '')
  const block = findExtraBlock(id)
  if (!block) {
    showEditorMessage('Item selecionado não encontrado')
    return
  }
  siteModalMode = 'extra-style'
  editingExtraId = id
  document.getElementById('site-modal-title').textContent = 'Editar item selecionado'
  document.getElementById('site-modal-alert').style.display = 'none'
  const contentFields = block.type === 'image'
    ? '<label>URL da imagem</label><input id="modal-extra-image" value="' + escHtml(block.src || '') + '"><label>Descrição</label><input id="modal-extra-alt" value="' + escHtml(block.alt || '') + '">'
    : '<label>Texto</label><textarea id="modal-extra-text">' + escHtml(block.text || 'PR') + '</textarea>' + (block.type === 'avatar' ? '<label>URL de imagem para o avatar</label><input id="modal-extra-image" value="' + escHtml(block.src || '') + '">' : '')
  document.getElementById('site-modal-form').innerHTML =
    blockTargetSelectHtml(block.target || 'hero') +
    contentFields +
    extraStyleFieldsHtml(block) +
    '<div class="site-modal-actions">' +
    '<button type="button" class="btn btn-light" onclick="closeSiteEditModal()">Cancelar</button>' +
    '<button type="submit" class="btn btn-accent">Aplicar alterações</button>' +
    '</div>'
  bindSiteModalPreview()
  updateSiteModalPreview()
  document.getElementById('site-edit-modal').classList.add('on')
}

function editAvatarFromSite() {
  siteModalMode = 'avatar'
  document.getElementById('site-modal-title').textContent = 'Editar avatar'
  document.getElementById('site-modal-alert').style.display = 'none'
  document.getElementById('site-modal-form').innerHTML =
    '<label>Texto do círculo</label>' +
    '<input id="modal-avatar-text" maxlength="4" value="' + escHtml(inlineCms.layout?.avatar_text || 'PR') + '">' +
    '<label>URL de imagem para substituir o círculo</label>' +
    '<input id="modal-avatar-image" placeholder="https://..." value="' + escHtml(inlineCms.layout?.avatar_image || '') + '">' +
    '<div class="site-modal-actions">' +
    '<button type="button" class="btn btn-light" onclick="closeSiteEditModal()">Cancelar</button>' +
    '<button type="submit" class="btn btn-accent">Salvar avatar</button>' +
    '</div>'
  bindSiteModalPreview()
  updateSiteModalPreview()
  document.getElementById('site-edit-modal').classList.add('on')
}

function deleteSelectedSiteElement() {
  if (!selectedSiteMoveKey) {
    showEditorMessage('Clique em um elemento antes de excluir')
    return
  }
  if (!confirm('Excluir esta parte do site? Ela ficará oculta após salvar.')) return
  pushUndoSnapshot('delete:' + selectedSiteMoveKey)
  const hidden = new Set(Array.isArray(inlineCms.layout?.hidden_elements) ? inlineCms.layout.hidden_elements : [])
  hidden.add(selectedSiteMoveKey)
  inlineCms.layout = { ...(inlineCms.layout || {}), hidden_elements: Array.from(hidden) }
  document.querySelector('[data-move-key="' + CSS.escape(selectedSiteMoveKey) + '"]')?.remove()
  selectedSiteMoveKey = null
  markDirty()
}

async function addTurmaFromSite() {
  siteModalMode = 'turma'
  document.getElementById('site-modal-title').textContent = 'Nova turma'
  document.getElementById('site-modal-alert').style.display = 'none'
  document.getElementById('site-modal-form').innerHTML =
    '<label>Nome da turma</label>' +
    '<input id="modal-turma-nome" placeholder="Ex: Redação para Tribunais" required>' +
    '<label>Concurso / área</label>' +
    '<input id="modal-turma-concurso" placeholder="Ex: TRT/TRE/TJ" value="Redação" required>' +
    '<label>Descrição</label>' +
    '<textarea id="modal-turma-desc" placeholder="Acompanhamento, temas e correção individual."></textarea>' +
    '<label>Preço em R$</label>' +
    '<input id="modal-turma-preco" inputmode="numeric" autocomplete="off" value="0,00" oninput="maskMoneyInput(this)" onblur="maskMoneyInput(this)">' +
    '<div class="site-modal-actions">' +
    '<button type="button" class="btn btn-light" onclick="closeSiteEditModal()">Cancelar</button>' +
    '<button type="submit" class="btn btn-accent">Salvar turma</button>' +
    '</div>'
  bindSiteModalPreview()
  updateSiteModalPreview()
  document.getElementById('site-edit-modal').classList.add('on')
  document.getElementById('modal-turma-nome').focus()
}

function addPostFromSite() {
  siteModalMode = 'post'
  document.getElementById('site-modal-title').textContent = 'Nova publicação'
  document.getElementById('site-modal-alert').style.display = 'none'
  document.getElementById('site-modal-form').innerHTML =
    '<label>Tipo</label>' +
    '<select id="modal-post-tipo"><option value="POST">Publicação</option><option value="NOTICIA">Notícia</option><option value="MATERIA">Matéria</option></select>' +
    '<label>Título</label>' +
    '<input id="modal-post-titulo" placeholder="Título da publicação" required>' +
    '<label>Resumo</label>' +
    '<textarea id="modal-post-resumo" placeholder="Resumo que aparecerá no card"></textarea>' +
    '<label>Conteúdo</label>' +
    '<textarea id="modal-post-conteudo" placeholder="Texto completo da publicação"></textarea>' +
    '<div class="site-modal-actions">' +
    '<button type="button" class="btn btn-light" onclick="closeSiteEditModal()">Cancelar</button>' +
    '<button type="submit" class="btn btn-accent">Salvar publicação</button>' +
    '</div>'
  bindSiteModalPreview()
  updateSiteModalPreview()
  document.getElementById('site-edit-modal').classList.add('on')
  document.getElementById('modal-post-titulo').focus()
}

function closeSiteEditModal() {
  document.getElementById('site-edit-modal').classList.remove('on')
  siteModalMode = null
  editingExtraId = null
}

function bindSiteModalPreview() {
  document.querySelectorAll('#site-modal-form input,#site-modal-form textarea,#site-modal-form select').forEach(el => {
    el.addEventListener('input', updateSiteModalPreview)
    el.addEventListener('change', updateSiteModalPreview)
  })
  const fileInput = document.getElementById('modal-extra-file')
  if (fileInput) {
    fileInput.addEventListener('change', () => {
      const file = fileInput.files?.[0]
      if (!file) return
      const reader = new FileReader()
      reader.onload = () => {
        document.getElementById('modal-extra-image').value = reader.result
        updateSiteModalPreview()
      }
      reader.readAsDataURL(file)
    })
  }
}

function moneyPreview(value) {
  const num = parseMoneyBR(value)
  return num > 0 ? 'R$ ' + num.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : 'Gratuito'
}

function parseMoneyBR(value) {
  const digits = String(value || '').replace(/\D/g, '')
  return digits ? Number(digits) / 100 : 0
}

function maskMoneyInput(input) {
  const num = parseMoneyBR(input.value)
  input.value = num.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

function updateSiteModalPreview() {
  const preview = document.getElementById('site-modal-preview')
  if (siteModalMode === 'turma') {
    const nome = document.getElementById('modal-turma-nome')?.value.trim() || 'Nome da turma'
    const concurso = document.getElementById('modal-turma-concurso')?.value.trim() || 'Área'
    const desc = document.getElementById('modal-turma-desc')?.value.trim() || 'Descrição da turma aparecerá aqui.'
    const preco = moneyPreview(document.getElementById('modal-turma-preco')?.value)
    preview.innerHTML =
      '<article class="card">' +
      '<div class="meta">' + escHtml(concurso) + ' · ABERTA</div>' +
      '<h3>' + escHtml(nome) + '</h3>' +
      '<div class="desc">' + escHtml(desc) + '</div>' +
      '<div class="price">' + escHtml(preco) + '</div>' +
      '<button type="button" class="btn btn-accent">' + escHtml(inlineCms.layout?.cta_text || 'Criar acesso de aluno') + '</button>' +
      '</article>'
    return
  }
  if (siteModalMode === 'extra-text') {
    const txt = document.getElementById('modal-extra-text')?.value.trim() || 'Texto novo no site.'
    preview.innerHTML = '<section class="site-extra-text" style="' + escHtml(modalExtraStyleAttr()) + '">' + escHtml(txt) + '</section>'
    return
  }
  if (siteModalMode === 'extra-image') {
    const src = document.getElementById('modal-extra-image')?.value.trim()
    const alt = document.getElementById('modal-extra-alt')?.value.trim() || 'Imagem do site'
    const fit = document.getElementById('modal-extra-object-fit')?.value || 'cover'
    preview.innerHTML = src
      ? '<section class="site-extra-image" style="' + escHtml(modalExtraStyleAttr()) + '"><img src="' + escHtml(src) + '" alt="' + escHtml(alt) + '" style="width:100%;height:100%;object-fit:' + escHtml(fit) + ';border-radius:inherit"></section>'
      : '<div class="empty">Informe a URL da imagem.</div>'
    return
  }
  if (siteModalMode === 'extra-avatar') {
    const text = document.getElementById('modal-extra-text')?.value.trim() || 'PR'
    const src = document.getElementById('modal-extra-image')?.value.trim()
    preview.innerHTML = '<section class="site-extra-avatar" style="' + escHtml(modalExtraStyleAttr()) + '"><div class="site-extra-avatar-circle">' + (src ? '<img src="' + escHtml(src) + '" alt="Avatar">' : escHtml(text.slice(0, 8))) + '</div></section>'
    return
  }
  if (siteModalMode === 'extra-style') {
    const block = findExtraBlock(editingExtraId)
    if (!block) { preview.innerHTML = '<div class="empty">Item não encontrado.</div>'; return }
    if (block.type === 'image') {
      const src = document.getElementById('modal-extra-image')?.value.trim()
      const alt = document.getElementById('modal-extra-alt')?.value.trim() || 'Imagem do site'
      const fit = document.getElementById('modal-extra-object-fit')?.value || 'cover'
      preview.innerHTML = src
        ? '<section class="site-extra-image" style="' + escHtml(modalExtraStyleAttr()) + '"><img src="' + escHtml(src) + '" alt="' + escHtml(alt) + '" style="width:100%;height:100%;object-fit:' + escHtml(fit) + ';border-radius:inherit"></section>'
        : '<div class="empty">Informe a URL da imagem.</div>'
      return
    }
    if (block.type === 'avatar') {
      const text = document.getElementById('modal-extra-text')?.value.trim() || 'PR'
      const src = document.getElementById('modal-extra-image')?.value.trim()
      preview.innerHTML = '<section class="site-extra-avatar" style="' + escHtml(modalExtraStyleAttr()) + '"><div class="site-extra-avatar-circle">' + (src ? '<img src="' + escHtml(src) + '" alt="Avatar">' : escHtml(text.slice(0, 8))) + '</div></section>'
      return
    }
    const txt = document.getElementById('modal-extra-text')?.value.trim() || 'Texto novo no site.'
    preview.innerHTML = '<section class="site-extra-text" style="' + escHtml(modalExtraStyleAttr()) + '">' + escHtml(txt) + '</section>'
    return
  }
  if (siteModalMode === 'avatar') {
    const text = document.getElementById('modal-avatar-text')?.value.trim() || 'PR'
    const src = document.getElementById('modal-avatar-image')?.value.trim()
    preview.innerHTML = '<div class="avatar" style="margin:20px auto">' + (src ? '<img src="' + escHtml(src) + '" alt="Avatar">' : escHtml(text.slice(0, 4))) + '</div>'
    return
  }
  const tipo = document.getElementById('modal-post-tipo')?.value || 'POST'
  const titulo = document.getElementById('modal-post-titulo')?.value.trim() || 'Título da publicação'
  const resumo = document.getElementById('modal-post-resumo')?.value.trim() || 'Resumo da publicação aparecerá aqui.'
  const conteudo = document.getElementById('modal-post-conteudo')?.value.trim() || 'Conteúdo completo da publicação.'
  preview.innerHTML =
    '<article class="post-card">' +
    '<div class="post-type">' + escHtml(postTypeLabelClient(tipo)) + '</div>' +
    '<h3>' + escHtml(titulo) + '</h3>' +
    '<p>' + escHtml(resumo) + '</p>' +
    '<div class="post-body">' + escHtml(conteudo) + '</div>' +
    '</article>'
}

function showSiteModalError(msg) {
  const el = document.getElementById('site-modal-alert')
  el.textContent = msg
  el.style.display = 'block'
}

async function saveSiteModal(event) {
  event.preventDefault()
  document.getElementById('site-modal-alert').style.display = 'none'
  if (siteModalMode === 'turma') return saveTurmaFromModal()
  if (siteModalMode === 'post') return savePostFromModal()
  if (siteModalMode === 'extra-text') return saveExtraTextFromModal()
  if (siteModalMode === 'extra-image') return saveExtraImageFromModal()
  if (siteModalMode === 'extra-avatar') return saveExtraAvatarFromModal()
  if (siteModalMode === 'extra-style') return saveExtraStyleFromModal()
  if (siteModalMode === 'avatar') return saveAvatarFromModal()
}

async function saveTurmaFromModal() {
  const nome = document.getElementById('modal-turma-nome').value.trim()
  const concurso = document.getElementById('modal-turma-concurso').value.trim() || 'Redação'
  const descricao = document.getElementById('modal-turma-desc').value.trim()
  const preco = parseMoneyBR(document.getElementById('modal-turma-preco').value)
  if (!nome) return showSiteModalError('Informe o nome da turma.')
  const res = await fetch('/api/admin/turmas', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ nome, concurso, descricao, preco, status: 'ABERTA' })
  })
  if (!res.ok) return showSiteModalError('Não foi possível criar a turma.')
  location.reload()
}

async function savePostFromModal() {
  const titulo = document.getElementById('modal-post-titulo').value.trim()
  if (!titulo) return showSiteModalError('Informe o título da publicação.')
  const resumo = document.getElementById('modal-post-resumo').value.trim()
  const conteudo = document.getElementById('modal-post-conteudo').value.trim()
  const tipo = document.getElementById('modal-post-tipo').value || 'POST'
  inlineCms.posts = Array.isArray(inlineCms.posts) ? inlineCms.posts : []
  inlineCms.posts.unshift({
    id: crypto.randomUUID ? crypto.randomUUID() : String(Date.now()),
    tipo,
    status: 'PUBLICADO',
    pinned: false,
    titulo,
    resumo,
    conteudo,
    created_at: new Date().toISOString()
  })
  const res = await fetch('/api/admin/site', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...inlineSite, cms: inlineCms })
  })
  if (!res.ok) return showSiteModalError('Não foi possível criar a publicação.')
  location.reload()
}

async function saveExtraTextFromModal() {
  const text = document.getElementById('modal-extra-text').value.trim()
  if (!text) return showSiteModalError('Informe o texto.')
  const target = document.getElementById('modal-extra-target').value || 'hero'
  inlineCms.layout = { ...(inlineCms.layout || {}) }
  inlineCms.layout.extra_blocks = Array.isArray(inlineCms.layout.extra_blocks) ? inlineCms.layout.extra_blocks : []
  inlineCms.layout.extra_blocks.push({ id: crypto.randomUUID ? crypto.randomUUID() : String(Date.now()), type: 'text', target, text, ...readExtraStyleFromModal() })
  const res = await fetch('/api/admin/site', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...collectInlineSite(), cms: inlineCms })
  })
  if (!res.ok) return showSiteModalError('Não foi possível inserir o texto.')
  location.href = SITE_PATH
}

async function saveExtraImageFromModal() {
  const src = document.getElementById('modal-extra-image').value.trim()
  const alt = document.getElementById('modal-extra-alt').value.trim()
  if (!src) return showSiteModalError('Informe a URL da imagem.')
  const target = document.getElementById('modal-extra-target').value || 'hero'
  inlineCms.layout = { ...(inlineCms.layout || {}) }
  inlineCms.layout.extra_blocks = Array.isArray(inlineCms.layout.extra_blocks) ? inlineCms.layout.extra_blocks : []
  inlineCms.layout.extra_blocks.push({ id: crypto.randomUUID ? crypto.randomUUID() : String(Date.now()), type: 'image', target, src, alt, ...readExtraStyleFromModal() })
  const res = await fetch('/api/admin/site', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...collectInlineSite(), cms: inlineCms })
  })
  if (!res.ok) return showSiteModalError('Não foi possível inserir a imagem.')
  location.href = SITE_PATH
}

async function saveExtraAvatarFromModal() {
  const text = document.getElementById('modal-extra-text').value.trim() || 'PR'
  const src = document.getElementById('modal-extra-image')?.value.trim() || ''
  const target = document.getElementById('modal-extra-target').value || 'hero'
  inlineCms.layout = { ...(inlineCms.layout || {}) }
  inlineCms.layout.extra_blocks = Array.isArray(inlineCms.layout.extra_blocks) ? inlineCms.layout.extra_blocks : []
  inlineCms.layout.extra_blocks.push({ id: crypto.randomUUID ? crypto.randomUUID() : String(Date.now()), type: 'avatar', target, text: text.slice(0, 8), src, ...readExtraStyleFromModal() })
  const res = await fetch('/api/admin/site', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...collectInlineSite(), cms: inlineCms })
  })
  if (!res.ok) return showSiteModalError('Não foi possível inserir o avatar.')
  location.href = SITE_PATH
}

async function saveExtraStyleFromModal() {
  const block = findExtraBlock(editingExtraId)
  if (!block) return showSiteModalError('Item não encontrado.')
  const updated = { ...block, target: document.getElementById('modal-extra-target').value || block.target || 'hero', ...readExtraStyleFromModal() }
  if (block.type === 'image') {
    updated.src = document.getElementById('modal-extra-image').value.trim()
    updated.alt = document.getElementById('modal-extra-alt').value.trim()
    if (!updated.src) return showSiteModalError('Informe a URL da imagem.')
  } else {
    updated.text = document.getElementById('modal-extra-text').value.trim() || block.text || 'PR'
    if (block.type === 'avatar') updated.src = document.getElementById('modal-extra-image')?.value.trim() || ''
  }
  const payload = collectInlineSite()
  const list = Array.isArray(payload.cms.layout?.extra_blocks) ? payload.cms.layout.extra_blocks : []
  const payloadBlock = list.find(item => item.id === editingExtraId)
  if (payloadBlock) Object.assign(payloadBlock, updated)
  const res = await fetch('/api/admin/site', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  })
  if (!res.ok) return showSiteModalError('Não foi possível editar o item.')
  location.href = SITE_PATH
}

async function saveAvatarFromModal() {
  const text = document.getElementById('modal-avatar-text').value.trim() || 'PR'
  const image = document.getElementById('modal-avatar-image').value.trim()
  inlineCms.layout = { ...(inlineCms.layout || {}), avatar_text: text.slice(0, 4), avatar_image: image }
  const hidden = new Set(Array.isArray(inlineCms.layout.hidden_elements) ? inlineCms.layout.hidden_elements : [])
  hidden.delete('hero:avatar')
  inlineCms.layout.hidden_elements = Array.from(hidden)
  const res = await fetch('/api/admin/site', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...collectInlineSite(), cms: inlineCms })
  })
  if (!res.ok) return showSiteModalError('Não foi possível salvar o avatar.')
  location.href = SITE_PATH
}

function initPublicCarousels() {
  document.querySelectorAll('[data-carousel]').forEach((carousel) => {
    const track = carousel.querySelector('[data-carousel-track]')
    const prev = carousel.querySelector('[data-carousel-prev]')
    const next = carousel.querySelector('[data-carousel-next]')
    if (!track) return
    let paused = false
    const stepSize = () => {
      const item = track.children[0]
      if (!item) return track.clientWidth
      const styles = getComputedStyle(track)
      const gap = parseFloat(styles.columnGap || styles.gap || '18') || 18
      return item.getBoundingClientRect().width + gap
    }
    const move = (direction) => {
      const max = track.scrollWidth - track.clientWidth - 2
      if (max <= 0) return
      if (direction > 0 && track.scrollLeft >= max) track.scrollTo({ left: 0, behavior: 'smooth' })
      else if (direction < 0 && track.scrollLeft <= 0) track.scrollTo({ left: max, behavior: 'smooth' })
      else track.scrollBy({ left: stepSize() * direction, behavior: 'smooth' })
    }
    prev?.addEventListener('click', () => move(-1))
    next?.addEventListener('click', () => move(1))
    carousel.addEventListener('mouseenter', () => { paused = true })
    carousel.addEventListener('mouseleave', () => { paused = false })
    carousel.addEventListener('focusin', () => { paused = true })
    carousel.addEventListener('focusout', () => { paused = false })
    setInterval(() => {
      if (!paused && !document.body.classList.contains('editing')) move(1)
    }, 3600)
  })
}

function initRevealAnimations() {
  const items = Array.from(document.querySelectorAll('.reveal'))
  if (!items.length) return
  if (!('IntersectionObserver' in window)) {
    items.forEach((item) => item.classList.add('is-visible'))
    return
  }
  const observer = new IntersectionObserver((entries) => {
    entries.forEach((entry) => {
      if (entry.isIntersecting) {
        entry.target.classList.add('is-visible')
        observer.unobserve(entry.target)
      }
    })
  }, { threshold: 0.14, rootMargin: '0px 0px -40px 0px' })
  items.forEach((item, index) => {
    item.style.transitionDelay = Math.min(index * 45, 260) + 'ms'
    observer.observe(item)
  })
}

initPublicCarousels()
initRevealAnimations()
bootProfessorEditMode()
</script>
</body>
</html>`
}

function renderTurmaPage(data: { site: any; turmas: any[] }, turma: any) {
  const { site } = data
  const cms = parseCms(site)
  const layout = cms.layout
  const theme = normalizeTheme(cms.theme, site.cor_primaria, site.cor_accent)
  const settings = cms.turma_settings?.[turma.id] || {}
  const sitePath = `/redacao/${encodeURIComponent(site.slug)}`
  const checkoutUrl = `${sitePath}/checkout/${encodeURIComponent(turma.id)}`
  const price = moneyBR(turma.preco)
  const image = String(settings.imagem_url || '')
  const splitLines = (value: unknown, fallback: string[]) => {
    const lines = String(value || '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
    return lines.length ? lines : fallback
  }
  const benefits = splitLines(settings.beneficios, [
    'Correções personalizadas e organizadas no painel',
    'Temas e materiais vinculados à turma',
    'Acompanhamento direto com o professor',
    'Área do aluno para envios e devolutivas'
  ])
  const roteiro = splitLines(settings.roteiro, [
    'Diagnóstico e orientação inicial',
    'Estrutura do texto e planejamento',
    'Prática com temas da banca',
    'Correções comentadas e ajustes finais'
  ])
  const destaque = String(settings.destaque || turma.descricao || 'Uma turma pensada para acompanhar sua evolução com clareza, prática e correções individualizadas.')
  const tituloPublico = String(settings.titulo_publico || 'Para Quem É')
  const tituloEntregas = String(settings.titulo_entregas || 'O Que A Turma Entrega')
  const tituloRoteiro = String(settings.titulo_roteiro || 'Roteiro Do Curso')
  return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(turma.nome)} — ${esc(site.nome_prof)}</title>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700;800;900&display=swap" rel="stylesheet">
<style>
*{box-sizing:border-box;margin:0;padding:0}
:root{--brand:${esc(theme.primary)};--brand-text:${esc(theme.primaryText)};--accent:${esc(theme.accent)};--accent-text:${esc(theme.accentText)};--surface:${esc(theme.background)};--ink:${esc(theme.text)};--ink2:${esc(theme.textSoft)};--ink3:${esc(theme.textMuted)};--card:${esc(theme.card)};--border:${esc(theme.border)};--r:10px}
html{scroll-behavior:smooth}body{font-family:Inter,system-ui,sans-serif;background:var(--surface);color:var(--ink);-webkit-font-smoothing:antialiased}a{text-decoration:none;color:inherit}
.nav{height:68px;background:var(--brand);color:var(--brand-text);display:flex;align-items:center;justify-content:space-between;padding:0 6%;position:sticky;top:0;z-index:20}.brand{display:flex;align-items:center;gap:10px;font-weight:900}.mark{background:var(--accent);color:var(--accent-text);font-size:10px;font-weight:900;padding:3px 9px;border-radius:5px;text-transform:uppercase}.nav a{font-size:13px;font-weight:800}.nav-actions{display:flex;gap:14px;align-items:center}.btn{display:inline-flex;align-items:center;justify-content:center;border:0;border-radius:999px;padding:13px 20px;font-weight:900;font-size:13px;cursor:pointer;transition:.22s}.btn:hover{transform:translateY(-2px)}.btn-accent{background:var(--accent);color:var(--accent-text)}.btn-light{background:#fff;color:var(--brand)}
.hero{min-height:calc(100vh - 68px);background:linear-gradient(90deg,rgba(0,0,0,.54),rgba(0,0,0,.18)),var(--brand);color:var(--brand-text);display:grid;grid-template-columns:minmax(0,1fr) minmax(320px,460px);gap:54px;align-items:center;padding:72px 6%}.hero h1{font-size:clamp(38px,6vw,76px);line-height:.98;font-weight:900;max-width:820px}.eyebrow{text-transform:uppercase;font-weight:800;letter-spacing:.08em;margin-bottom:18px;color:rgba(255,255,255,.78)}.hero p{margin:24px 0;color:rgba(255,255,255,.82);font-size:18px;line-height:1.65;max-width:720px}.buy-card{background:#fff;color:#111;border-radius:28px;padding:34px;box-shadow:0 30px 80px rgba(0,0,0,.25)}.buy-card-cover{width:min(100%,300px);aspect-ratio:2/3;height:auto;border-radius:20px;overflow:hidden;background:#050505;margin:0 auto 22px;display:flex;align-items:center;justify-content:center;color:var(--brand-text);font-size:44px;font-weight:900}.buy-card-cover img{width:100%;height:100%;object-fit:contain;background:#050505}.price{display:inline-block;background:var(--accent);color:var(--accent-text);font-size:28px;font-weight:900;padding:4px 10px;margin:12px 0 18px}.buy-card ul{display:grid;gap:10px;margin:16px 0 22px}.buy-card li{list-style:none;color:#555}.buy-card li:before{content:'✓';display:inline-flex;width:22px;height:22px;border-radius:50%;background:var(--accent);color:var(--accent-text);align-items:center;justify-content:center;margin-right:9px;font-size:12px;font-weight:900}
.section{padding:82px 6%}.dark{background:var(--brand);color:var(--brand-text)}.section-title{font-size:clamp(30px,4vw,52px);font-weight:900;margin-bottom:30px}.grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:18px}.info-card{background:var(--card);border:1px solid var(--border);border-radius:18px;padding:24px;min-height:150px;transition:.28s}.dark .info-card{background:rgba(255,255,255,.06);border-color:rgba(255,255,255,.16)}.info-card:hover{transform:translateY(-5px);box-shadow:0 18px 48px rgba(0,0,0,.12)}.info-card strong{display:block;font-size:16px;margin-bottom:8px}.info-card p{color:var(--ink2);line-height:1.6}.dark .info-card p{color:rgba(255,255,255,.72)}.compare{display:grid;grid-template-columns:1fr 1fr;gap:22px}.panel{border-radius:24px;padding:30px;background:#fff;color:#111}.panel.highlight{background:var(--accent);color:var(--accent-text)}.panel ul{display:grid;gap:11px;margin-top:16px}.panel li{list-style:none}.roadmap{columns:2;gap:44px}.roadmap li{break-inside:avoid;margin:0 0 14px;padding:14px 16px;border:1px solid var(--border);border-radius:14px;background:#fff;list-style:none}.cta{text-align:center;background:linear-gradient(135deg,var(--brand),#111);color:var(--brand-text);padding:86px 6%}.cta h2{font-size:clamp(34px,5vw,62px);font-weight:900;margin-bottom:16px}.reveal{opacity:0;transform:translateY(30px);transition:opacity .72s ease,transform .72s ease}.reveal.is-visible{opacity:1;transform:none}
@media(max-width:860px){.hero{grid-template-columns:1fr;min-height:auto}.grid,.compare{grid-template-columns:1fr}.roadmap{columns:1}.nav-actions{display:none}}@media(prefers-reduced-motion:reduce){.reveal,.btn,.info-card{transition:none!important;transform:none!important}.reveal{opacity:1}}
</style>
</head>
<body>
<nav class="nav"><a class="brand" href="${sitePath}"><span class="mark">${esc(layout.header_label || defaultCms().layout.header_label)}</span><span>${esc(site.nome_prof)}</span></a><div class="nav-actions"><a href="${sitePath}#turmas">Turmas</a><a href="${sitePath}#conteudos">Conteúdos</a><a class="btn btn-light" href="${sitePath}/login">Entrar</a></div></nav>
<main>
<section class="hero reveal">
  <div><div class="eyebrow">${esc(turma.concurso || 'Turma')}</div><h1>${esc(turma.nome)}</h1><p>${esc(destaque)}</p><a class="btn btn-accent" href="${checkoutUrl}">Quero participar</a></div>
  <aside class="buy-card reveal"><div class="buy-card-cover">${image ? `<img src="${esc(image)}" alt="${esc(turma.nome)}">` : esc(String(turma.nome || 'TR').slice(0, 2).toUpperCase())}</div><h2>${esc(turma.nome)}</h2><div>Investimento</div><div class="price">${price}</div><ul>${benefits.slice(0, 3).map((item) => `<li>${esc(item)}</li>`).join('')}</ul><a class="btn btn-accent" href="${checkoutUrl}">Quero participar</a></aside>
</section>
<section class="section dark reveal"><h2 class="section-title">${esc(tituloPublico)}</h2><div class="grid">${['Quem está começando', 'Quem precisa de método', 'Quem quer acompanhamento'].map((title, index) => `<article class="info-card"><strong>${title}</strong><p>${esc(benefits[index] || 'A turma organiza estudo, prática e devolutiva para dar clareza ao próximo passo.')}</p></article>`).join('')}</div></section>
<section class="section reveal"><h2 class="section-title">${esc(tituloEntregas)}</h2><div class="compare"><div class="panel"><h3>Estudo sozinho</h3><ul><li>Sem trilha clara</li><li>Sem devolutiva individual</li><li>Dificuldade para medir evolução</li></ul></div><div class="panel highlight"><h3>Com esta turma</h3><ul>${benefits.map((item) => `<li>✓ ${esc(item)}</li>`).join('')}</ul></div></div></section>
<section class="section reveal"><h2 class="section-title">${esc(tituloRoteiro)}</h2><ol class="roadmap">${roteiro.map((item, index) => `<li><strong>${index + 1}.</strong> ${esc(item)}</li>`).join('')}</ol></section>
<section class="cta reveal"><h2>Matricule-se Agora</h2><p>${esc(turma.descricao || 'Garanta seu acesso e acompanhe os conteúdos, temas e correções desta turma.')}</p><br><a class="btn btn-accent" href="${checkoutUrl}">Quero participar</a></section>
</main>
<script>
function initReveal(){const items=[...document.querySelectorAll('.reveal')];if(!('IntersectionObserver'in window)){items.forEach(i=>i.classList.add('is-visible'));return}const io=new IntersectionObserver(es=>es.forEach(e=>{if(e.isIntersecting){e.target.classList.add('is-visible');io.unobserve(e.target)}}),{threshold:.12});items.forEach((i,n)=>{i.style.transitionDelay=Math.min(n*70,280)+'ms';io.observe(i)})}
initReveal()
</script>
</body>
</html>`
}

function renderCheckoutPage(data: { site: any; turmas: any[] }, turma: any) {
  const { site } = data
  const cms = parseCms(site)
  const layout = cms.layout
  const theme = normalizeTheme(cms.theme, site.cor_primaria, site.cor_accent)
  const settings = cms.turma_settings?.[turma.id] || {}
  const paymentSettings = normalizePaymentSettings(settings)
  const defaultPaymentChoice = paymentSettings.methods.pix ? 'PIX' : (paymentSettings.methods.boleto ? 'BOLETO' : 'CREDIT_CARD')
  const priceNumber = Number(turma.preco || 0)
  const maxCardInstallments = maxCreditCardInstallmentsFor(priceNumber, paymentSettings)
  const methodCards = [
    paymentSettings.methods.pix ? '<label class="pay-method"><input type="radio" name="billing-type" value="PIX" checked><strong>Pix</strong><span>QR Code e copia-e-cola com confirmação rápida.</span></label>' : '',
    paymentSettings.methods.boleto ? `<label class="pay-method"><input type="radio" name="billing-type" value="BOLETO" ${defaultPaymentChoice === 'BOLETO' ? 'checked' : ''}><strong>Boleto</strong><span>Gera cobrança com vencimento para pagamento bancário.</span></label>` : '',
    paymentSettings.methods.credit_card ? `<label class="pay-method"><input type="radio" name="billing-type" value="CREDIT_CARD" ${defaultPaymentChoice === 'CREDIT_CARD' ? 'checked' : ''}><strong>Cartão</strong><span>Pague com cartão sem sair deste site.</span></label>` : ''
  ].filter(Boolean).join('')
  const installmentOptions = Array.from({ length: maxCardInstallments }, (_, index) => {
    const value = index + 1
    return `<option value="${value}">${value}x</option>`
  }).join('')
  const feeNote = paymentSettings.feePayer === 'ALUNO' && paymentSettings.feePercent > 0
    ? `Taxa de ${paymentSettings.feePercent.toLocaleString('pt-BR', { maximumFractionDigits: 2 })}% embutida quando o pagamento for no cartão.`
    : 'As taxas do cartão são absorvidas pelo professor.'
  const sitePath = `/redacao/${encodeURIComponent(site.slug)}`
  const loginUrl = `${sitePath}/login`
  const price = moneyBR(priceNumber)
  const image = String(settings.imagem_url || '')
  const benefits = String(settings.beneficios || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 4)
  const defaultBenefits = benefits.length ? benefits : [
    'Matrícula vinculada ao seu e-mail',
    'Acesso à turma após cadastro ou login',
    'Envio de redações conforme créditos liberados'
  ]
  return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Pagamento — ${esc(turma.nome)}</title>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700;800;900&display=swap" rel="stylesheet">
<style>
*{box-sizing:border-box;margin:0;padding:0}
:root{--brand:${esc(theme.primary)};--brand-text:${esc(theme.primaryText)};--brand-soft:rgba(255,255,255,.72);--accent:${esc(theme.accent)};--accent-text:${esc(theme.accentText)};--surface:${esc(theme.background)};--ink:${esc(theme.text)};--ink2:${esc(theme.textSoft)};--ink3:${esc(theme.textMuted)};--card:${esc(theme.card)};--border:${esc(theme.border)};--danger:${esc(theme.danger)};--success:${esc(theme.success)}}
body{font-family:Inter,system-ui,sans-serif;background:linear-gradient(135deg,var(--brand),#111);min-height:100vh;color:var(--ink);padding:28px;-webkit-font-smoothing:antialiased}
a{text-decoration:none;color:inherit}.wrap{max-width:1080px;margin:0 auto}.top{display:flex;align-items:center;justify-content:space-between;gap:16px;color:var(--brand-text);margin-bottom:26px}.brand{display:flex;align-items:center;gap:10px;font-weight:900}.mark{background:var(--accent);color:var(--accent-text);font-size:10px;font-weight:900;padding:3px 9px;border-radius:5px;text-transform:uppercase}.back{font-size:13px;color:var(--brand-soft);font-weight:800}
.checkout{display:grid;grid-template-columns:minmax(0,1fr) 420px;gap:22px;align-items:start}.panel{background:var(--card);border:1px solid var(--border);border-radius:24px;padding:28px;box-shadow:0 24px 70px rgba(0,0,0,.22)}
.cover{width:min(100%,320px);aspect-ratio:2/3;height:auto;border-radius:18px;overflow:hidden;background:#050505;display:flex;align-items:center;justify-content:center;color:var(--brand-text);font-weight:900;font-size:48px;margin:0 auto 22px}.cover img{width:100%;height:100%;object-fit:contain;background:#050505}
.eyebrow{font-size:11px;text-transform:uppercase;letter-spacing:.08em;color:var(--ink3);font-weight:900;margin-bottom:8px}h1{font-size:clamp(30px,5vw,56px);line-height:1;font-weight:900;margin-bottom:14px}.desc{color:var(--ink2);line-height:1.65;font-size:15px}.benefits{display:grid;gap:10px;margin-top:22px}.benefits li{list-style:none;color:var(--ink2)}.benefits li:before{content:'✓';display:inline-flex;width:22px;height:22px;border-radius:50%;background:var(--accent);color:var(--accent-text);align-items:center;justify-content:center;margin-right:8px;font-size:12px;font-weight:900}
.summary h2{font-size:22px;font-weight:900;margin-bottom:14px}.price-row{display:flex;align-items:center;justify-content:space-between;padding:16px 0;border-top:1px solid var(--border);border-bottom:1px solid var(--border);margin:18px 0}.price{font-size:28px;font-weight:900;background:var(--accent);color:var(--accent-text);padding:4px 10px;border-radius:8px}
.form-group{display:flex;flex-direction:column;gap:7px;margin-bottom:14px}label{font-size:12px;font-weight:800;color:var(--ink2)}input{width:100%;padding:12px 14px;border:1.5px solid var(--border);border-radius:10px;font:inherit;outline:none}input:focus{border-color:var(--brand);box-shadow:0 0 0 3px rgba(0,0,0,.08)}input.is-invalid{border-color:var(--danger);box-shadow:0 0 0 3px rgba(200,64,64,.12)}input.is-valid{border-color:var(--success);box-shadow:0 0 0 3px rgba(45,122,77,.1)}.cpf-status{display:none;font-size:11px;font-weight:800}.cpf-status.invalid{display:block;color:var(--danger)}.cpf-status.valid{display:block;color:var(--success)}
.pay-methods{display:grid;grid-template-columns:repeat(auto-fit,minmax(126px,1fr));gap:10px;margin:8px 0 16px}.pay-method{border:1.5px solid var(--border);border-radius:14px;padding:12px;background:rgba(0,0,0,.025);cursor:pointer;display:flex;flex-direction:column;gap:5px;min-height:96px}.pay-method input{width:auto;align-self:flex-start}.pay-method strong{font-size:14px}.pay-method span{font-size:11px;color:var(--ink3);line-height:1.35}.pay-method:has(input:checked){border-color:var(--brand);box-shadow:0 0 0 3px rgba(0,0,0,.08);background:rgba(0,0,0,.045)}.installment-box,.card-box{border:1px solid var(--border);border-radius:14px;padding:12px;margin:-4px 0 16px;background:rgba(0,0,0,.025)}.installment-box.hidden,.card-box.hidden{display:none}.installment-box select{width:100%;padding:12px 14px;border:1.5px solid var(--border);border-radius:10px;font:inherit;background:#fff}.installment-box small,.card-box small{display:block;margin-top:7px;color:var(--ink3);font-size:11px;line-height:1.4}.card-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}.card-grid .full{grid-column:1/-1}
.btn{width:100%;border:0;border-radius:10px;padding:14px 16px;font:inherit;font-weight:900;cursor:pointer;transition:.22s}.btn:hover{transform:translateY(-2px)}.btn-accent{background:var(--accent);color:var(--accent-text)}.btn-sec{background:transparent;border:1px solid var(--border);color:var(--ink)}
.alert{display:none;border-radius:10px;padding:12px 14px;font-size:13px;margin-bottom:14px}.alert-ok{background:#EEF8F1;color:var(--success);border:1px solid #BFE8CD}.alert-err{background:#FEF0F0;color:var(--danger);border:1px solid #F5C6C6}.postpay{display:none;margin-top:18px}.postpay.open{display:block}.action-grid{display:grid;grid-template-columns:1fr 1fr;gap:10px}.note{font-size:12px;color:var(--ink3);line-height:1.5;margin-top:12px}
.payment-modal{position:fixed;inset:0;background:rgba(0,0,0,.64);display:none;align-items:center;justify-content:center;padding:24px;z-index:50}.payment-modal.open{display:flex}.payment-box{width:min(860px,100%);max-height:94vh;overflow:auto;background:var(--card);color:var(--ink);border:1px solid var(--border);border-radius:24px;padding:28px;box-shadow:0 30px 90px rgba(0,0,0,.42)}.payment-badge{display:inline-flex;background:var(--accent);color:var(--accent-text);border-radius:999px;padding:7px 12px;font-size:12px;font-weight:900;margin-bottom:14px}.payment-box h2{font-size:28px;font-weight:900;margin-bottom:10px}.payment-details{background:rgba(0,0,0,.04);border:1px solid var(--border);border-radius:14px;padding:14px;margin:16px 0;display:grid;gap:7px;font-size:13px;color:var(--ink2)}.payment-code{font-weight:900;color:var(--ink);letter-spacing:.08em}.pix-grid{display:grid;grid-template-columns:220px minmax(0,1fr);gap:14px;align-items:start}.pix-grid.hidden{display:none}.pix-qr{width:220px;height:220px;border:1px solid var(--border);border-radius:14px;background:#fff;display:flex;align-items:center;justify-content:center;overflow:hidden}.pix-qr img{width:100%;height:100%;object-fit:contain}.pix-copy{width:100%;min-height:120px;resize:vertical;border:1px solid var(--border);border-radius:12px;padding:10px;font:12px ui-monospace,monospace;color:var(--ink2)}.payment-link-box{display:none;border:1px solid var(--border);border-radius:16px;padding:16px;background:rgba(0,0,0,.04);margin:16px 0}.payment-link-box.open{display:block}.payment-link-box p{font-size:13px;color:var(--ink2);line-height:1.55;margin-bottom:12px}.modal-actions{display:grid;grid-template-columns:1fr 1fr;gap:14px;margin-top:18px}.modal-actions .btn{font-size:17px;padding:20px 16px;border-radius:16px}.modal-note{font-size:12px;color:var(--ink3);line-height:1.55;margin-top:14px}
@media(max-width:860px){body{padding:18px}.checkout{grid-template-columns:1fr}.action-grid{grid-template-columns:1fr}.cover{width:min(100%,280px)}}
@media(max-width:620px){.modal-actions,.pay-methods{grid-template-columns:1fr}.payment-box{padding:22px}.payment-box h2{font-size:24px}}
</style>
</head>
<body>
<div class="wrap">
  <div class="top"><a class="brand" href="${sitePath}"><span class="mark">${esc(layout.header_label || defaultCms().layout.header_label)}</span><span>${esc(site.nome_prof)}</span></a><a class="back" href="${sitePath}/turmas/${encodeURIComponent(turma.id)}">← Voltar para a turma</a></div>
  <main class="checkout">
    <section class="panel">
      <div class="cover">${image ? `<img src="${esc(image)}" alt="${esc(turma.nome)}">` : esc(String(turma.nome || 'TR').slice(0, 2).toUpperCase())}</div>
      <div class="eyebrow">${esc(turma.concurso || 'Turma')}</div>
      <h1>${esc(turma.nome)}</h1>
      <p class="desc">${esc(turma.descricao || settings.destaque || 'Finalize sua inscrição para liberar o acesso à turma.')}</p>
      <ul class="benefits">${defaultBenefits.map((item) => `<li>${esc(item)}</li>`).join('')}</ul>
    </section>
    <aside class="panel summary">
      <h2>Pagamento da inscrição</h2>
      <p class="desc">Informe nome, e-mail e CPF antes de finalizar. Esses dados serão o vínculo da matrícula com seu cadastro.</p>
      <div class="price-row"><span>Total</span><strong class="price" id="checkout-total" data-base="${priceNumber}">${price}</strong></div>
      <div id="alert-err" class="alert alert-err"></div>
      <div id="alert-ok" class="alert alert-ok"></div>
      <form id="pay-form" onsubmit="simulatePayment(event)">
        <div class="form-group">
          <label for="payer-name">Nome</label>
          <input id="payer-name" placeholder="Seu nome completo" required autocomplete="name">
        </div>
        <div class="form-group">
          <label for="payer-email">E-mail obrigatório</label>
          <input id="payer-email" type="email" placeholder="seu@email.com" required autocomplete="email">
        </div>
        <div class="form-group">
          <label for="payer-cpf">CPF do aluno</label>
          <input id="payer-cpf" data-mask="cpf" placeholder="000.000.000-00" required inputmode="numeric" maxlength="14" autocomplete="off">
          <small>O CPF evita duplicidade e valida o cadastro após o pagamento.</small>
          <small id="payer-cpf-status" class="cpf-status" aria-live="polite"></small>
        </div>
        <label>Forma de pagamento</label>
        <div class="pay-methods" role="radiogroup" aria-label="Forma de pagamento">
          ${methodCards || '<label class="pay-method"><input type="radio" name="billing-type" value="PIX" checked><strong>Pix</strong><span>QR Code e copia-e-cola com confirmação rápida.</span></label>'}
        </div>
        <div class="installment-box ${defaultPaymentChoice === 'CREDIT_CARD' ? '' : 'hidden'}" id="installment-box">
          <label for="payer-installments">Parcelas no cartão</label>
          <select id="payer-installments">${installmentOptions || '<option value="1">1x</option>'}</select>
          <small>${esc(feeNote)}</small>
        </div>
        <div class="card-box ${defaultPaymentChoice === 'CREDIT_CARD' ? '' : 'hidden'}" id="card-box">
          <div class="card-grid">
            <div class="form-group full"><label for="card-number">Número do cartão</label><input id="card-number" inputmode="numeric" maxlength="23" autocomplete="cc-number" placeholder="0000 0000 0000 0000"></div>
            <div class="form-group full"><label for="card-holder">Nome impresso no cartão</label><input id="card-holder" autocomplete="cc-name" placeholder="Nome do titular"></div>
            <div class="form-group"><label for="card-month">Mês</label><input id="card-month" inputmode="numeric" maxlength="2" autocomplete="cc-exp-month" placeholder="MM"></div>
            <div class="form-group"><label for="card-year">Ano</label><input id="card-year" inputmode="numeric" maxlength="4" autocomplete="cc-exp-year" placeholder="AAAA"></div>
            <div class="form-group"><label for="card-ccv">CVV</label><input id="card-ccv" inputmode="numeric" maxlength="4" autocomplete="cc-csc" placeholder="000"></div>
            <div class="form-group"><label for="card-phone">Telefone</label><input id="card-phone" inputmode="tel" autocomplete="tel" placeholder="DDD + número"></div>
            <div class="form-group"><label for="card-postal">CEP</label><input id="card-postal" inputmode="numeric" maxlength="9" autocomplete="postal-code" placeholder="00000-000"></div>
            <div class="form-group"><label for="card-address-number">Número</label><input id="card-address-number" inputmode="numeric" autocomplete="address-line2" placeholder="Número"></div>
          </div>
          <small>Os dados do cartão são enviados somente para criar a cobrança no Asaas e não são salvos na plataforma.</small>
        </div>
        <button type="submit" class="btn btn-accent" id="btn-pay">Finalizar pagamento</button>
      </form>
      <div id="postpay" class="postpay">
        <div class="action-grid">
          <a class="btn btn-sec" id="login-link" href="${loginUrl}">Fazer login</a>
          <a class="btn btn-accent" id="signup-link" href="${loginUrl}?signup=1&paid=1&turma=${encodeURIComponent(turma.id)}">Criar cadastro</a>
        </div>
        <p class="note">Use o mesmo e-mail informado no pagamento para liberar a turma automaticamente.</p>
      </div>
    </aside>
  </main>
</div>
<div class="payment-modal" id="payment-modal" role="dialog" aria-modal="true" aria-labelledby="payment-title">
  <div class="payment-box">
    <span class="payment-badge">Aguardando pagamento</span>
    <h2 id="payment-title">Pague com Pix para liberar a turma</h2>
    <p class="desc">A matrícula só será liberada após confirmação pelo webhook do Asaas. O retorno desta página não libera acesso.</p>
    <div class="payment-details">
      <div><strong>Aluno:</strong> <span id="modal-name">-</span></div>
      <div><strong>E-mail:</strong> <span id="modal-email">-</span></div>
      <div><strong>Turma:</strong> <span id="modal-course">-</span></div>
      <div><strong>Valor:</strong> <span id="modal-total">-</span></div>
      <div><strong>Forma de pagamento:</strong> <span id="modal-billing">-</span></div>
      <div><strong>Transação:</strong> <span id="modal-transaction">-</span></div>
      <div><strong>Código único:</strong> <span class="payment-code" id="modal-code">-</span></div>
    </div>
    <div class="pix-grid" id="pix-grid">
      <div class="pix-qr" id="pix-qr">QR</div>
      <div>
        <label for="pix-payload">Pix copia-e-cola</label>
        <textarea id="pix-payload" class="pix-copy" readonly></textarea>
        <button class="btn btn-sec" style="margin-top:10px" onclick="copyPix()" type="button">Copiar Pix</button>
      </div>
    </div>
    <div class="payment-link-box" id="payment-link-box">
      <p id="payment-link-text">Abra a página segura do Asaas para concluir o pagamento.</p>
      <a class="btn btn-accent" id="payment-url" target="_blank" rel="noopener">Abrir pagamento</a>
    </div>
    <div class="payment-link-box" id="boleto-box">
      <p>Boleto gerado. Copie a linha digitável abaixo para pagar no banco ou aplicativo.</p>
      <textarea id="boleto-line" class="pix-copy" readonly></textarea>
      <button class="btn btn-sec" style="margin-top:10px" onclick="copyBoleto()" type="button">Copiar linha digitável</button>
    </div>
    <div class="modal-actions">
      <a class="btn btn-sec" id="modal-login-link" href="${loginUrl}">Fazer login</a>
      <a class="btn btn-accent" id="modal-signup-link" href="${loginUrl}?signup=1&paid=1&turma=${encodeURIComponent(turma.id)}">Criar cadastro</a>
    </div>
    <p class="modal-note">Após o pagamento, faça login ou crie cadastro com o mesmo e-mail. Se sair desta tela, use o código único para concluir o cadastro depois.</p>
  </div>
</div>
<script>
const siteSlug=${jsonForScript(site.slug)}
const turmaId=${jsonForScript(turma.id)}
const paymentSettings=${jsonForScript(paymentSettings)}
function show(id,msg){const el=document.getElementById(id);el.textContent=msg;el.style.display='block'}
function hideAlerts(){document.getElementById('alert-err').style.display='none';document.getElementById('alert-ok').style.display='none'}
function copyPix(){const el=document.getElementById('pix-payload');el.select();document.execCommand('copy')}
function copyBoleto(){const el=document.getElementById('boleto-line');el.select();document.execCommand('copy')}
function formatMoneyBR(value){return 'R$ '+Number(value||0).toLocaleString('pt-BR',{minimumFractionDigits:2,maximumFractionDigits:2})}
function onlyDigits(value){return String(value||'').replace(/\D/g,'')}
function maskCardNumber(value){return onlyDigits(value).slice(0,19).replace(/(\d{4})(?=\d)/g,'$1 ').trim()}
function maskCep(value){const d=onlyDigits(value).slice(0,8);return d.replace(/(\d{5})(\d)/,'$1-$2')}
function formatCpf(value){
  const digits=onlyDigits(value).slice(0,11)
  return digits.replace(/(\d{3})(\d)/,'$1.$2').replace(/(\d{3})(\d)/,'$1.$2').replace(/(\d{3})(\d{1,2})$/,'$1-$2')
}
function maskCpfInput(input){input.value=formatCpf(input.value)}
function isValidCpf(value){
  const cpf=onlyDigits(value)
  if(cpf.length!==11||/^(\\d)\\1{10}$/.test(cpf)) return false
  const calc=(base,factor)=>{
    let sum=0
    for(const digit of base) sum+=Number(digit)*factor--
    const rest=(sum*10)%11
    return rest===10?0:rest
  }
  return calc(cpf.slice(0,9),10)===Number(cpf[9])&&calc(cpf.slice(0,10),11)===Number(cpf[10])
}
function validateCpfField(input){
  const status=document.getElementById(input.id+'-status')
  const cpf=onlyDigits(input.value)
  maskCpfInput(input)
  input.classList.remove('is-valid','is-invalid')
  status?.classList.remove('valid','invalid')
  if(!cpf){if(status)status.textContent='';input.setCustomValidity('');return false}
  if(cpf.length<11){if(status){status.textContent='Digite os 11 números do CPF.';status.classList.add('invalid')}input.classList.add('is-invalid');input.setCustomValidity('Digite os 11 números do CPF.');return false}
  if(!isValidCpf(cpf)){if(status){status.textContent='CPF inválido. Confira os números digitados.';status.classList.add('invalid')}input.classList.add('is-invalid');input.setCustomValidity('CPF inválido.');return false}
  if(status){status.textContent='CPF válido.';status.classList.add('valid')}
  input.classList.add('is-valid')
  input.setCustomValidity('')
  return true
}
let cpfLookupState={exists:false,same_site:false,active:true,email_hint:''}
let cpfLookupTimer
async function lookupCpfAccount(input){
  if(!validateCpfField(input)){cpfLookupState={exists:false,same_site:false,active:true,email_hint:''};return}
  const cpf=onlyDigits(input.value)
  const status=document.getElementById(input.id+'-status')
  clearTimeout(cpfLookupTimer)
  cpfLookupTimer=setTimeout(async()=>{
    try{
      const res=await fetch('/api/site/'+encodeURIComponent(siteSlug)+'/cpf-lookup?cpf='+encodeURIComponent(cpf))
      const data=await res.json().catch(()=>({}))
      if(onlyDigits(input.value)!==cpf)return
      cpfLookupState={exists:Boolean(data.exists),same_site:Boolean(data.same_site),active:data.active!==false,email_hint:data.email_hint||''}
      if(status&&data.exists){
        status.textContent='CPF já tem cadastro neste site'+(data.email_hint?' ('+data.email_hint+')':'')+'. Após pagar, use Fazer login.'
        status.classList.remove('invalid');status.classList.add('valid')
      }else if(status){
        status.textContent='CPF válido. Após pagar, você poderá criar seu cadastro.'
        status.classList.remove('invalid');status.classList.add('valid')
      }
    }catch{}
  },350)
}
function applyCheckoutAccessLinks(hasAccount, loginHref, signupHref){
  const loginEls=[document.getElementById('login-link'),document.getElementById('modal-login-link')].filter(Boolean)
  const signupEls=[document.getElementById('signup-link'),document.getElementById('modal-signup-link')].filter(Boolean)
  loginEls.forEach((el)=>{el.href=loginHref;el.textContent=hasAccount?'Fazer login para acessar':'Fazer login'})
  signupEls.forEach((el)=>{el.href=signupHref;el.style.display=hasAccount?'none':''})
  const postNote=document.querySelector('#postpay .note')
  const modalNote=document.querySelector('.modal-note')
  const msg=hasAccount
    ? 'Identificamos cadastro para este CPF neste site. Após o pagamento, faça login com sua senha atual para acessar.'
    : 'Após o pagamento, crie cadastro com o mesmo e-mail. Se sair desta tela, use o código único para concluir o cadastro depois.'
  if(postNote)postNote.textContent=msg
  if(modalNote)modalNote.textContent=msg
}
document.querySelectorAll('input[data-mask="cpf"], input[id*="cpf"]').forEach((input)=>{
  input.addEventListener('input',(event)=>lookupCpfAccount(event.target))
  input.addEventListener('blur',(event)=>lookupCpfAccount(event.target))
  if(input.value) maskCpfInput(input)
})
document.getElementById('card-number')?.addEventListener('input',(event)=>{event.target.value=maskCardNumber(event.target.value)})
document.getElementById('card-postal')?.addEventListener('input',(event)=>{event.target.value=maskCep(event.target.value)})
document.getElementById('card-month')?.addEventListener('input',(event)=>{event.target.value=onlyDigits(event.target.value).slice(0,2)})
document.getElementById('card-year')?.addEventListener('input',(event)=>{event.target.value=onlyDigits(event.target.value).slice(0,4)})
document.getElementById('card-ccv')?.addEventListener('input',(event)=>{event.target.value=onlyDigits(event.target.value).slice(0,4)})
function updatePaymentUi(){
  const billingType=document.querySelector('input[name="billing-type"]:checked')?.value||'PIX'
  const box=document.getElementById('installment-box')
  if(box) box.classList.toggle('hidden', billingType!=='CREDIT_CARD')
  const cardBox=document.getElementById('card-box')
  if(cardBox) cardBox.classList.toggle('hidden', billingType!=='CREDIT_CARD')
  const total=document.getElementById('checkout-total')
  const base=Number(total?.dataset.base||0)
  const fee=paymentSettings.feePayer==='ALUNO'&&billingType==='CREDIT_CARD'?Number(paymentSettings.feePercent||0):0
  if(total) total.textContent=formatMoneyBR(Math.round(base*(1+fee/100)*100)/100)
}
document.querySelectorAll('input[name="billing-type"]').forEach(input=>input.addEventListener('change',updatePaymentUi))
updatePaymentUi()
function collectCardData(){
  const number=onlyDigits(document.getElementById('card-number')?.value)
  const holderName=document.getElementById('card-holder')?.value.trim()||''
  const expiryMonth=onlyDigits(document.getElementById('card-month')?.value).padStart(2,'0')
  const expiryYear=onlyDigits(document.getElementById('card-year')?.value)
  const ccv=onlyDigits(document.getElementById('card-ccv')?.value)
  const postalCode=onlyDigits(document.getElementById('card-postal')?.value)
  const addressNumber=onlyDigits(document.getElementById('card-address-number')?.value)
  const phone=onlyDigits(document.getElementById('card-phone')?.value)
  if(number.length<13||!holderName||expiryMonth.length!==2||expiryYear.length<2||ccv.length<3||postalCode.length!==8||!addressNumber){
    show('alert-err','Preencha os dados do cartão, CEP e número do endereço.')
    return null
  }
  return {holderName,number,expiryMonth,expiryYear,ccv,holderPostalCode:postalCode,holderAddressNumber:addressNumber,holderPhone:phone}
}
async function simulatePayment(event){
  event.preventDefault();hideAlerts()
  const btn=document.getElementById('btn-pay')
  const email=document.getElementById('payer-email').value.trim().toLowerCase()
  const nome=document.getElementById('payer-name').value.trim()
  const cpf=onlyDigits(document.getElementById('payer-cpf').value)
  const billingType=document.querySelector('input[name="billing-type"]:checked')?.value||'PIX'
  const installments=Number(document.getElementById('payer-installments')?.value||1)
  const billingLabel=billingType==='BOLETO'?'Boleto':(billingType==='CREDIT_CARD'?'Cartão':'Pix')
  if(!nome){show('alert-err','Informe seu nome para registrar a matrícula.');return}
  if(!email){show('alert-err','Informe o e-mail para vincular a matrícula.');return}
  if(!validateCpfField(document.getElementById('payer-cpf'))){show('alert-err','Informe um CPF válido para vincular a matrícula.');return}
  const card=billingType==='CREDIT_CARD'?collectCardData():null
  if(billingType==='CREDIT_CARD'&&!card)return
  btn.disabled=true;btn.textContent=billingType==='PIX'?'Gerando Pix...':'Gerando cobrança...'
  try{
    const res=await fetch('/api/site/'+encodeURIComponent(siteSlug)+'/checkout',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({turma_id:turmaId,email,nome,cpf,billing_type:billingType,installments,card})})
    const data=await res.json()
    if(!res.ok){show('alert-err',data.error||'Não foi possível finalizar o pagamento.');return}
    const code=data.checkout_code||''
    const transactionId=data.transaction_id||''
    const returnedBilling=data.billing_label||billingLabel
    show('alert-ok',returnedBilling+' gerado. A matrícula será liberada após confirmação do pagamento.')
    document.getElementById('pay-form').style.display='none'
    document.getElementById('postpay').classList.add('open')
    const loginHref='${loginUrl}?paid=1&turma='+encodeURIComponent(turmaId)+'&email='+encodeURIComponent(email)
    const signupHref='${loginUrl}?signup=1&paid=1&turma='+encodeURIComponent(turmaId)+'&email='+encodeURIComponent(email)+'&nome='+encodeURIComponent(nome)+'&cpf='+encodeURIComponent(cpf)+'&checkout_code='+encodeURIComponent(code)
    applyCheckoutAccessLinks(Boolean(data.has_account||cpfLookupState.exists),loginHref,signupHref)
    document.getElementById('payment-title').textContent=data.billing_type==='PIX'?'Pague com Pix para liberar a turma':'Conclua o pagamento para liberar a turma'
    document.getElementById('modal-name').textContent=nome
    document.getElementById('modal-email').textContent=email
    document.getElementById('modal-course').textContent=data.turma_nome||'${esc(turma.nome)}'
    document.getElementById('modal-total').textContent=data.total?('R$ '+Number(data.total).toLocaleString('pt-BR',{minimumFractionDigits:2,maximumFractionDigits:2})):'${price}'
    document.getElementById('modal-billing').textContent=returnedBilling
    document.getElementById('modal-transaction').textContent=transactionId||'-'
    document.getElementById('modal-code').textContent=code||'-'
    const img=data.pix&&data.pix.encodedImage
    const pixGrid=document.getElementById('pix-grid')
    const linkBox=document.getElementById('payment-link-box')
    const boletoBox=document.getElementById('boleto-box')
    const paymentUrl=data.payment_url||''
    if(data.billing_type==='PIX'){
      pixGrid.classList.remove('hidden')
      document.getElementById('pix-qr').innerHTML=img?'<img alt="QR Code Pix" src="data:image/png;base64,'+img+'">':'QR Code indisponível'
      document.getElementById('pix-payload').value=(data.pix&&data.pix.payload)||''
      linkBox.classList.remove('open')
      boletoBox.classList.remove('open')
    }else if(data.billing_type==='BOLETO'){
      pixGrid.classList.add('hidden')
      linkBox.classList.remove('open')
      boletoBox.classList.add('open')
      document.getElementById('boleto-line').value=(data.boleto&&data.boleto.identificationField)||''
    }else{
      pixGrid.classList.add('hidden')
      boletoBox.classList.remove('open')
      linkBox.classList.toggle('open',Boolean(paymentUrl))
    }
    document.getElementById('payment-link-text').textContent='Pagamento por cartão enviado. A liberação acontece após confirmação do Asaas.'
    document.getElementById('payment-url').href=paymentUrl||'#'
    document.getElementById('payment-url').style.pointerEvents=paymentUrl?'auto':'none'
    document.getElementById('payment-url').textContent='Ver cobrança'
    try{localStorage.setItem('checkout:'+siteSlug+':'+turmaId,JSON.stringify({nome,email,cpf,checkout_code:code,transaction_id:transactionId,created_at:new Date().toISOString()}))}catch{}
    const approvedStatuses=['RECEIVED','CONFIRMED','RECEIVED_IN_CASH']
    const isApproved=approvedStatuses.includes(String(data.status||'').toUpperCase())
    if(isApproved){
      const hasAccount=Boolean(data.has_account||cpfLookupState.exists)
      show('alert-ok','Pagamento aprovado no sandbox. Direcionando para '+(hasAccount?'login':'cadastro')+'...')
      setTimeout(()=>{location.href=hasAccount?loginHref:signupHref},900)
      return
    }
    document.getElementById('payment-modal').classList.add('open')
  }catch{show('alert-err','Erro de conexão. Tente novamente.')}
  finally{btn.disabled=false;btn.textContent='Finalizar pagamento'}
}
</script>
</body>
</html>`
}

function renderPostPage(data: { site: any; turmas: any[] }, post: any) {
  const { site } = data
  const cms = parseCms(site)
  const layout = cms.layout
  const theme = normalizeTheme(cms.theme, site.cor_primaria, site.cor_accent)
  const brand = theme.primary
  const accent = theme.accent
  const brandText = theme.primaryText
  const accentText = theme.accentText
  const brandTextSoft = alphaColor(brandText, 0.72)
  const sitePath = `/redacao/${encodeURIComponent(site.slug)}`
  const loginUrl = `${sitePath}/login`
  const whatsappPhone = String(cms.contact?.whatsapp_phone || '5521971214042').replace(/\D/g, '') || '5521971214042'
  const whatsapp = `http://api.whatsapp.com/send?phone=${whatsappPhone}`
  const articleBody = post.conteudo ? sanitizeRichHtml(post.conteudo) : esc(post.resumo || '')

  return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(post.titulo)} — ${esc(site.nome_prof)}</title>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700;800;900&display=swap" rel="stylesheet">
<style>
*{box-sizing:border-box;margin:0;padding:0}
:root{--brand:${esc(brand)};--brand-text:${esc(brandText)};--brand-text-soft:${esc(brandTextSoft)};--accent:${esc(accent)};--accent-text:${esc(accentText)};--surface:${esc(theme.background)};--card:${esc(theme.card)};--ink:${esc(theme.text)};--ink2:${esc(theme.textSoft)};--ink3:${esc(theme.textMuted)};--border:${esc(theme.border)}}
body{font-family:'Inter',system-ui,sans-serif;background:var(--surface);color:var(--ink);-webkit-font-smoothing:antialiased}
a{text-decoration:none;color:inherit}.nav{height:64px;background:var(--brand);color:var(--brand-text);display:flex;align-items:center;justify-content:space-between;padding:0 6%;position:sticky;top:0;z-index:10}
.brand{display:flex;align-items:center;gap:10px;font-weight:800}.mark{background:var(--accent);color:var(--accent-text);font-size:10px;font-weight:900;padding:3px 9px;border-radius:5px;text-transform:uppercase}
.nav-actions{display:flex;gap:10px;align-items:center}.nav-link{font-size:13px;color:var(--brand-text-soft)}
.btn{display:inline-flex;align-items:center;justify-content:center;border:none;border-radius:8px;padding:11px 18px;font-size:13px;font-weight:800;cursor:pointer}.btn-light{background:#fff;color:var(--brand)}.btn-dark{background:var(--brand);color:var(--brand-text)}
.article-hero{background:var(--brand);color:var(--brand-text);padding:70px 6% 54px}.article-hero .type{display:inline-flex;background:rgba(255,255,255,.12);border:1px solid rgba(255,255,255,.18);padding:6px 13px;border-radius:999px;font-size:11px;font-weight:900;text-transform:uppercase;letter-spacing:.08em;margin-bottom:22px}
h1{font-size:clamp(34px,5vw,58px);line-height:1.04;font-weight:900;max-width:900px}.summary{color:var(--brand-text-soft);font-size:17px;line-height:1.7;max-width:780px;margin-top:18px}
.article-wrap{max-width:920px;margin:0 auto;padding:46px 22px 76px}.article-body{background:var(--card);border:1px solid var(--border);border-radius:12px;padding:34px;font-size:17px;line-height:1.85;color:var(--ink2)}
.article-body:empty:before{content:'Conteúdo em preparação.';color:var(--ink3)}.article-actions{display:flex;gap:10px;flex-wrap:wrap;margin-top:22px}
.rich-output img{max-width:100%;border-radius:12px;display:block;margin:14px 0}.rich-output ul,.rich-output ol{padding-left:26px;margin:12px 0}.rich-output li{margin:6px 0}.rich-output a{color:var(--brand);font-weight:800;text-decoration:underline}.rich-output blockquote{border-left:4px solid var(--accent);padding:10px 14px;background:rgba(0,0,0,.04);border-radius:8px;margin:14px 0}.rich-output p{margin:0 0 14px}.rich-output h2,.rich-output h3,.rich-output h4{color:var(--ink);line-height:1.25;margin:18px 0 10px}
.whatsapp-float{position:fixed;right:22px;bottom:22px;width:58px;height:58px;border-radius:50%;background:#25D366;color:#fff;display:flex;align-items:center;justify-content:center;box-shadow:0 12px 28px rgba(0,0,0,.22);z-index:200;border:3px solid #fff}
.whatsapp-float svg{width:32px;height:32px;display:block}
@media(max-width:760px){.nav-actions .nav-link{display:none}.article-body{padding:24px;font-size:15px}}
</style>
</head>
<body>
<nav class="nav">
  <a class="brand" href="${sitePath}"><span class="mark">${esc(layout.header_label || defaultCms().layout.header_label)}</span><span>${esc(site.nome_prof)}</span></a>
  <div class="nav-actions">
    <a class="nav-link" href="${sitePath}#turmas">Turmas</a>
    <a class="nav-link" href="${sitePath}#conteudos">Conteúdos</a>
    <a class="btn btn-light" href="${loginUrl}">Entrar</a>
  </div>
</nav>
<header class="article-hero">
  <div class="type">${esc(postTypeLabel(post.tipo))}${post.pinned ? ' · Destaque' : ''}</div>
  <h1>${esc(post.titulo)}</h1>
  ${post.resumo ? `<p class="summary">${esc(post.resumo)}</p>` : ''}
</header>
<main class="article-wrap">
  <article class="article-body rich-output">${articleBody}</article>
  <div class="article-actions">
    <a class="btn btn-dark" href="${sitePath}#conteudos">Voltar aos conteúdos</a>
  </div>
</main>
<a class="whatsapp-float" href="${whatsapp}" target="_blank" rel="noopener" aria-label="Falar no WhatsApp">
  <svg viewBox="0 0 32 32" aria-hidden="true">
    <path fill="currentColor" d="M16.02 3.2A12.73 12.73 0 0 0 5.11 22.5L3.2 29l6.68-1.78A12.72 12.72 0 1 0 16.02 3.2Zm0 23.18c-2.05 0-3.96-.6-5.57-1.65l-.4-.25-3.96 1.05 1.06-3.84-.26-.4a10.34 10.34 0 1 1 9.13 5.09Zm5.67-7.75c-.31-.16-1.84-.91-2.13-1.01-.29-.11-.5-.16-.71.15-.21.31-.82 1.01-1 1.22-.18.21-.37.24-.68.08-.31-.16-1.31-.48-2.5-1.54-.92-.82-1.55-1.84-1.73-2.15-.18-.31-.02-.48.14-.64.14-.14.31-.37.47-.55.16-.18.21-.31.31-.52.11-.21.05-.39-.03-.55-.08-.16-.71-1.71-.97-2.34-.25-.61-.51-.52-.71-.53h-.6c-.21 0-.55.08-.84.39-.29.31-1.1 1.08-1.1 2.63s1.13 3.05 1.29 3.26c.16.21 2.23 3.4 5.39 4.76.75.32 1.34.52 1.8.66.76.24 1.45.21 1.99.13.61-.09 1.84-.75 2.1-1.47.26-.72.26-1.34.18-1.47-.08-.13-.29-.21-.6-.37Z"/>
  </svg>
</a>
</body>
</html>`
}

function renderVideoCoursePage(data: { site: any; turmas: any[] }, course: any) {
  const { site } = data
  const cms = parseCms(site)
  const layout = cms.layout
  const theme = normalizeTheme(cms.theme, site.cor_primaria, site.cor_accent)
  const sitePath = `/redacao/${encodeURIComponent(site.slug)}`
  const loginUrl = `${sitePath}/login`
  const cover = String(course.cover_url || '')
  const duration = Number(course.duration_hours || 0)
  const lessons = Number(course.lessons_count || 0)
  const summary = String(course.summary || course.description || 'Aulas gravadas com acesso protegido para alunos matriculados.')
  const description = String(course.description || summary)
  return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(course.title || 'Curso em vídeo')} — ${esc(site.nome_prof)}</title>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700;800;900&display=swap" rel="stylesheet">
<style>
*{box-sizing:border-box;margin:0;padding:0}
:root{--brand:${esc(theme.primary)};--brand-text:${esc(theme.primaryText)};--accent:${esc(theme.accent)};--accent-text:${esc(theme.accentText)};--surface:${esc(theme.background)};--card:${esc(theme.card)};--ink:${esc(theme.text)};--ink2:${esc(theme.textSoft)};--ink3:${esc(theme.textMuted)};--border:${esc(theme.border)}}
body{font-family:'Inter',system-ui,sans-serif;background:var(--surface);color:var(--ink);max-width:100%;overflow-x:hidden}
a{text-decoration:none;color:inherit}.nav{height:64px;background:var(--brand);color:var(--brand-text);display:flex;align-items:center;justify-content:space-between;padding:0 6%;position:sticky;top:0;z-index:10}
.brand{display:flex;align-items:center;gap:10px;font-weight:900}.mark{background:var(--accent);color:var(--accent-text);font-size:10px;font-weight:900;padding:4px 9px;border-radius:6px;text-transform:uppercase}
.nav-actions{display:flex;gap:10px;align-items:center}.nav-link{font-size:13px;opacity:.78}.btn{display:inline-flex;align-items:center;justify-content:center;border:0;border-radius:9px;padding:13px 18px;font-size:13px;font-weight:900;cursor:pointer}.btn-accent{background:var(--accent);color:var(--accent-text)}.btn-light{background:#fff;color:var(--brand)}
.hero{background:var(--brand);color:var(--brand-text);padding:70px 6%;display:grid;grid-template-columns:minmax(0,1.1fr) minmax(280px,.7fr);gap:44px;align-items:center}.eyebrow{display:inline-flex;background:rgba(255,255,255,.12);border:1px solid rgba(255,255,255,.18);padding:7px 12px;border-radius:999px;font-size:11px;font-weight:900;text-transform:uppercase;margin-bottom:18px}
h1{font-size:clamp(36px,6vw,66px);line-height:1.02;font-weight:900;max-width:850px}.desc{font-size:17px;line-height:1.65;opacity:.82;max-width:760px;margin-top:18px}.hero-actions{display:flex;gap:12px;flex-wrap:wrap;margin-top:28px}
.cover{aspect-ratio:4/3;border-radius:20px;overflow:hidden;background:#111;box-shadow:0 30px 70px rgba(0,0,0,.28);display:flex;align-items:center;justify-content:center;font-size:54px}.cover img{width:100%;height:100%;object-fit:cover;display:block}
.details{padding:42px 6% 74px;display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:16px}.info-card{border:1px solid var(--border);border-radius:14px;background:var(--card);padding:20px}.info-card strong{display:block;font-size:15px;margin-bottom:8px}.info-card p{font-size:13px;line-height:1.6;color:var(--ink3)}
.full{grid-column:1/-1}.price{font-size:28px;font-weight:900;color:var(--brand);margin-top:6px}.lesson-meta{display:flex;gap:8px;flex-wrap:wrap;margin-top:14px}.lesson-meta span{background:var(--surface);border:1px solid var(--border);border-radius:999px;padding:7px 10px;font-size:12px;font-weight:800;color:var(--ink2)}
.checkout-box{grid-column:1/-1;border:1px solid var(--border);border-radius:18px;background:var(--card);padding:22px;min-width:0}.checkout-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px;margin-top:16px}.field{display:flex;flex-direction:column;gap:6px;min-width:0}.field label{font-size:12px;font-weight:900;color:var(--ink2)}input,select,textarea{font:inherit;border:1px solid var(--border);border-radius:10px;padding:12px;background:#fff;color:var(--ink);width:100%;min-width:0}.cpf-status{display:none;font-size:11px;font-weight:800}.cpf-status.invalid{display:block;color:#b42318}.cpf-status.valid{display:block;color:#067647}.pay-methods{display:flex;gap:8px;flex-wrap:wrap;margin:14px 0}.pay-methods label{border:1px solid var(--border);border-radius:999px;padding:9px 12px;font-size:12px;font-weight:900;cursor:pointer}.card-fields{display:none;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px;margin-top:10px}.card-fields.open{display:grid}.checkout-alert{display:none;border-radius:10px;padding:12px;margin-top:12px;font-size:13px;font-weight:700}.checkout-alert.err{display:block;background:#fff0f0;color:#b42318;border:1px solid #ffd2d2}.checkout-alert.ok{display:block;background:#ecfdf3;color:#067647;border:1px solid #abefc6}.field-focus input{border-color:#f04438;box-shadow:0 0 0 4px rgba(240,68,56,.14)}.payment-result{display:none;margin-top:16px;border:1px solid var(--border);border-radius:14px;padding:16px;background:var(--surface);min-width:0}.payment-result.open{display:block}.qr-row{display:grid;grid-template-columns:180px minmax(0,1fr);gap:14px;align-items:start}.qr-row img{width:180px;max-width:100%;border:1px solid var(--border);border-radius:12px;background:#fff;justify-self:center}.payment-code{font-weight:900}.login-actions{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-top:14px}
@media(max-width:780px){.hero{grid-template-columns:1fr;padding:48px 22px}.details{grid-template-columns:1fr;padding:26px 16px 52px}.nav-actions .nav-link{display:none}.btn{width:100%}.hero-actions{flex-direction:column}}
@media(max-width:780px){.nav{padding:0 16px}.brand span:last-child{max-width:170px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.checkout-grid,.card-fields,.login-actions,.qr-row{grid-template-columns:1fr}.pay-methods{display:grid;grid-template-columns:1fr}.pay-methods label{text-align:center}.cover{max-width:360px;width:100%;justify-self:center}.payment-result{padding:14px}.qr-row textarea{min-height:150px}}
</style>
</head>
<body>
<nav class="nav">
  <a class="brand" href="${sitePath}"><span class="mark">${esc(layout.header_label || 'Redação')}</span><span>${esc(site.nome_prof)}</span></a>
  <div class="nav-actions">
    <a class="nav-link" href="${sitePath}#turmas">Turmas</a>
    <a class="nav-link" href="${sitePath}#cursos-video">Cursos em vídeo</a>
    <a class="btn btn-light" href="${loginUrl}">Entrar</a>
  </div>
</nav>
<header class="hero">
  <div>
    <span class="eyebrow">Curso em vídeo protegido</span>
    <h1>${esc(course.title || 'Curso em vídeo')}</h1>
    <p class="desc">${esc(summary)}</p>
    <div class="lesson-meta">
      ${duration > 0 ? `<span>${esc(String(duration).replace('.', ','))}h de aulas</span>` : ''}
      ${lessons > 0 ? `<span>${lessons} aula(s)</span>` : ''}
      <span>continua de onde parou</span>
      <span>anotações do aluno</span>
    </div>
    <div class="hero-actions">
      <a class="btn btn-accent" href="#checkout-video">Comprar curso</a>
      <a class="btn btn-light" href="${sitePath}#cursos-video">Ver outros cursos</a>
    </div>
  </div>
  <div class="cover">${cover ? `<img src="${esc(cover)}" alt="${esc(course.title || 'Curso em vídeo')}">` : '▶'}</div>
</header>
<main class="details">
  <section class="info-card">
    <strong>O que você recebe</strong>
    <p>${esc(description)}</p>
  </section>
  <section class="info-card">
    <strong>Acesso do aluno</strong>
    <p>As aulas ficam disponíveis dentro do painel do aluno, com progresso salvo e área de anotações.</p>
  </section>
  <section class="info-card">
    <strong>Proteção do vídeo</strong>
    <p>O player foi preparado para usar Cloudflare Stream com acesso temporário quando a integração for ativada.</p>
  </section>
  <section class="info-card full">
    <strong>Investimento</strong>
    <div class="price">${moneyBR(Number(course.price || 0))}</div>
    <p>Finalize o pagamento por aqui. O acesso ao curso é liberado automaticamente após confirmação do Asaas.</p>
  </section>
  <section class="checkout-box" id="checkout-video">
    <strong>Comprar este curso</strong>
    <p style="font-size:13px;color:var(--ink3);line-height:1.6;margin-top:6px">Finalize pelo ambiente sandbox. O acesso só é liberado após confirmação do webhook do Asaas.</p>
    <div id="video-checkout-error" class="checkout-alert"></div>
    <form onsubmit="startVideoCheckout(event)">
      <div class="checkout-grid">
        <div class="field"><label>Nome completo</label><input id="vc-nome" required autocomplete="name"></div>
        <div class="field"><label>E-mail</label><input id="vc-email" type="email" required autocomplete="email"></div>
        <div class="field"><label>CPF</label><input id="vc-cpf" required inputmode="numeric" maxlength="14" autocomplete="off" oninput="onVideoCpfInput(this)"><small id="vc-cpf-status" class="cpf-status" aria-live="polite"></small></div>
      </div>
      <div class="pay-methods">
        <label><input type="radio" name="vc-pay" value="PIX" checked onchange="updateVideoPayFields()"> Pix</label>
        <label><input type="radio" name="vc-pay" value="BOLETO" onchange="updateVideoPayFields()"> Boleto</label>
        <label><input type="radio" name="vc-pay" value="CREDIT_CARD" onchange="updateVideoPayFields()"> Cartão</label>
      </div>
      <div class="field" id="vc-installments-wrap" style="display:none;max-width:220px"><label>Parcelas</label><select id="vc-installments">${Array.from({ length: Math.max(1, Math.min(12, Math.floor(Number(course.price || 0) / 5) || 1)) }, (_, i) => `<option value="${i + 1}">${i + 1}x</option>`).join('')}</select></div>
      <div class="card-fields" id="vc-card-fields">
        <div class="field"><label>Número do cartão</label><input id="vc-card-number" inputmode="numeric" autocomplete="off"></div>
        <div class="field"><label>Nome no cartão</label><input id="vc-card-holder" autocomplete="cc-name"></div>
        <div class="field"><label>CVV</label><input id="vc-card-ccv" inputmode="numeric" autocomplete="off"></div>
        <div class="field"><label>Mês</label><input id="vc-card-month" inputmode="numeric" placeholder="MM" maxlength="2"></div>
        <div class="field"><label>Ano</label><input id="vc-card-year" inputmode="numeric" placeholder="AAAA" maxlength="4"></div>
        <div class="field"><label>CEP</label><input id="vc-card-cep" inputmode="numeric" maxlength="9"></div>
        <div class="field"><label>Número do endereço</label><input id="vc-card-address" inputmode="numeric"></div>
        <div class="field"><label>Telefone</label><input id="vc-card-phone" inputmode="numeric"></div>
      </div>
      <button class="btn btn-accent" id="vc-submit" style="margin-top:16px">Finalizar pagamento</button>
    </form>
    <div class="payment-result" id="video-payment-result">
      <strong id="video-payment-title">Pagamento iniciado</strong>
      <p style="font-size:13px;color:var(--ink3);margin-top:6px">Código único: <span class="payment-code" id="video-payment-code">-</span></p>
      <div id="video-payment-body" style="margin-top:12px"></div>
      <div class="login-actions">
        <a class="btn btn-light" id="video-login-link" href="${loginUrl}">Fazer login</a>
        <a class="btn btn-accent" id="video-signup-link" href="${loginUrl}">Criar cadastro</a>
      </div>
    </div>
  </section>
</main>
<script>
const videoCourseId=${jsonForScript(String(course.id || ''))}
const videoLoginBase=${jsonForScript(loginUrl)}
function onlyDigits(v){return String(v||'').replace(/\\D/g,'')}
function formatCpf(v){const d=onlyDigits(v).slice(0,11);return d.replace(/(\\d{3})(\\d)/,'$1.$2').replace(/(\\d{3})(\\d)/,'$1.$2').replace(/(\\d{3})(\\d{1,2})$/,'$1-$2')}
function isValidCpf(v){const cpf=onlyDigits(v);if(cpf.length!==11||/^(\\d)\\1{10}$/.test(cpf))return false;const calc=(base,factor)=>{let sum=0;for(const digit of base)sum+=Number(digit)*factor--;const rest=(sum*10)%11;return rest===10?0:rest};return calc(cpf.slice(0,9),10)===Number(cpf[9])&&calc(cpf.slice(0,10),11)===Number(cpf[10])}
let videoCpfLookup={exists:false}
let videoCpfTimer
function setVideoCpfStatus(msg,type){const el=document.getElementById('vc-cpf-status');if(!el)return;el.textContent=msg;el.className='cpf-status '+type}
function onVideoCpfInput(input){input.value=formatCpf(input.value);const cpf=onlyDigits(input.value);clearTimeout(videoCpfTimer);videoCpfLookup={exists:false};if(!cpf){setVideoCpfStatus('','');return}if(cpf.length<11){setVideoCpfStatus('Digite os 11 números do CPF.','invalid');return}if(!isValidCpf(cpf)){setVideoCpfStatus('CPF inválido. Confira os números digitados.','invalid');return}setVideoCpfStatus('CPF válido. Verificando cadastro...','valid');videoCpfTimer=setTimeout(async()=>{try{const res=await fetch('/api/site/${encodeURIComponent(site.slug)}/cpf-lookup?cpf='+encodeURIComponent(cpf));const data=await res.json().catch(()=>({}));if(onlyDigits(input.value)!==cpf)return;videoCpfLookup={exists:Boolean(data.exists)};setVideoCpfStatus(data.exists?'CPF já tem cadastro neste site'+(data.email_hint?' ('+data.email_hint+')':'')+'. Após pagar, use Fazer login.':'CPF válido. Após pagar, você poderá criar seu cadastro.','valid')}catch{}},350)}
function payChoice(){return document.querySelector('input[name="vc-pay"]:checked')?.value||'PIX'}
function updateVideoPayFields(){const card=payChoice()==='CREDIT_CARD';document.getElementById('vc-card-fields').classList.toggle('open',card);document.getElementById('vc-installments-wrap').style.display=card?'flex':'none'}
function showVideoError(msg){const el=document.getElementById('video-checkout-error');el.textContent=msg;el.className='checkout-alert err'}
function clearVideoError(){const el=document.getElementById('video-checkout-error');el.textContent='';el.className='checkout-alert'}
function showVideoOk(msg){const el=document.getElementById('video-checkout-error');el.textContent=msg;el.className='checkout-alert ok'}
const cardFieldMap={card_number:'vc-card-number',card_holder:'vc-card-holder',card_month:'vc-card-month',card_year:'vc-card-year',card_ccv:'vc-card-ccv',card_cep:'vc-card-cep',card_address:'vc-card-address'}
function focusVideoField(id,msg){
  document.querySelectorAll('.field-focus').forEach(el=>el.classList.remove('field-focus'))
  const input=document.getElementById(id)
  if(!input){showVideoError(msg);return}
  input.closest('.field')?.classList.add('field-focus')
  input.scrollIntoView({behavior:'smooth',block:'center'})
  setTimeout(()=>input.focus({preventScroll:true}),250)
  showVideoError(msg)
}
function validateVideoCardFields(){
  if(payChoice()!=='CREDIT_CARD')return null
  const rules=[
    ['vc-card-number','Informe o número completo do cartão.',()=>onlyDigits(document.getElementById('vc-card-number').value).length>=13],
    ['vc-card-holder','Informe o nome do titular como aparece no cartão.',()=>document.getElementById('vc-card-holder').value.trim().length>0],
    ['vc-card-month','Informe o mês de validade com 2 dígitos.',()=>onlyDigits(document.getElementById('vc-card-month').value).length===2],
    ['vc-card-year','Informe o ano de validade com 4 dígitos.',()=>onlyDigits(document.getElementById('vc-card-year').value).length===4],
    ['vc-card-ccv','Informe o código de segurança do cartão.',()=>onlyDigits(document.getElementById('vc-card-ccv').value).length>=3],
    ['vc-card-cep','Informe o CEP do titular com 8 dígitos.',()=>onlyDigits(document.getElementById('vc-card-cep').value).length===8],
    ['vc-card-address','Informe o número do endereço do titular.',()=>onlyDigits(document.getElementById('vc-card-address').value).length>0]
  ]
  return rules.find(rule=>!rule[2]())||null
}
async function startVideoCheckout(e){
  e.preventDefault();clearVideoError()
  const nome=document.getElementById('vc-nome').value.trim()
  const email=document.getElementById('vc-email').value.trim()
  const cpf=onlyDigits(document.getElementById('vc-cpf').value)
  const billing_type=payChoice()
  const cardError=validateVideoCardFields()
  if(cardError){focusVideoField(cardError[0],cardError[1]);return}
  const payload={course_id:videoCourseId,nome,email,cpf,billing_type,installments:Number(document.getElementById('vc-installments').value||1)}
  if(billing_type==='CREDIT_CARD')payload.card={holderName:document.getElementById('vc-card-holder').value.trim(),number:onlyDigits(document.getElementById('vc-card-number').value),expiryMonth:onlyDigits(document.getElementById('vc-card-month').value),expiryYear:onlyDigits(document.getElementById('vc-card-year').value),ccv:onlyDigits(document.getElementById('vc-card-ccv').value),holderPostalCode:onlyDigits(document.getElementById('vc-card-cep').value),holderAddressNumber:onlyDigits(document.getElementById('vc-card-address').value),holderPhone:onlyDigits(document.getElementById('vc-card-phone').value)}
  const btn=document.getElementById('vc-submit');btn.disabled=true;btn.textContent='Processando...'
  try{
    const res=await fetch('/api/site/${encodeURIComponent(site.slug)}/video-checkout',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)})
    const data=await res.json().catch(()=>({}))
    if(!res.ok){focusVideoField(cardFieldMap[data.field]||'',data.error||'Não foi possível iniciar o pagamento.');return}
    const code=data.checkout_code||''
    document.getElementById('video-payment-result').classList.add('open')
    document.getElementById('video-payment-code').textContent=code||'-'
    const paid=String(data.status||'').toUpperCase()==='RECEIVED'||String(data.status||'').toUpperCase()==='CONFIRMED'
    document.getElementById('video-payment-title').textContent=paid?'Pagamento aprovado. Acesso liberado em sandbox.':data.billing_type==='PIX'?'Pague com Pix para liberar o curso':data.billing_type==='BOLETO'?'Boleto gerado para liberar o curso':'Pagamento por cartão enviado'
    if(paid)showVideoOk('Pagamento aprovado no sandbox. Faça login se já tiver cadastro ou crie cadastro com os dados desta compra.')
    const hasAccount=Boolean(data.has_account||videoCpfLookup.exists)
    const loginHref=videoLoginBase+'?paid=1&product=video&course='+encodeURIComponent(videoCourseId)+'&email='+encodeURIComponent(email)
    const signupHref=videoLoginBase+'?signup=1&paid=1&product=video&course='+encodeURIComponent(videoCourseId)+'&email='+encodeURIComponent(email)+'&nome='+encodeURIComponent(nome)+'&cpf='+encodeURIComponent(cpf)+'&checkout_code='+encodeURIComponent(code)
    document.getElementById('video-login-link').href=loginHref
    document.getElementById('video-login-link').textContent=hasAccount?'Fazer login para acessar':'Fazer login'
    document.getElementById('video-signup-link').href=signupHref
    document.getElementById('video-signup-link').style.display=hasAccount?'none':''
    if(paid){
      showVideoOk('Pagamento aprovado no sandbox. Direcionando para '+(hasAccount?'login':'cadastro')+'...')
      setTimeout(()=>{location.href=hasAccount?loginHref:signupHref},900)
      return
    }
    const body=document.getElementById('video-payment-body')
    if(paid){
      body.innerHTML='<p style="font-size:13px;color:var(--ink3)">'+(hasAccount?'Identificamos cadastro para este CPF neste site. Clique em Fazer login para acessar o curso.':'Se você ainda não tem cadastro, clique em Criar cadastro; seus dados e código de compra já irão preenchidos.')+'</p>'
    }else if(data.pix?.encodedImage||data.pix?.payload){
      body.innerHTML='<div class="qr-row">'+(data.pix.encodedImage?'<img src="data:image/png;base64,'+data.pix.encodedImage+'" alt="QR Code Pix">':'')+'<textarea readonly rows="8">'+(data.pix.payload||'')+'</textarea></div>'
    }else if(data.boleto?.identificationField){
      body.innerHTML='<textarea readonly rows="4">'+data.boleto.identificationField+'</textarea>'
    }else{
      body.innerHTML='<p style="font-size:13px;color:var(--ink3)">Aguarde a confirmação do pagamento pelo Asaas. Você também recebeu o link de cadastro por e-mail.</p>'
    }
  }catch{showVideoError('Erro de conexão. Tente novamente.')}
  finally{btn.disabled=false;btn.textContent='Finalizar pagamento'}
}
updateVideoPayFields()
</script>
</body>
</html>`
}

function renderAssetLoader(assetPath: string) {
  return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Carregando — CursosRedação</title>
<style>
body{font-family:system-ui,-apple-system,sans-serif;background:#1A3A2A;color:#fff;min-height:100vh;display:flex;align-items:center;justify-content:center;margin:0}
div{font-size:14px;color:rgba(255,255,255,.72)}
</style>
</head>
<body>
<div>Carregando...</div>
<script>
fetch(${JSON.stringify(assetPath)}, { cache: 'no-store' })
  .then((res) => {
    if (!res.ok) throw new Error('Nao foi possivel carregar a area interna.')
    return res.text()
  })
  .then((html) => {
    document.open()
    document.write(html)
    document.close()
  })
  .catch(() => {
    document.body.textContent = ''
    const box = document.createElement('div')
    box.textContent = 'Erro ao carregar a area interna.'
    document.body.appendChild(box)
  })
</script>
</body>
</html>`
}

app.get('/api/public/config', (c) => c.json({
  supabaseUrl: c.env.SUPABASE_URL,
  supabaseAnonKey: c.env.SUPABASE_ANON_KEY
}))

app.get('/api/site/:slug', async (c) => {
  const data = await loadSite(c.env, c.req.param('slug'))
  if (!data) return c.json({ error: 'Site não encontrado' }, 404)
  const cms = parseCms(data.site)
  const theme = normalizeTheme(cms.theme, data.site.cor_primaria, data.site.cor_accent)
  return c.json({ ...data, cms: { ...cms, theme }, site: { ...data.site, allowed_origins: undefined } })
})

app.get('/api/site/:slug/cpf-lookup', async (c) => {
  const cpf = onlyDigits(c.req.query('cpf'))
  if (!isValidCpf(cpf)) return c.json({ error: 'CPF inválido.' }, 400)

  const sb = getAdmin(c.env)
  const { data: site, error: siteErr } = await sb.from('sites')
    .select('id')
    .eq('slug', c.req.param('slug'))
    .eq('ativo', true)
    .maybeSingle()
  if (siteErr || !site) return c.json({ error: 'Site não encontrado' }, 404)

  const account = await lookupStudentAccountByCpf(sb, site.id, cpf)

  return c.json({
    exists: account.exists,
    same_site: account.sameSite,
    active: account.active,
    email_hint: account.emailHint,
    action: account.exists ? 'login' : 'signup'
  })
})

app.post('/api/site/:slug/checkout', async (c) => {
  if (!getConfig(c.env).flags.payments) {
    return c.json({ error: 'Pagamentos temporariamente indisponíveis.' }, 503)
  }
  if (c.env.ASAAS_ENV !== 'sandbox') {
    return c.json({ error: 'Checkout público real ainda está liberado apenas no sandbox.' }, 503)
  }

  let body: {
    turma_id?: string
    email?: string
    nome?: string
    cpf?: string
    cpf_cnpj?: string
    billing_type?: string
    installments?: number
    card?: {
      holderName?: string
      number?: string
      expiryMonth?: string
      expiryYear?: string
      ccv?: string
      holderPostalCode?: string
      holderAddressNumber?: string
      holderPhone?: string
    }
  }
  try {
    body = await c.req.json()
  } catch {
    return c.json({ error: 'Corpo inválido' }, 400)
  }
  const email = String(body.email || '').trim().toLowerCase()
  const nome = String(body.nome || '').trim()
  const cpf = onlyDigits(body.cpf || body.cpf_cnpj)
  const turmaId = String(body.turma_id || '').trim()
  const paymentChoice = normalizeCheckoutPaymentChoice(body.billing_type)
  const billingType = asaasBillingType(paymentChoice)
  const billingLabel = checkoutBillingLabel(paymentChoice)
  const card = body.card || {}
  if (!nome) return c.json({ error: 'Informe o nome para registrar a matrícula.' }, 400)
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return c.json({ error: 'Informe um e-mail válido.' }, 400)
  if (!isValidCpf(cpf)) return c.json({ error: 'Informe um CPF válido para vincular a matrícula.' }, 400)
  if (!turmaId) return c.json({ error: 'Turma obrigatória.' }, 400)
  if (paymentChoice === 'CREDIT_CARD') {
    const cardError = validateCreditCardPayload(card)
    if (cardError) return c.json(cardError, 400)
  }

  const sb = getAdmin(c.env)
  const { data: site, error: siteErr } = await sb.from('sites')
    .select('id, slug, nome_prof, allowed_origins, ativo')
    .eq('slug', c.req.param('slug'))
    .eq('ativo', true)
    .maybeSingle()
  if (siteErr || !site) return c.json({ error: 'Site não encontrado' }, 404)
  const { data: turma, error: turmaErr } = await sb.from('turmas')
    .select('id, site_id, nome, concurso, descricao, preco, status')
    .eq('id', turmaId)
    .eq('site_id', site.id)
    .maybeSingle()
  if (turmaErr) return c.json(dbError(), 500)
  if (!turma || turma.status !== 'ABERTA') return c.json({ error: 'Turma não encontrada ou fechada.' }, 404)
  const amount = Number(turma.preco || 0)
  if (!Number.isFinite(amount) || amount <= 0) return c.json({ error: 'Esta turma não possui preço válido para checkout.' }, 400)

  const cms = parseCms(site)
  const turmaSettings = cms.turma_settings?.[turmaId] || {}
  if (turmaSettings?.matriculas_abertas === false) {
    return c.json({ error: 'As matrículas desta turma estão fechadas.' }, 403)
  }
  const paymentSettings = normalizePaymentSettings(turmaSettings)
  if (!isPaymentChoiceAllowed(paymentChoice, paymentSettings)) {
    return c.json({ error: 'Forma de pagamento indisponível para esta turma.' }, 400)
  }
  const maxCardInstallments = maxCreditCardInstallmentsFor(amount, paymentSettings)
  const installments = paymentChoice === 'CREDIT_CARD'
    ? Math.max(1, Math.min(maxCardInstallments, Math.floor(Number(body.installments) || 1)))
    : 1
  const chargedAmount = checkoutChargeAmount(amount, paymentChoice, paymentSettings)

  const key = `${email}:${turmaId}`
  const previous = cms.checkout_leads?.[key] || {}
  const checkoutCode = previous.checkout_code || previous.code || makeCheckoutCode()
  const now = new Date().toISOString()
  const gateway = getPaymentGateway(c.env)
  const cpfAccount = await lookupStudentAccountByCpf(sb, site.id, cpf)

  const { data: pendingPayment } = await sb.from('payments')
    .select('id, provider_payment_id, external_reference, checkout_code, status, amount_cents, billing_type, created_at')
    .eq('site_id', site.id)
    .eq('turma_id', turma.id)
    .eq('payer_email', email)
    .eq('status', 'PENDING')
    .eq('billing_type', billingType)
    .not('provider_payment_id', 'is', null)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  if (pendingPayment?.provider_payment_id) {
    let qrCode: any = null
    let providerPayment: any = null
    let boleto: any = null
    try {
      providerPayment = await gateway.getPayment(String(pendingPayment.provider_payment_id))
      if (billingType === 'PIX') qrCode = await gateway.getPixQrCode(String(pendingPayment.provider_payment_id))
      if (billingType === 'BOLETO') boleto = await gateway.getBoletoIdentificationField(String(pendingPayment.provider_payment_id))
    } catch {
      qrCode = null
      boleto = null
    }
    const lead = {
      ...previous,
      email,
      nome,
      cpf,
      turma_id: turmaId,
      site_id: site.id,
      status: 'PENDING',
      total: amount,
      charged_total: Number(pendingPayment.amount_cents || 0) / 100 || chargedAmount,
      checkout_code: pendingPayment.checkout_code || checkoutCode,
      code: pendingPayment.checkout_code || checkoutCode,
      transaction_id: pendingPayment.provider_payment_id,
      payment_id: pendingPayment.id,
      provider_payment_id: pendingPayment.provider_payment_id,
      external_reference: pendingPayment.external_reference,
      payment_provider: 'ASAAS',
      billing_type: billingType,
      payment_choice: paymentChoice,
      installments,
      payment_url: providerPayment?.invoiceUrl || providerPayment?.bankSlipUrl || null,
      receipt: {
        aluno: nome,
        email,
        cpf,
        turma: turma.nome,
        total: Number(pendingPayment.amount_cents || 0) / 100 || chargedAmount,
        base_total: amount,
        billing_type: billingLabel,
        installments,
        transaction_id: pendingPayment.provider_payment_id,
        checkout_code: pendingPayment.checkout_code || checkoutCode
      },
      created_at: previous.created_at || pendingPayment.created_at || now,
      updated_at: now
    }
    cms.checkout_leads = {
      ...(cms.checkout_leads || {}),
      [key]: {
        ...lead,
        email_status: previous.email_status || 'not-resend-existing-pending',
        email_checked_at: previous.email_checked_at || now
      }
    }
    const save = await saveCms(c.env, site.id, cms)
    if (save.error) return c.json(dbError(), 500)
    return c.json({
      ok: true,
      reused: true,
      status: pendingPayment.status || 'PENDING',
      email,
      nome,
      turma_id: turmaId,
      checkout_code: pendingPayment.checkout_code || checkoutCode,
      transaction_id: pendingPayment.provider_payment_id,
      payment_id: pendingPayment.id,
      provider_payment_id: pendingPayment.provider_payment_id,
      external_reference: pendingPayment.external_reference,
      total: Number(pendingPayment.amount_cents || 0) / 100 || chargedAmount,
      base_total: amount,
      turma_nome: turma.nome,
      billing_type: pendingPayment.billing_type || billingType,
      payment_choice: paymentChoice,
      installments,
      billing_label: billingLabel,
      payment_url: providerPayment?.invoiceUrl || providerPayment?.bankSlipUrl || null,
      pix: {
        encodedImage: qrCode?.encodedImage || null,
        payload: qrCode?.payload || null,
        expirationDate: qrCode?.expirationDate || null
      },
      boleto: {
        identificationField: boleto?.identificationField || boleto?.barCode || null
      },
      email_sent: false,
      has_account: cpfAccount.exists,
      account_email_hint: cpfAccount.emailHint
    })
  }

  const externalReference = `ASAAS-PUB-${crypto.randomUUID()}`
  const authUsers = await sb.auth.admin.listUsers()
  const authUser = authUsers.data.users.find((item) => String(item.email || '').toLowerCase() === email)
  const cpfOwner = cpfAccount.authUser || authUsers.data.users.find((item) => onlyDigits((item.user_metadata as any)?.cpf) === cpf)
  if (cpfOwner?.id && cpfOwner.email && String(cpfOwner.email).toLowerCase() !== email) {
    return c.json({ error: 'Este CPF já está vinculado a outro e-mail cadastrado.' }, 409)
  }
  if (authUser?.id) {
    await sb.auth.admin.updateUserById(authUser.id, {
      user_metadata: { ...(authUser.user_metadata || {}), nome, role: 'ALUNO', cpf }
    })
    await sb.from('profiles').upsert({
      id: authUser.id,
      nome,
      role: 'ALUNO',
      site_id: site.id,
      ativo: false
    }, { onConflict: 'id' })
  }
  const { data: payment, error: paymentErr } = await sb.from('payments')
    .insert({
      site_id: site.id,
      turma_id: turma.id,
      aluno_id: authUser?.id || null,
      payer_email: email,
      payer_name: nome,
      provider: 'ASAAS',
      external_reference: externalReference,
      status: 'PENDING',
      amount_cents: Math.round(chargedAmount * 100),
      billing_type: billingType,
      checkout_code: checkoutCode
    })
    .select('id')
    .single()
  if (paymentErr) return c.json({ error: 'Não foi possível iniciar o pagamento.' }, 500)

  let customer: any
  let charge: any
  let qrCode: any
  try {
    customer = await gateway.createCustomer({
      name: nome,
      email,
      cpfCnpj: cpf,
      externalReference: authUser?.id ? `ALUNO:${authUser.id}` : `LEAD:${checkoutCode}`,
      notificationDisabled: true
    })
    if (billingType === 'PIX') await gateway.ensurePixKey()
    charge = await gateway.createCharge({
      customerId: String(customer.id),
      billingType,
      value: chargedAmount,
      dueDate: tomorrowIsoDate(),
      description: `${turma.nome} - ${site.nome_prof}`,
      externalReference,
      installmentCount: paymentChoice === 'CREDIT_CARD' ? installments : undefined,
      totalValue: paymentChoice === 'CREDIT_CARD' && installments > 1 ? chargedAmount : undefined,
      creditCard: paymentChoice === 'CREDIT_CARD' ? {
        holderName: String(card.holderName || '').trim(),
        number: onlyDigits(card.number),
        expiryMonth: onlyDigits(card.expiryMonth).padStart(2, '0'),
        expiryYear: normalizeCardYear(card.expiryYear),
        ccv: onlyDigits(card.ccv)
      } : undefined,
      creditCardHolderInfo: paymentChoice === 'CREDIT_CARD' ? {
        name: nome,
        email,
        cpfCnpj: cpf,
        postalCode: onlyDigits(card.holderPostalCode),
        addressNumber: onlyDigits(card.holderAddressNumber),
        phone: onlyDigits(card.holderPhone) || undefined,
        mobilePhone: onlyDigits(card.holderPhone) || undefined
      } : undefined,
      remoteIp: paymentChoice === 'CREDIT_CARD'
        ? (c.req.header('cf-connecting-ip') || c.req.header('x-forwarded-for')?.split(',')[0]?.trim() || '127.0.0.1')
        : undefined
    })
    if (billingType === 'PIX') qrCode = await gateway.getPixQrCode(String(charge.id))
    if (billingType === 'BOLETO') qrCode = await gateway.getBoletoIdentificationField(String(charge.id))
  } catch (err: any) {
    await sb.from('payments').update({
      status: 'FAILED',
      raw_summary: { error: err?.message || 'asaas_checkout_failed', public_checkout: true },
      updated_at: now
    }).eq('id', payment.id)
    return c.json({ error: 'Não foi possível criar a cobrança no Asaas.' }, 502)
  }

  await sb.from('payments').update({
    provider_payment_id: charge.id,
    provider_customer_id: customer.id,
    status: charge.status || 'PENDING',
    raw_summary: {
      public_checkout: true,
      payment_id: charge.id,
      customer_id: customer.id,
      external_reference: externalReference,
      checkout_code: checkoutCode,
      cpf,
      billing_type: billingType,
      payment_choice: paymentChoice,
      installments,
      base_amount: amount,
      charged_amount: chargedAmount,
      fee_payer: paymentSettings.feePayer,
      fee_percent: paymentSettings.feePercent,
      payment_url: charge.invoiceUrl || charge.bankSlipUrl || null
    },
    updated_at: new Date().toISOString()
  }).eq('id', payment.id)

  const lead = {
    ...previous,
    email,
    nome,
    cpf,
    turma_id: turmaId,
    site_id: site.id,
    status: 'PENDING',
    total: chargedAmount,
    base_total: amount,
    checkout_code: checkoutCode,
    code: checkoutCode,
    transaction_id: charge.id,
    payment_id: payment.id,
    provider_payment_id: charge.id,
    external_reference: externalReference,
    payment_provider: 'ASAAS',
    billing_type: billingType,
    payment_choice: paymentChoice,
    installments,
    payment_url: charge.invoiceUrl || charge.bankSlipUrl || null,
    receipt: {
      aluno: nome,
      email,
      cpf,
      turma: turma.nome,
      total: chargedAmount,
      base_total: amount,
      billing_type: billingLabel,
      installments,
      transaction_id: charge.id,
      checkout_code: checkoutCode
    },
    created_at: previous.created_at || now,
    updated_at: now
  }
  const emailResult = await sendCheckoutReceipt(c.env, lead, turma, site)
  cms.checkout_leads = {
    ...(cms.checkout_leads || {}),
    [key]: {
      ...lead,
      email_sent: emailResult.sent,
      email_status: emailResult.reason || (emailResult.sent ? 'sent' : 'not-sent'),
      email_checked_at: now
    }
  }

  const save = await saveCms(c.env, site.id, cms)
  if (save.error) return c.json(dbError(), 500)
  return c.json({
    ok: true,
    status: charge.status || 'PENDING',
    email,
    nome,
    turma_id: turmaId,
    checkout_code: checkoutCode,
    transaction_id: charge.id,
    payment_id: payment.id,
    provider_payment_id: charge.id,
    external_reference: externalReference,
    total: chargedAmount,
    base_total: amount,
    turma_nome: turma.nome,
    billing_type: billingType,
    payment_choice: paymentChoice,
    installments,
    billing_label: billingLabel,
    payment_url: charge.invoiceUrl || charge.bankSlipUrl || null,
    pix: {
      encodedImage: qrCode?.encodedImage || null,
      payload: qrCode?.payload || null,
      expirationDate: qrCode?.expirationDate || null
    },
    boleto: {
      identificationField: billingType === 'BOLETO' ? (qrCode?.identificationField || qrCode?.barCode || null) : null
    },
    email_sent: emailResult.sent,
    has_account: cpfAccount.exists,
    account_email_hint: cpfAccount.emailHint
  })
})

app.post('/api/site/:slug/video-checkout', async (c) => {
  if (!getConfig(c.env).flags.payments) {
    return c.json({ error: 'Pagamentos temporariamente indisponíveis.' }, 503)
  }
  if (c.env.ASAAS_ENV !== 'sandbox') {
    return c.json({ error: 'Checkout público real ainda está liberado apenas no sandbox.' }, 503)
  }
  let body: {
    course_id?: string
    email?: string
    nome?: string
    cpf?: string
    cpf_cnpj?: string
    billing_type?: string
    installments?: number
    card?: {
      holderName?: string
      number?: string
      expiryMonth?: string
      expiryYear?: string
      ccv?: string
      holderPostalCode?: string
      holderAddressNumber?: string
      holderPhone?: string
    }
  }
  try {
    body = await c.req.json()
  } catch {
    return c.json({ error: 'Corpo inválido' }, 400)
  }
  const email = String(body.email || '').trim().toLowerCase()
  const nome = String(body.nome || '').trim()
  const cpf = onlyDigits(body.cpf || body.cpf_cnpj)
  const courseId = String(body.course_id || '').trim()
  const paymentChoice = normalizeCheckoutPaymentChoice(body.billing_type)
  const billingType = asaasBillingType(paymentChoice)
  const billingLabel = checkoutBillingLabel(paymentChoice)
  const card = body.card || {}
  if (!nome) return c.json({ error: 'Informe o nome para registrar o acesso.' }, 400)
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return c.json({ error: 'Informe um e-mail válido.' }, 400)
  if (!isValidCpf(cpf)) return c.json({ error: 'Informe um CPF válido para vincular o acesso.' }, 400)
  if (!courseId) return c.json({ error: 'Curso obrigatório.' }, 400)
  if (paymentChoice === 'CREDIT_CARD') {
    const cardError = validateCreditCardPayload(card)
    if (cardError) return c.json(cardError, 400)
  }

  const sb = getAdmin(c.env)
  const { data: site, error: siteErr } = await sb.from('sites')
    .select('id, slug, nome_prof, allowed_origins, ativo')
    .eq('slug', c.req.param('slug'))
    .eq('ativo', true)
    .maybeSingle()
  if (siteErr || !site) return c.json({ error: 'Site não encontrado' }, 404)
  const cms = parseCms(site)
  const course = (cms.video_courses || [])
    .filter((item: any) => !['RASCUNHO', 'OCULTO'].includes(String(item.status || 'PUBLICADO').toUpperCase()))
    .find((item: any) => String(item.id || '') === courseId)
  if (!course) return c.json({ error: 'Curso não encontrado ou indisponível.' }, 404)
  const amount = Number(course.price || 0)
  if (!Number.isFinite(amount) || amount <= 0) return c.json({ error: 'Este curso não possui preço válido para checkout.' }, 400)
  const paymentSettings = normalizePaymentSettings({
    payment_methods: { pix: true, boleto: true, credit_card: true },
    credit_card_installments: 12,
    payment_fee_payer: 'PROFESSOR'
  })
  if (!isPaymentChoiceAllowed(paymentChoice, paymentSettings)) {
    return c.json({ error: 'Forma de pagamento indisponível para este curso.' }, 400)
  }
  const maxCardInstallments = maxCreditCardInstallmentsFor(amount, paymentSettings)
  const installments = paymentChoice === 'CREDIT_CARD'
    ? Math.max(1, Math.min(maxCardInstallments, Math.floor(Number(body.installments) || 1)))
    : 1
  const chargedAmount = checkoutChargeAmount(amount, paymentChoice, paymentSettings)
  const key = `${email}:video:${courseId}`
  const previous = cms.checkout_leads?.[key] || {}
  const checkoutCode = previous.checkout_code || previous.code || makeCheckoutCode()
  const now = new Date().toISOString()
  const gateway = getPaymentGateway(c.env)
  const cpfAccount = await lookupStudentAccountByCpf(sb, site.id, cpf)

  const authUsers = await sb.auth.admin.listUsers()
  const authUser = authUsers.data.users.find((item) => String(item.email || '').toLowerCase() === email)
  const cpfOwner = cpfAccount.authUser || authUsers.data.users.find((item) => onlyDigits((item.user_metadata as any)?.cpf) === cpf)
  if (cpfOwner?.id && cpfOwner.email && String(cpfOwner.email).toLowerCase() !== email) {
    return c.json({ error: 'Este CPF já está vinculado a outro e-mail cadastrado.' }, 409)
  }
  if (authUser?.id) {
    await sb.auth.admin.updateUserById(authUser.id, {
      user_metadata: { ...(authUser.user_metadata || {}), nome, role: 'ALUNO', cpf }
    })
    await sb.from('profiles').upsert({
      id: authUser.id,
      nome,
      role: 'ALUNO',
      site_id: site.id,
      ativo: false
    }, { onConflict: 'id' })
  }
  const externalReference = `ASAAS-VID-${crypto.randomUUID()}`
  const { data: payment, error: paymentErr } = await sb.from('payments')
    .insert({
      site_id: site.id,
      turma_id: null,
      course_id: courseId,
      product_type: 'VIDEO_COURSE',
      aluno_id: authUser?.id || null,
      payer_email: email,
      payer_name: nome,
      provider: 'ASAAS',
      external_reference: externalReference,
      status: 'PENDING',
      amount_cents: Math.round(chargedAmount * 100),
      billing_type: billingType,
      checkout_code: checkoutCode,
      raw_summary: {
        public_checkout: true,
        product_type: 'VIDEO_COURSE',
        course_id: courseId,
        cpf,
        base_amount: amount,
        charged_amount: chargedAmount
      }
    })
    .select('id')
    .single()
  if (paymentErr) return c.json({ error: 'Não foi possível iniciar o pagamento.' }, 500)

  let customer: any
  let charge: any
  let payInfo: any
  try {
    customer = await gateway.createCustomer({
      name: nome,
      email,
      cpfCnpj: cpf,
      externalReference: authUser?.id ? `ALUNO:${authUser.id}` : `VIDEO:${checkoutCode}`,
      notificationDisabled: true
    })
    if (billingType === 'PIX') await gateway.ensurePixKey()
    charge = await gateway.createCharge({
      customerId: String(customer.id),
      billingType,
      value: chargedAmount,
      dueDate: tomorrowIsoDate(),
      description: `${course.title || 'Curso em vídeo'} - ${site.nome_prof}`,
      externalReference,
      installmentCount: paymentChoice === 'CREDIT_CARD' ? installments : undefined,
      totalValue: paymentChoice === 'CREDIT_CARD' && installments > 1 ? chargedAmount : undefined,
      creditCard: paymentChoice === 'CREDIT_CARD' ? {
        holderName: String(card.holderName || '').trim(),
        number: onlyDigits(card.number),
        expiryMonth: onlyDigits(card.expiryMonth).padStart(2, '0'),
        expiryYear: normalizeCardYear(card.expiryYear),
        ccv: onlyDigits(card.ccv)
      } : undefined,
      creditCardHolderInfo: paymentChoice === 'CREDIT_CARD' ? {
        name: nome,
        email,
        cpfCnpj: cpf,
        postalCode: onlyDigits(card.holderPostalCode),
        addressNumber: onlyDigits(card.holderAddressNumber),
        phone: onlyDigits(card.holderPhone) || undefined,
        mobilePhone: onlyDigits(card.holderPhone) || undefined
      } : undefined,
      remoteIp: paymentChoice === 'CREDIT_CARD'
        ? (c.req.header('cf-connecting-ip') || c.req.header('x-forwarded-for')?.split(',')[0]?.trim() || '127.0.0.1')
        : undefined
    })
    if (billingType === 'PIX') payInfo = await gateway.getPixQrCode(String(charge.id))
    if (billingType === 'BOLETO') payInfo = await gateway.getBoletoIdentificationField(String(charge.id))
  } catch (err: any) {
    await sb.from('payments').update({
      status: 'FAILED',
      raw_summary: { error: err?.message || 'asaas_video_checkout_failed', public_checkout: true, product_type: 'VIDEO_COURSE', course_id: courseId },
      updated_at: now
    }).eq('id', payment.id)
    return c.json({ error: 'Não foi possível criar a cobrança no Asaas.' }, 502)
  }

  const sandboxAutoReceived = c.env.ASAAS_ENV === 'sandbox'
  const finalStatus = sandboxAutoReceived ? 'RECEIVED' : String(charge.status || 'PENDING').toUpperCase()
  const paidAt = sandboxAutoReceived ? new Date().toISOString() : null
  let enrollmentGranted = false
  let enrollmentReason = ''

  if (sandboxAutoReceived && authUser?.id) {
    const { error: enrollmentErr } = await sb.from('video_course_enrollments')
      .upsert({
        site_id: site.id,
        course_id: courseId,
        aluno_id: authUser.id,
        payment_id: payment.id,
        status: 'ACTIVE',
        updated_at: new Date().toISOString()
      }, { onConflict: 'site_id,course_id,aluno_id' })
    if (enrollmentErr) {
      enrollmentReason = /video_course_enrollments|relation .* does not exist|schema cache/i.test(String(enrollmentErr.message || ''))
        ? 'video_tables_missing'
        : enrollmentErr.message
    } else {
      enrollmentGranted = true
      await sb.from('profiles').update({ ativo: true }).eq('id', authUser.id).eq('role', 'ALUNO')
    }
  }

  await sb.from('payments').update({
    provider_payment_id: charge.id,
    provider_customer_id: customer.id,
    status: finalStatus,
    paid_at: paidAt,
    raw_summary: {
      public_checkout: true,
      product_type: 'VIDEO_COURSE',
      course_id: courseId,
      payment_id: charge.id,
      customer_id: customer.id,
      external_reference: externalReference,
      checkout_code: checkoutCode,
      cpf,
      billing_type: billingType,
      payment_choice: paymentChoice,
      installments,
      base_amount: amount,
      charged_amount: chargedAmount,
      payment_url: charge.invoiceUrl || charge.bankSlipUrl || null,
      provider_status: charge.status || 'PENDING',
      sandbox_auto_received: sandboxAutoReceived,
      enrollment_granted: enrollmentGranted,
      enrollment_reason: enrollmentReason || null
    },
    updated_at: new Date().toISOString()
  }).eq('id', payment.id)

  const lead = {
    ...previous,
    email,
    nome,
    cpf,
    course_id: courseId,
    product_type: 'VIDEO_COURSE',
    site_id: site.id,
    status: sandboxAutoReceived ? 'PAGAMENTO_CONFIRMADO_ASAAS' : 'PENDING',
    total: chargedAmount,
    base_total: amount,
    checkout_code: checkoutCode,
    code: checkoutCode,
    transaction_id: charge.id,
    payment_id: payment.id,
    provider_payment_id: charge.id,
    external_reference: externalReference,
    payment_provider: 'ASAAS',
    billing_type: billingType,
    payment_choice: paymentChoice,
    installments,
    payment_url: charge.invoiceUrl || charge.bankSlipUrl || null,
    paid_at: paidAt,
    sandbox_auto_received: sandboxAutoReceived,
    enrollment_granted: enrollmentGranted,
    receipt: {
      aluno: nome,
      email,
      cpf,
      course: course.title || 'Curso em vídeo',
      total: chargedAmount,
      base_total: amount,
      billing_type: billingLabel,
      installments,
      transaction_id: charge.id,
      checkout_code: checkoutCode
    },
    created_at: previous.created_at || now,
    updated_at: now
  }
  const emailResult = await sendVideoCheckoutReceipt(c.env, lead, course, site)
  if (sandboxAutoReceived) {
    const notificationKey = `payment:${charge.id}`
    const notifications = Array.isArray(cms.notifications)
      ? cms.notifications.filter((item: any) => item?.key !== notificationKey)
      : []
    notifications.unshift({
      id: crypto.randomUUID(),
      key: notificationKey,
      type: 'PAYMENT_RECEIVED',
      title: 'Aluno pagou um curso em vídeo',
      message: `${nome || email} pagou ${course.title || 'um curso em vídeo'}.`,
      aluno_email: email,
      aluno_nome: nome,
      course_id: courseId,
      course_title: course.title || null,
      product_type: 'VIDEO_COURSE',
      amount_cents: Math.round(chargedAmount * 100),
      provider_payment_id: charge.id,
      origin: 'ASAAS_SANDBOX_AUTO',
      read: false,
      created_at: now
    })
    cms.notifications = notifications.slice(0, 100)
  }
  cms.checkout_leads = {
    ...(cms.checkout_leads || {}),
    [key]: {
      ...lead,
      email_status: emailResult.sent ? 'sent' : `not-sent:${emailResult.reason || 'provider'}`,
      email_checked_at: new Date().toISOString()
    }
  }
  const save = await saveCms(c.env, site.id, cms)
  if (save.error) return c.json(dbError(), 500)

  return c.json({
    ok: true,
    status: finalStatus,
    email,
    nome,
    course_id: courseId,
    checkout_code: checkoutCode,
    transaction_id: charge.id,
    payment_id: payment.id,
    provider_payment_id: charge.id,
    external_reference: externalReference,
    total: chargedAmount,
    base_total: amount,
    course_title: course.title || 'Curso em vídeo',
    billing_type: billingType,
    payment_choice: paymentChoice,
    installments,
    billing_label: billingLabel,
    payment_url: charge.invoiceUrl || charge.bankSlipUrl || null,
    pix: {
      encodedImage: payInfo?.encodedImage || null,
      payload: payInfo?.payload || null,
      expirationDate: payInfo?.expirationDate || null
    },
    boleto: {
      identificationField: payInfo?.identificationField || payInfo?.barCode || null
    },
    email_sent: emailResult.sent,
    sandbox_auto_received: sandboxAutoReceived,
    enrollment_granted: enrollmentGranted,
    enrollment_reason: enrollmentReason || null,
    has_account: cpfAccount.exists,
    account_email_hint: cpfAccount.emailHint
  })
})

app.get('/api/marketplace/professores', async (c) => {
  const sb = getAdmin(c.env)
  const fallback = marketplaceFallbackTeachers()
  const { data, error } = await sb.from('sites')
    .select('id, slug, nome_prof, bio_prof, foto_url, cor_primaria, cor_accent, ativo, allowed_origins')
    .eq('ativo', true)
    .order('created_at', { ascending: true })
    .limit(24)

  if (error) {
    return c.json({ data: fallback, fallback: true, reason: 'database-unavailable' })
  }

  const real: any[] = []
  for (const site of data || []) {
    const cms = parseCms(site)
    const active = sitePackageActive(site, cms)
    if (!active) continue
    const words = professorWords(cms.owner_gender)
    const defaultLayout = defaultCms().layout
    const profileText = cms?.layout?.profile_text === defaultLayout.profile_text
      ? genderedDefaultProfileText(cms.owner_gender)
      : cms?.layout?.profile_text
    const specialty = cms?.marketplace?.especialidade || cms?.layout?.eyebrow || 'Redação e correção textual'
    real.push({
      slug: site.slug,
      nome: site.nome_prof || `${words.singular} de redação`,
      especialidade: specialty,
      bio: site.bio_prof || profileText || 'Site ativo com turmas, conteúdos e correções organizadas.',
      foto_url: site.foto_url || cms?.layout?.profile_photo || cms?.layout?.avatar_image || '',
      iniciais: initialsFromName(site.nome_prof),
      url: `/redacao/${encodeURIComponent(site.slug)}`,
      site_ativo: site.ativo !== false,
      pacote_ativo: true,
      source: 'database'
    })
  }

  const bySlug = new Map<string, any>()
  for (const item of real) bySlug.set(item.slug, item)
  for (const item of fallback) {
    if ((item.slug === 'puppin-teste' || item.slug === 'slow') && !bySlug.has(item.slug)) bySlug.set(item.slug, item)
  }

  return c.json({
    data: [...bySlug.values()].slice(0, 12),
    fallback: real.length === 0,
    rule: 'sites.ativo=true e plano/CMS sem status inativo ou expirado'
  })
})

app.get('/s/:slug', async (c) => {
  const data = await loadSite(c.env, c.req.param('slug'))
  if (!data) return c.html('<h1>Site nao encontrado</h1>', 404)
  return c.html(renderSitePage(data))
})

app.get('/redacao/:slug/conteudos/:postId', async (c) => {
  const data = await loadSite(c.env, c.req.param('slug'))
  if (!data) return c.html('<h1>Site nao encontrado</h1>', 404)
  const cms = parseCms(data.site)
  const postId = c.req.param('postId')
  const post = (cms.posts || [])
    .filter((item: any) => item.status !== 'RASCUNHO')
    .find((item: any) => postPublicId(item) === encodeURIComponent(postId) || String(item.id || '') === postId)
  if (!post) return c.html('<h1>Conteudo nao encontrado</h1>', 404)
  return c.html(renderPostPage(data, post))
})

app.get('/redacao/:slug/videos/:courseId', async (c) => {
  const data = await loadSite(c.env, c.req.param('slug'))
  if (!data) return c.html('<h1>Site nao encontrado</h1>', 404)
  const cms = parseCms(data.site)
  const courseId = c.req.param('courseId')
  const course = (cms.video_courses || [])
    .filter((item: any) => !['RASCUNHO', 'OCULTO'].includes(String(item.status || 'PUBLICADO').toUpperCase()))
    .find((item: any) => String(item.id || '') === courseId)
  if (!course) return c.html('<h1>Curso nao encontrado</h1>', 404)
  return c.html(renderVideoCoursePage(data, course))
})

app.get('/redacao/:slug/turmas/:turmaId', async (c) => {
  const data = await loadSite(c.env, c.req.param('slug'))
  if (!data) return c.html('<h1>Site nao encontrado</h1>', 404)
  const turmaId = c.req.param('turmaId')
  const turma = data.turmas.find((item: any) => String(item.id) === turmaId)
  if (!turma) return c.html('<h1>Turma nao encontrada</h1>', 404)
  return c.html(renderTurmaPage(data, turma))
})

app.get('/redacao/:slug/checkout/:turmaId', async (c) => {
  const data = await loadSite(c.env, c.req.param('slug'))
  if (!data) return c.html('<h1>Site nao encontrado</h1>', 404)
  const turmaId = c.req.param('turmaId')
  const turma = data.turmas.find((item: any) => String(item.id) === turmaId)
  if (!turma) return c.html('<h1>Turma nao encontrada</h1>', 404)
  return c.html(renderCheckoutPage(data, turma))
})

app.get('/redacao/:slug', async (c) => {
  const data = await loadSite(c.env, c.req.param('slug'))
  if (!data) return c.html('<h1>Site nao encontrado</h1>', 404)
  return c.html(renderSitePage(data))
})

app.get('/redacao/:slug/login', async (c) => {
  const data = await loadSite(c.env, c.req.param('slug'))
  if (!data) return c.html('<h1>Site nao encontrado</h1>', 404)
  return c.html(renderAssetLoader('/login.html'))
})

app.get('/redacao/:slug/app', async (c) => {
  const data = await loadSite(c.env, c.req.param('slug'))
  if (!data) return c.html('<h1>Site nao encontrado</h1>', 404)
  return c.html(renderAssetLoader('/professor/index.html'))
})

app.get('/redacao/:slug/aluno', async (c) => {
  const data = await loadSite(c.env, c.req.param('slug'))
  if (!data) return c.html('<h1>Site nao encontrado</h1>', 404)
  return c.html(renderAssetLoader('/aluno/index.html'))
})

export { app as siteRoutes }
