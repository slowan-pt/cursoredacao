import { sign, verify } from 'hono/jwt'
import type { JWTPayload } from './types'

export async function createToken(
  payload: Omit<JWTPayload, 'exp' | 'iat'>,
  secret: string,
  ttlSeconds = 60 * 60 * 24 * 7
): Promise<string> {
  const now = Math.floor(Date.now() / 1000)
  return sign({ ...payload, iat: now, exp: now + ttlSeconds }, secret, 'HS256')
}

export async function verifyToken(
  token: string,
  secret: string
): Promise<JWTPayload | null> {
  try {
    return (await verify(token, secret, 'HS256')) as unknown as JWTPayload
  } catch {
    return null
  }
}
