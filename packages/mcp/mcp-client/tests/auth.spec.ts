import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { LocalCredentialProvider } from '@deepseek-ai/dsh-credentials-local'
import { CredentialsOAuthClientProvider } from '@dsh-cc/mcp-client/src/auth.ts'
import { isUnauthorized, retryUnauthorizedOnce } from '@dsh-cc/mcp-client/src/tools.ts'

const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!()
})

async function bootCredentials(): Promise<Context> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-mcp-auth-'))
  cleanups.push(() => rm(dir, { recursive: true, force: true }))
  const ctx = new Context()
  const fiber = ctx.plugin(LocalCredentialProvider, { path: join(dir, '.credentials.yaml'), watch: false })
  cleanups.push(async () => { await fiber.dispose() })
  await fiber
  return ctx
}

describe('CredentialsOAuthClientProvider', () => {
  it('persists OAuth tokens through the credentials seam and reads them back', async () => {
    const ctx = await bootCredentials()
    const provider = new CredentialsOAuthClientProvider(ctx, 'github', {})

    const tokens = { access_token: 'abc', token_type: 'Bearer', expires_in: 3600, refresh_token: 'ref' }
    expect(await provider.tokens()).toBeUndefined()
    await provider.saveTokens(tokens)
    expect(await provider.tokens()).toEqual(tokens)
  })

  it('persists client information and code verifier', async () => {
    const ctx = await bootCredentials()
    const provider = new CredentialsOAuthClientProvider(ctx, 'srv', {})

    const info = { client_id: 'cid', client_secret: 'cs' }
    await provider.saveClientInformation(info)
    expect(await provider.clientInformation()).toEqual(info)

    await provider.saveCodeVerifier('verifier-123')
    expect(await provider.codeVerifier()).toBe('verifier-123')
  })

  it('derives distinct refs per server so servers never share OAuth state', async () => {
    const ctx = await bootCredentials()
    const a = new CredentialsOAuthClientProvider(ctx, 'server-a', {})
    const b = new CredentialsOAuthClientProvider(ctx, 'server-b', {})

    await a.saveTokens({ access_token: 'token-a' } as never)
    expect((await b.tokens())).toBeUndefined()
    expect((await a.tokens())).toMatchObject({ access_token: 'token-a' })
  })

  it('invalidates a scope by dropping the matching stored refs', async () => {
    const ctx = await bootCredentials()
    const provider = new CredentialsOAuthClientProvider(ctx, 'srv', {})

    await provider.saveTokens({ access_token: 't', token_type: 'Bearer' })
    await provider.saveClientInformation({ client_id: 'c' })
    await provider.invalidateCredentials('tokens')
    expect(await provider.tokens()).toBeUndefined()
    expect(await provider.clientInformation()).toMatchObject({ client_id: 'c' })
  })

  it('uses a custom credential prefix when configured', async () => {
    const ctx = await bootCredentials()
    const provider = new CredentialsOAuthClientProvider(ctx, 'srv', { credentialPrefix: 'MY_MCP_AUTH' })
    await provider.saveTokens({ access_token: 't2' } as never)
    expect(await provider.tokens()).toMatchObject({ access_token: 't2' })
  })
})

describe('retryUnauthorizedOnce / isUnauthorized', () => {
  it('retries once and returns the second result when the first attempt is unauthorized', async () => {
    const onUnauthorized = vi.fn()
    const request = vi.fn()
      .mockRejectedValueOnce(new Error('request failed: unauthorized'))
      .mockResolvedValueOnce('ok')

    const result = await retryUnauthorizedOnce(request, onUnauthorized)
    expect(result).toBe('ok')
    expect(request).toHaveBeenCalledTimes(2)
    expect(onUnauthorized).toHaveBeenCalledTimes(1)
  })

  it('does not retry when no onUnauthorized hook is provided', async () => {
    const request = vi.fn().mockRejectedValueOnce(new Error('some error'))
    await expect(retryUnauthorizedOnce(request)).rejects.toThrow('some error')
    expect(request).toHaveBeenCalledTimes(1)
  })

  it('does not treat a non-unauthorized error as a signal to retry', async () => {
    const onUnauthorized = vi.fn()
    const request = vi.fn().mockRejectedValueOnce(new Error('network down'))
    await expect(retryUnauthorizedOnce(request, onUnauthorized)).rejects.toThrow('network down')
    expect(request).toHaveBeenCalledTimes(1)
    expect(onUnauthorized).not.toHaveBeenCalled()
  })

  it('classifies unauthorized errors by message', () => {
    expect(isUnauthorized(new Error('Unauthorized: token expired'))).toBe(true)
    expect(isUnauthorized(new Error('timeout'))).toBe(false)
  })

  it('propagates the failure when the retry also fails', async () => {
    const onUnauthorized = vi.fn()
    const request = vi.fn().mockRejectedValue(new Error('still unauthorized'))
    await expect(retryUnauthorizedOnce(request, onUnauthorized)).rejects.toThrow('still unauthorized')
    expect(request).toHaveBeenCalledTimes(2)
    expect(onUnauthorized).toHaveBeenCalledTimes(1)
  })
})
