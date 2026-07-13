import type { Env } from './types'

export type AppConfig = {
  appEnv: 'development' | 'staging' | 'production'
  appUrl: string
  appVersion: string
  sessionSecret: string
  sessionTtlSeconds: number
  maxUploadBytes: number
  flags: {
    payments: boolean
    r2Uploads: boolean
    emails: boolean
    oauth: boolean
    publicCheckoutSimulated: boolean
    appRateLimiting: boolean
  }
}

const EXAMPLE_VALUES = new Set([
  'change-me',
  'changeme',
  'example',
  'example-secret',
  'your-secret-here',
  'dev-secret',
  'secret'
])

function bool(value: unknown, fallback = false) {
  if (value == null || value === '') return fallback
  return ['1', 'true', 'yes', 'on'].includes(String(value).trim().toLowerCase())
}

function int(value: unknown, fallback: number) {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback
}

function required(env: Env, key: keyof Env) {
  const value = env[key]
  if (!value) throw new Error(`Variável obrigatória ausente: ${String(key)}`)
  return String(value)
}

function sessionSecretLooksUnsafe(secret: string) {
  const normalized = secret.trim().toLowerCase()
  if (EXAMPLE_VALUES.has(normalized)) return true
  if (/^(.)\1+$/.test(secret)) return true
  return new TextEncoder().encode(secret).length < 32
}

export function getConfig(env: Env): AppConfig {
  const appEnv = (env.APP_ENV || 'development').toLowerCase()
  const normalizedEnv = appEnv === 'production' || appEnv === 'staging' ? appEnv : 'development'
  const sessionSecret = required(env, 'SESSION_SECRET')
  if (sessionSecretLooksUnsafe(sessionSecret)) {
    throw new Error('SESSION_SECRET ausente ou inseguro. Use um segredo forte com no mínimo 32 bytes.')
  }

  required(env, 'SUPABASE_URL')
  required(env, 'SUPABASE_ANON_KEY')
  required(env, 'SUPABASE_SERVICE_KEY')

  const publicCheckoutDefault = normalizedEnv === 'production' ? false : true
  return {
    appEnv: normalizedEnv,
    appUrl: env.APP_URL || '',
    appVersion: env.APP_VERSION || 'dev',
    sessionSecret,
    sessionTtlSeconds: int(env.SESSION_TTL_SECONDS, 60 * 60 * 24 * 7),
    maxUploadBytes: int(env.MAX_UPLOAD_BYTES, 8 * 1024 * 1024),
    flags: {
      payments: bool(env.ENABLE_PAYMENTS, false),
      r2Uploads: bool(env.ENABLE_R2_UPLOADS, false),
      emails: bool(env.ENABLE_EMAILS, false),
      oauth: bool(env.ENABLE_OAUTH, false),
      publicCheckoutSimulated: bool(env.ENABLE_PUBLIC_CHECKOUT_SIMULATED, publicCheckoutDefault),
      appRateLimiting: bool(env.ENABLE_APP_RATE_LIMITING, false)
    }
  }
}

export function isProduction(env: Env) {
  return getConfig(env).appEnv === 'production'
}

export function sessionCookieOptions(env: Env) {
  const config = getConfig(env)
  return {
    httpOnly: true,
    secure: config.appEnv === 'production',
    sameSite: 'Lax' as const,
    maxAge: config.sessionTtlSeconds,
    path: '/'
  }
}

export function expiredSessionCookieOptions(env: Env) {
  const options = sessionCookieOptions(env)
  return {
    ...options,
    maxAge: 0
  }
}
