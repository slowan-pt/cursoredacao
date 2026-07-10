import { getConfig, isProduction } from './config'
import type { Env } from './types'

const ALLOWED_MIME = new Set(['application/pdf', 'image/jpeg', 'image/png'])

function decodedBytesFromBase64(base64: string) {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

function detectMime(bytes: Uint8Array) {
  if (bytes.length >= 4 && bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46) {
    return 'application/pdf'
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'image/jpeg'
  }
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return 'image/png'
  }
  return null
}

export function validateIncomingArquivo(env: Env, arquivoUrl: unknown) {
  const config = getConfig(env)
  const value = String(arquivoUrl || '')
  if (!value) return { ok: false as const, error: 'Arquivo obrigatório.' }

  if (isProduction(env) && !config.flags.r2Uploads) {
    return {
      ok: false as const,
      error: 'O envio de arquivos está temporariamente indisponível. Tente novamente mais tarde.'
    }
  }

  if (!value.startsWith('data:')) {
    return { ok: true as const, tipoArq: value.toLowerCase().includes('.pdf') ? 'PDF' : 'IMAGEM' }
  }

  const match = value.match(/^data:([^;,]+);base64,([A-Za-z0-9+/=\r\n]+)$/)
  if (!match) return { ok: false as const, error: 'Arquivo inválido.' }

  const declaredMime = match[1].toLowerCase()
  if (!ALLOWED_MIME.has(declaredMime)) {
    return { ok: false as const, error: 'Tipo de arquivo não permitido. Envie PDF, JPEG ou PNG.' }
  }

  let bytes: Uint8Array
  try {
    bytes = decodedBytesFromBase64(match[2].replace(/\s/g, ''))
  } catch {
    return { ok: false as const, error: 'Arquivo inválido.' }
  }

  if (bytes.byteLength > config.maxUploadBytes) {
    return { ok: false as const, error: `Arquivo maior que o limite permitido (${config.maxUploadBytes} bytes).` }
  }

  const detectedMime = detectMime(bytes)
  if (!detectedMime || detectedMime !== declaredMime) {
    return { ok: false as const, error: 'O conteúdo do arquivo não corresponde ao tipo informado.' }
  }

  return { ok: true as const, tipoArq: detectedMime === 'application/pdf' ? 'PDF' : 'IMAGEM' }
}
