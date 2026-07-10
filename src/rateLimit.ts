import { createMiddleware } from 'hono/factory'

// Interface preparada para uma solução real em Cloudflare Rate Limiting,
// Durable Objects ou outro backend compartilhado. Não oferece proteção efetiva ainda.
export const rateLimitPlaceholder = createMiddleware(async (_c, next) => {
  await next()
})
