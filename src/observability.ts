import { createMiddleware } from 'hono/factory'

export const requestTelemetry = createMiddleware(async (c, next) => {
  const requestId = c.req.header('x-request-id') || crypto.randomUUID()
  const startedAt = Date.now()

  c.header('x-request-id', requestId)
  await next()

  const durationMs = Date.now() - startedAt
  c.header('server-timing', `app;dur=${durationMs}`)
})

export function logServerError(error: unknown, requestId?: string) {
  const message = error instanceof Error ? error.message : 'Erro desconhecido'
  console.error(JSON.stringify({
    level: 'error',
    service: 'redacao',
    request_id: requestId || null,
    message
  }))
}
