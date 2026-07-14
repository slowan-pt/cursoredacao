import { Hono } from 'hono'
import type { Env } from '../types'
import { getAdmin } from '../supabase'
import { getConfig } from '../config'
import { getPaymentGateway } from '../payments'

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

function tomorrowIsoDate() {
  const date = new Date()
  date.setDate(date.getDate() + 1)
  return date.toISOString().slice(0, 10)
}

async function sendCheckoutReceipt(env: Env, lead: any, turma: any, site: any) {
  if (!getConfig(env).flags.emails) {
    return { sent: false, reason: 'emails-disabled' }
  }

  // Placeholder seguro para o provedor de e-mail real. Enquanto Resend nao estiver
  // configurado no ambiente, mantemos o recibo persistido no checkout_leads.
  return {
    sent: false,
    reason: 'email-provider-not-configured',
    subject: `Inscricao confirmada - ${String(turma?.nome || 'Turma')}`,
    to: String(lead?.email || ''),
    site: String(site?.slug || '')
  }
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
      block_order: ['hero', 'turmas', 'conteudos', 'aluno'],
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
    turma_settings: {} as Record<string, any>,
    student_credits: {} as Record<string, any>,
    enrollments: {} as Record<string, any>,
    checkout_leads: {} as Record<string, any>
  }
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
      turma_settings: cms.turma_settings && typeof cms.turma_settings === 'object' ? cms.turma_settings : {},
      student_credits: cms.student_credits && typeof cms.student_credits === 'object' ? cms.student_credits : {},
      enrollments: cms.enrollments && typeof cms.enrollments === 'object' ? cms.enrollments : {},
      checkout_leads: cms.checkout_leads && typeof cms.checkout_leads === 'object' ? cms.checkout_leads : {}
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
  const posts = (cms.posts || [])
    .filter((post: any) => post.status !== 'RASCUNHO')
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
  const validBlocks = ['hero', 'turmas', 'conteudos', 'aluno']
  const savedOrder = Array.isArray(layout.block_order) ? layout.block_order.filter((id: string) => validBlocks.includes(id)) : []
  const blockOrder = [...savedOrder, ...validBlocks.filter(id => !savedOrder.includes(id))]
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
<meta name="description" content="${esc(site.bio_prof || layout.profile_text || 'Site público de professor na plataforma Redação com Estratégia.')}">
<meta property="og:type" content="website">
<meta property="og:title" content="${esc(site.nome_prof)} — Redação">
<meta property="og:description" content="${esc(site.bio_prof || layout.profile_text || 'Turmas, conteúdos e correções em um site próprio de professor.')}">
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
    ${isHidden('block:conteudos') ? '' : '<a class="nav-link" href="#conteudos">Conteúdos</a>'}
    <a class="btn btn-light" href="${loginUrl}">Entrar</a>
  </div>
</nav>

