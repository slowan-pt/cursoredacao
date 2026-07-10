import { createMiddleware } from 'hono/factory'
import { getCookie } from 'hono/cookie'
import { verifyToken } from './auth'
import type { UserRole } from './types'

export const requireAuth = createMiddleware(async (c, next) => {
  const token = getCookie(c, 'auth_token')
  if (!token) return c.json({ error: 'Não autenticado' }, 401)

  const payload = await verifyToken(token, c.env.SESSION_SECRET)
  if (!payload) return c.json({ error: 'Token inválido ou expirado' }, 401)

  c.set('user', payload)
  await next()
})

export const requireRole = (...roles: UserRole[]) =>
  createMiddleware(async (c, next) => {
    const user = c.get('user')
    if (!user || !roles.includes(user.role)) {
      return c.json({ error: 'Acesso negado' }, 403)
    }
    await next()
  })
