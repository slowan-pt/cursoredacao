export interface Env {
  ASSETS: Fetcher
  R2_UPLOADS?: R2Bucket
  SUPABASE_URL: string
  SUPABASE_ANON_KEY: string
  SUPABASE_SERVICE_KEY: string
  SUPABASE_DB_URL?: string
  SESSION_SECRET: string
  SESSION_TTL_SECONDS?: string
  ENABLE_PAYMENTS?: string
  ENABLE_R2_UPLOADS?: string
  ENABLE_EMAILS?: string
  ENABLE_OAUTH?: string
  ENABLE_PUBLIC_CHECKOUT_SIMULATED?: string
  ENABLE_APP_RATE_LIMITING?: string
  MAX_UPLOAD_BYTES?: string
  R2_UPLOADS_BUCKET?: string
  ASAAS_ENV?: string
  ASAAS_API_KEY?: string
  ASAAS_WEBHOOK_TOKEN?: string
  RESEND_API_KEY?: string
  EMAIL_FROM?: string
  APP_URL?: string
  APP_ENV?: string
  APP_VERSION?: string
}

export type UserRole = 'SUPERADMIN' | 'ADMIN' | 'CORRETOR' | 'ALUNO'

export interface JWTPayload {
  sub: string
  email: string
  role: UserRole
  site_id: string | null
  nome: string
  ativo: boolean
  exp: number
  iat: number
}

declare module 'hono' {
  interface ContextVariableMap {
    user: JWTPayload
  }
}
