import { getConfig } from './config'
import type { Env } from './types'

const MIME_TO_EXT: Record<string, 'pdf' | 'jpg' | 'png'> = {
  'application/pdf': 'pdf',
  'image/jpeg': 'jpg',
  'image/png': 'png'
}

type UploadKeyInput = {
  siteId: string
  turmaId: string
  alunoId: string
  correcaoId: string
  fileId?: string
  mime: string
}

export type StoredObject = {
  key: string
  size: number
  mime: string
  etag?: string
}

export type StoragePutInput = UploadKeyInput & {
  bytes: ArrayBuffer
  originalName?: string
}

export interface PrivateStorage {
  put(input: StoragePutInput): Promise<StoredObject>
  get(key: string): Promise<R2ObjectBody | null>
  delete(key: string): Promise<void>
}

function assertSegment(value: string, label: string) {
  if (!/^[a-zA-Z0-9_-]+$/.test(value)) {
    throw new Error(`Identificador inválido para ${label}.`)
  }
}

export function extensionForMime(mime: string) {
  const ext = MIME_TO_EXT[mime]
  if (!ext) throw new Error('Tipo de arquivo não permitido.')
  return ext
}

export function buildUploadKey(input: UploadKeyInput) {
  assertSegment(input.siteId, 'site')
  assertSegment(input.turmaId, 'turma')
  assertSegment(input.alunoId, 'aluno')
  assertSegment(input.correcaoId, 'correção')
  const fileId = input.fileId || crypto.randomUUID()
  assertSegment(fileId, 'arquivo')
  const ext = extensionForMime(input.mime)
  return `tenants/${input.siteId}/turmas/${input.turmaId}/alunos/${input.alunoId}/redacoes/${input.correcaoId}/${fileId}.${ext}`
}

export function validateStorageKey(key: string) {
  return Boolean(
    key &&
    key.length <= 1024 &&
    key.startsWith('tenants/') &&
    !key.includes('..') &&
    !key.startsWith('/') &&
    !key.endsWith('/')
  )
}

class DisabledStorage implements PrivateStorage {
  async put(): Promise<StoredObject> {
    throw new Error('Uploads R2 temporariamente indisponíveis.')
  }

  async get(): Promise<null> {
    return null
  }

  async delete(): Promise<void> {}
}

class R2PrivateStorage implements PrivateStorage {
  constructor(private readonly bucket: R2Bucket) {}

  async put(input: StoragePutInput): Promise<StoredObject> {
    const key = buildUploadKey(input)
    const object = await this.bucket.put(key, input.bytes, {
      httpMetadata: {
        contentType: input.mime,
        contentDisposition: 'attachment',
        cacheControl: 'private, no-store'
      },
      customMetadata: {
        site_id: input.siteId,
        turma_id: input.turmaId,
        aluno_id: input.alunoId,
        correcao_id: input.correcaoId,
        original_name: input.originalName || ''
      }
    })
    if (!object) throw new Error('Não foi possível armazenar o arquivo.')
    return { key, size: input.bytes.byteLength, mime: input.mime, etag: object.etag }
  }

  async get(key: string) {
    if (!validateStorageKey(key)) throw new Error('Chave de arquivo inválida.')
    return this.bucket.get(key)
  }

  async delete(key: string) {
    if (!validateStorageKey(key)) throw new Error('Chave de arquivo inválida.')
    await this.bucket.delete(key)
  }
}

export function getPrivateStorage(env: Env): PrivateStorage {
  const config = getConfig(env)
  if (!config.flags.r2Uploads || !env.R2_UPLOADS) return new DisabledStorage()
  return new R2PrivateStorage(env.R2_UPLOADS)
}
