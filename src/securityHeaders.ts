import { createMiddleware } from 'hono/factory'

const CSP_DIRECTIVES = [
  "default-src 'self'",
  "base-uri 'self'",
  "frame-ancestors 'none'",
  "object-src 'none'",
  "img-src 'self' data: blob: https:",
  "font-src 'self' data:",
  "style-src 'self' 'unsafe-inline'",
  "script-src 'self' 'unsafe-inline'",
  "connect-src 'self' https://*.supabase.co https://api.resend.com https://api-sandbox.asaas.com https://api.asaas.com"
].join('; ')

export const appSecurityHeaders = createMiddleware(async (c, next) => {
  await next()

  c.header('Content-Security-Policy', CSP_DIRECTIVES)
  c.header('Referrer-Policy', 'strict-origin-when-cross-origin')
  c.header('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()')
  c.header('Cross-Origin-Opener-Policy', 'same-origin')
})