<main class="site-blocks" id="site-blocks">
<section class="hero ${profileSide} edit-block reveal" id="hero" data-block="hero" data-move-key="block:hero"${moveStyle('block:hero')}>
  ${blockTools('hero')}
  <div class="hero-copy" data-move-key="hero:text"${moveStyle('hero:text')}>
    <div class="eyebrow" data-edit="layout.eyebrow"${editableStyle('layout.eyebrow')}>${esc(layout.eyebrow)}</div>
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
    <p data-edit="layout.profile_text"${editableStyle('layout.profile_text')}>${esc(layout.profile_text)}</p>
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
  const order = Array.isArray(inlineCms.layout?.block_order) ? inlineCms.layout.block_order : ['hero','turmas','conteudos','aluno']
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
  const sitePath = `/redacao/${encodeURIComponent(site.slug)}`
  const loginUrl = `${sitePath}/login`
  const priceNumber = Number(turma.preco || 0)
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
.form-group{display:flex;flex-direction:column;gap:7px;margin-bottom:14px}label{font-size:12px;font-weight:800;color:var(--ink2)}input{width:100%;padding:12px 14px;border:1.5px solid var(--border);border-radius:10px;font:inherit;outline:none}input:focus{border-color:var(--brand);box-shadow:0 0 0 3px rgba(0,0,0,.08)}
.btn{width:100%;border:0;border-radius:10px;padding:14px 16px;font:inherit;font-weight:900;cursor:pointer;transition:.22s}.btn:hover{transform:translateY(-2px)}.btn-accent{background:var(--accent);color:var(--accent-text)}.btn-sec{background:transparent;border:1px solid var(--border);color:var(--ink)}
.alert{display:none;border-radius:10px;padding:12px 14px;font-size:13px;margin-bottom:14px}.alert-ok{background:#EEF8F1;color:var(--success);border:1px solid #BFE8CD}.alert-err{background:#FEF0F0;color:var(--danger);border:1px solid #F5C6C6}.postpay{display:none;margin-top:18px}.postpay.open{display:block}.action-grid{display:grid;grid-template-columns:1fr 1fr;gap:10px}.note{font-size:12px;color:var(--ink3);line-height:1.5;margin-top:12px}
.payment-modal{position:fixed;inset:0;background:rgba(0,0,0,.64);display:none;align-items:center;justify-content:center;padding:24px;z-index:50}.payment-modal.open{display:flex}.payment-box{width:min(860px,100%);max-height:94vh;overflow:auto;background:var(--card);color:var(--ink);border:1px solid var(--border);border-radius:24px;padding:28px;box-shadow:0 30px 90px rgba(0,0,0,.42)}.payment-badge{display:inline-flex;background:var(--accent);color:var(--accent-text);border-radius:999px;padding:7px 12px;font-size:12px;font-weight:900;margin-bottom:14px}.payment-box h2{font-size:28px;font-weight:900;margin-bottom:10px}.payment-details{background:rgba(0,0,0,.04);border:1px solid var(--border);border-radius:14px;padding:14px;margin:16px 0;display:grid;gap:7px;font-size:13px;color:var(--ink2)}.payment-code{font-weight:900;color:var(--ink);letter-spacing:.08em}.pix-grid{display:grid;grid-template-columns:220px minmax(0,1fr);gap:14px;align-items:start}.pix-qr{width:220px;height:220px;border:1px solid var(--border);border-radius:14px;background:#fff;display:flex;align-items:center;justify-content:center;overflow:hidden}.pix-qr img{width:100%;height:100%;object-fit:contain}.pix-copy{width:100%;min-height:120px;resize:vertical;border:1px solid var(--border);border-radius:12px;padding:10px;font:12px ui-monospace,monospace;color:var(--ink2)}.modal-actions{display:grid;grid-template-columns:1fr 1fr;gap:14px;margin-top:18px}.modal-actions .btn{font-size:17px;padding:20px 16px;border-radius:16px}.modal-note{font-size:12px;color:var(--ink3);line-height:1.55;margin-top:14px}
@media(max-width:860px){body{padding:18px}.checkout{grid-template-columns:1fr}.action-grid{grid-template-columns:1fr}.cover{width:min(100%,280px)}}
@media(max-width:620px){.modal-actions{grid-template-columns:1fr}.payment-box{padding:22px}.payment-box h2{font-size:24px}}
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
      <p class="desc">Informe nome e e-mail antes de finalizar. O e-mail será o vínculo da matrícula com seu cadastro.</p>
      <div class="price-row"><span>Total</span><strong class="price">${price}</strong></div>
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
      <div><strong>Transação:</strong> <span id="modal-transaction">-</span></div>
      <div><strong>Código único:</strong> <span class="payment-code" id="modal-code">-</span></div>
    </div>
    <div class="pix-grid">
      <div class="pix-qr" id="pix-qr">QR</div>
      <div>
        <label for="pix-payload">Pix copia-e-cola</label>
        <textarea id="pix-payload" class="pix-copy" readonly></textarea>
        <button class="btn btn-sec" style="margin-top:10px" onclick="copyPix()" type="button">Copiar Pix</button>
      </div>
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
function show(id,msg){const el=document.getElementById(id);el.textContent=msg;el.style.display='block'}
function hideAlerts(){document.getElementById('alert-err').style.display='none';document.getElementById('alert-ok').style.display='none'}
function copyPix(){const el=document.getElementById('pix-payload');el.select();document.execCommand('copy')}
async function simulatePayment(event){
  event.preventDefault();hideAlerts()
  const btn=document.getElementById('btn-pay')
  const email=document.getElementById('payer-email').value.trim().toLowerCase()
  const nome=document.getElementById('payer-name').value.trim()
  if(!nome){show('alert-err','Informe seu nome para registrar a matrícula.');return}
  if(!email){show('alert-err','Informe o e-mail para vincular a matrícula.');return}
  btn.disabled=true;btn.textContent='Gerando Pix...'
  try{
    const res=await fetch('/api/site/'+encodeURIComponent(siteSlug)+'/checkout',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({turma_id:turmaId,email,nome})})
    const data=await res.json()
    if(!res.ok){show('alert-err',data.error||'Não foi possível finalizar o pagamento.');return}
    const code=data.checkout_code||''
    const transactionId=data.transaction_id||''
    show('alert-ok','Pix gerado. A matrícula será liberada após confirmação do pagamento.')
    document.getElementById('pay-form').style.display='none'
    document.getElementById('postpay').classList.add('open')
    const loginHref='${loginUrl}?paid=1&turma='+encodeURIComponent(turmaId)+'&email='+encodeURIComponent(email)
    const signupHref='${loginUrl}?signup=1&paid=1&turma='+encodeURIComponent(turmaId)+'&email='+encodeURIComponent(email)+'&nome='+encodeURIComponent(nome)+'&checkout_code='+encodeURIComponent(code)
    document.getElementById('login-link').href=loginHref
    document.getElementById('signup-link').href=signupHref
    document.getElementById('modal-login-link').href=loginHref
    document.getElementById('modal-signup-link').href=signupHref
    document.getElementById('modal-name').textContent=nome
    document.getElementById('modal-email').textContent=email
    document.getElementById('modal-course').textContent=data.turma_nome||'${esc(turma.nome)}'
    document.getElementById('modal-total').textContent=data.total?('R$ '+Number(data.total).toLocaleString('pt-BR',{minimumFractionDigits:2,maximumFractionDigits:2})):'${price}'
    document.getElementById('modal-transaction').textContent=transactionId||'-'
    document.getElementById('modal-code').textContent=code||'-'
    const img=data.pix&&data.pix.encodedImage
    document.getElementById('pix-qr').innerHTML=img?'<img alt="QR Code Pix" src="data:image/png;base64,'+img+'">':'QR Code indisponível'
    document.getElementById('pix-payload').value=(data.pix&&data.pix.payload)||''
    try{localStorage.setItem('checkout:'+siteSlug+':'+turmaId,JSON.stringify({nome,email,checkout_code:code,transaction_id:transactionId,created_at:new Date().toISOString()}))}catch{}
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

app.post('/api/site/:slug/checkout', async (c) => {
  if (!getConfig(c.env).flags.payments) {
    return c.json({ error: 'Pagamentos temporariamente indisponíveis.' }, 503)
  }
  if (c.env.ASAAS_ENV !== 'sandbox') {
    return c.json({ error: 'Checkout público real ainda está liberado apenas no sandbox.' }, 503)
  }

  let body: { turma_id?: string; email?: string; nome?: string }
  try {
    body = await c.req.json()
  } catch {
    return c.json({ error: 'Corpo inválido' }, 400)
  }
  const email = String(body.email || '').trim().toLowerCase()
  const nome = String(body.nome || '').trim()
  const turmaId = String(body.turma_id || '').trim()
  if (!nome) return c.json({ error: 'Informe o nome para registrar a matrícula.' }, 400)
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return c.json({ error: 'Informe um e-mail válido.' }, 400)
  if (!turmaId) return c.json({ error: 'Turma obrigatória.' }, 400)

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
  if (cms.turma_settings?.[turmaId]?.matriculas_abertas === false) {
    return c.json({ error: 'As matrículas desta turma estão fechadas.' }, 403)
  }

  const key = `${email}:${turmaId}`
  const previous = cms.checkout_leads?.[key] || {}
  const checkoutCode = previous.checkout_code || previous.code || makeCheckoutCode()
  const now = new Date().toISOString()
  const gateway = getPaymentGateway(c.env)

  const { data: pendingPayment } = await sb.from('payments')
    .select('id, provider_payment_id, external_reference, checkout_code, status, amount_cents, billing_type, created_at')
    .eq('site_id', site.id)
    .eq('turma_id', turma.id)
    .eq('payer_email', email)
    .eq('status', 'PENDING')
    .not('provider_payment_id', 'is', null)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  if (pendingPayment?.provider_payment_id) {
    let qrCode: any
    try {
      qrCode = await gateway.getPixQrCode(String(pendingPayment.provider_payment_id))
    } catch {
      qrCode = null
    }
    const lead = {
      ...previous,
      email,
      nome,
      turma_id: turmaId,
      site_id: site.id,
      status: 'PENDING',
      total: amount,
      checkout_code: pendingPayment.checkout_code || checkoutCode,
      code: pendingPayment.checkout_code || checkoutCode,
      transaction_id: pendingPayment.provider_payment_id,
      payment_id: pendingPayment.id,
      provider_payment_id: pendingPayment.provider_payment_id,
      external_reference: pendingPayment.external_reference,
      payment_provider: 'ASAAS',
      receipt: {
        aluno: nome,
        email,
        turma: turma.nome,
        total: amount,
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
      total: amount,
      turma_nome: turma.nome,
      billing_type: pendingPayment.billing_type || 'PIX',
      pix: {
        encodedImage: qrCode?.encodedImage || null,
        payload: qrCode?.payload || null,
        expirationDate: qrCode?.expirationDate || null
      },
      email_sent: false
    })
  }

  const externalReference = `ASAAS-PUB-${crypto.randomUUID()}`
  const authUsers = await sb.auth.admin.listUsers()
  const authUser = authUsers.data.users.find((item) => String(item.email || '').toLowerCase() === email)
  if (authUser?.id) {
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
      amount_cents: Math.round(amount * 100),
      billing_type: 'PIX',
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
      cpfCnpj: String((body as any).cpf_cnpj || '11144477735'),
      externalReference: authUser?.id ? `ALUNO:${authUser.id}` : `LEAD:${checkoutCode}`,
      notificationDisabled: true
    })
    await gateway.ensurePixKey()
    charge = await gateway.createPixCharge({
      customerId: String(customer.id),
      value: amount,
      dueDate: tomorrowIsoDate(),
      description: `${turma.nome} - ${site.nome_prof}`,
      externalReference
    })
    qrCode = await gateway.getPixQrCode(String(charge.id))
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
      checkout_code: checkoutCode
    },
    updated_at: new Date().toISOString()
  }).eq('id', payment.id)

  const lead = {
    ...previous,
    email,
    nome,
    turma_id: turmaId,
    site_id: site.id,
    status: 'PENDING',
    total: amount,
    checkout_code: checkoutCode,
    code: checkoutCode,
    transaction_id: charge.id,
    payment_id: payment.id,
    provider_payment_id: charge.id,
    external_reference: externalReference,
    payment_provider: 'ASAAS',
    receipt: {
      aluno: nome,
      email,
      turma: turma.nome,
      total: amount,
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
    total: amount,
    turma_nome: turma.nome,
    billing_type: 'PIX',
    pix: {
      encodedImage: qrCode?.encodedImage || null,
      payload: qrCode?.payload || null,
      expirationDate: qrCode?.expirationDate || null
    },
    email_sent: emailResult.sent
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
    const specialty = cms?.marketplace?.especialidade || cms?.layout?.eyebrow || 'Redação e correção textual'
    real.push({
      slug: site.slug,
      nome: site.nome_prof || 'Professor de redação',
      especialidade: specialty,
      bio: site.bio_prof || cms?.layout?.profile_text || 'Site ativo com turmas, conteúdos e correções organizadas.',
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
