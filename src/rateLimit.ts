import { createMiddleware } from 'hono/factory'
import type { Context } from 'hono'

// Sliding-window in-memory rate limiter (per-isolate).
// Protege contra brute force dentro do mesmo isolate do Worker.
// Para proteção global em múltiplos isolates, migrar para Cloudflare KV ou Durable Objects.
const _store = new Map<string, number[]>()
let _lastCleanup = Date.now()

function _cleanup() {
  const now = Date.now()
  if (now - _lastCleanup < 300_000) return
  _lastCleanup = now
  for (const [key, ts] of _store) {
    if (!ts.length || now - ts[ts.length - 1] > 300_000) _store.delete(key)
  }
}

export function checkRateLimit(key: string, maxRequests: number, windowMs: number): boolean {
  _cleanup()
  const now = Date.now()
  const ts = (_store.get(key) ?? []).filter(t => now - t < windowMs)
  if (ts.length >= maxRequests) return false
  ts.push(now)
  _store.set(key, ts)
  return true
}

export function rateLimitKey(c: Context, prefix: string): string {
  const ip = c.req.header('CF-Connecting-IP') || c.req.header('X-Forwarded-For') || 'unknown'
  return `${prefix}:${ip}`
}

// Mantido para compatibilidade com imports existentes
export const rateLimitPlaceholder = createMiddleware(async (_c, next) => {
  await next()
})
