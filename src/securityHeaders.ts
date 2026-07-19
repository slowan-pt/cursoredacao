import { createMiddleware } from 'hono/factory'

// unsafe-inline em script-src é necessário pois login.html e auth-callback.html
// têm scripts inline. Para remover, migrar para nonce-based CSP com injeção no Worker.
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
  c.header('Strict-Transport-Security', 'max-age=63072000; includeSubDomains')
  c.header('X-XSS-Protection', '1; mode=block')
})
