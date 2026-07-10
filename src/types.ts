export interface Env {
  ASSETS: Fetcher
  SUPABASE_URL: string
  SUPABASE_ANON_KEY: string
  SUPABASE_SERVICE_KEY: string
  SESSION_SECRET: string
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
