import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createPortClient } from '../../src/client/port'
import { createExtensionStorage, createMemoryStorageArea } from '../../src/background/storage'
import { INITIAL_STATE } from '../../src/client/types'
import type { KickbackState } from '../../src/client/types'

/**
 * The tab-side proxy and the session storage adapter, with a fake chrome API.
 */

interface FakePort {
  name: string
  posted: unknown[]
  messageListeners: Array<(message: unknown) => void>
  disconnectListeners: Array<() => void>
  onMessage: { addListener(fn: (message: unknown) => void): void }
  onDisconnect: { addListener(fn: () => void): void }
  postMessage(message: unknown): void
  disconnect(): void
  emit(message: unknown): void
  drop(): void
}

function makePort(name: string): FakePort {
  const port: FakePort = {
    name,
    posted: [],
    messageListeners: [],
    disconnectListeners: [],
    onMessage: { addListener: (fn) => port.messageListeners.push(fn) },
    onDisconnect: { addListener: (fn) => port.disconnectListeners.push(fn) },
    postMessage: (message) => port.posted.push(message),
    disconnect: () => port.drop(),
    emit: (message) => port.messageListeners.forEach((fn) => fn(message)),
    drop: () => port.disconnectListeners.forEach((fn) => fn()),
  }
  return port
}

const SIGNED_IN: KickbackState = {
  ...INITIAL_STATE,
  status: 'signed_in',
  identity: {
    userId: 'kb-1',
    displayName: 'Sk8bo',
    avatarUrl: null,
    twitchLogin: 'sk8bo',
    friendCode: 'KB-7QX4-M2P9',
    presenceVisibility: 'visible',
  },
}

let ports: FakePort[] = []

beforeEach(() => {
  ports = []
  ;(globalThis as { chrome?: unknown }).chrome = {
    runtime: {
      connect: ({ name }: { name: string }) => {
        const port = makePort(name)
        ports.push(port)
        return port
      },
    },
  }
})

afterEach(() => {
  delete (globalThis as { chrome?: unknown }).chrome
})

describe('port client', () => {
  it('starts in the loading state so the panel shows nothing social yet', () => {
    const client = createPortClient()
    expect(client.getState().status).toBe('loading')
    expect(client.getState().friends).toEqual([])
  })

  it('announces itself to the worker on connect', () => {
    createPortClient()
    expect(ports).toHaveLength(1)
    expect(ports[0].name).toBe('kickback')
    expect(ports[0].posted).toContainEqual({ type: 'hello' })
  })

  it('adopts state pushed by the worker', () => {
    const client = createPortClient()
    const seen: KickbackState[] = []
    client.subscribe((state) => seen.push(state))

    ports[0].emit({ type: 'state', state: SIGNED_IN })

    expect(client.getState().status).toBe('signed_in')
    expect(client.getState().identity?.twitchLogin).toBe('sk8bo')
    expect(seen.at(-1)?.status).toBe('signed_in')
  })

  it('ignores messages that are not worker state', () => {
    const client = createPortClient()
    ports[0].emit({ type: 'something-else' })
    ports[0].emit(null)
    ports[0].emit({ type: 'state' })

    expect(client.getState().status).toBe('loading')
  })

  it('forwards user intent to the worker without acting locally', () => {
    const client = createPortClient()
    client.signIn()
    client.signOut()
    client.retry()

    expect(ports[0].posted).toContainEqual({ type: 'signIn' })
    expect(ports[0].posted).toContainEqual({ type: 'signOut' })
    expect(ports[0].posted).toContainEqual({ type: 'retry' })
    // The tab must not decide anything about auth on its own.
    expect(client.getState().status).toBe('loading')
  })

  it('reconnects when the worker is shut down', async () => {
    createPortClient()
    expect(ports).toHaveLength(1)

    ports[0].drop() // MV3 idle termination looks exactly like this

    await new Promise((resolve) => setTimeout(resolve, 700))
    expect(ports.length).toBeGreaterThan(1)
    expect(ports.at(-1)?.posted).toContainEqual({ type: 'hello' })
  })

  it('never fabricates an identity when the worker never answers', () => {
    const client = createPortClient()
    expect(client.getState().identity).toBeNull()
    expect(client.getState().demo).toBe(false)
  })
})

describe('session storage adapter', () => {
  it('round-trips a value', async () => {
    const storage = createExtensionStorage(createMemoryStorageArea())
    await storage.setItem('sb-auth-token', 'session-blob')
    expect(await storage.getItem('sb-auth-token')).toBe('session-blob')
  })

  it('returns null for a key that was never written', async () => {
    const storage = createExtensionStorage(createMemoryStorageArea())
    expect(await storage.getItem('missing')).toBeNull()
  })

  it('removes a value, which is what sign-out relies on', async () => {
    const storage = createExtensionStorage(createMemoryStorageArea())
    await storage.setItem('sb-auth-token', 'session-blob')
    await storage.removeItem('sb-auth-token')
    expect(await storage.getItem('sb-auth-token')).toBeNull()
  })

  it('treats a non-string stored value as absent rather than crashing', async () => {
    const area = createMemoryStorageArea()
    await area.set({ 'sb-auth-token': { not: 'a string' } })
    const storage = createExtensionStorage(area)
    expect(await storage.getItem('sb-auth-token')).toBeNull()
  })

  it('survives a worker restart, because the data is not in memory', async () => {
    const area = createMemoryStorageArea()
    await createExtensionStorage(area).setItem('sb-auth-token', 'session-blob')

    // A new adapter over the same area is what a revived worker sees.
    expect(await createExtensionStorage(area).getItem('sb-auth-token')).toBe('session-blob')
  })
})

describe('port client friend operations', () => {
  /** Reads the last rpc message the tab posted to the worker. */
  function lastRpc(): { type: string; callId: number; method: string; args: unknown[] } {
    const rpcs = ports[0].posted.filter(
      (message): message is { type: string; callId: number; method: string; args: unknown[] } =>
        typeof message === 'object' && message !== null && (message as { type?: string }).type === 'rpc',
    )
    return rpcs[rpcs.length - 1]
  }

  it('forwards a search to the worker and resolves with its answer', async () => {
    const client = createPortClient()
    const pending = client.searchUsers('nina')

    const call = lastRpc()
    expect(call.method).toBe('searchUsers')
    expect(call.args).toEqual(['nina'])

    ports[0].emit({
      type: 'rpcResult',
      callId: call.callId,
      ok: true,
      value: [{ userId: 'u-nina', displayName: 'Nina' }],
    })

    await expect(pending).resolves.toEqual([{ userId: 'u-nina', displayName: 'Nina' }])
  })

  it('rejects with the message the worker supplied', async () => {
    const client = createPortClient()
    const pending = client.sendFriendRequest('u-nina')

    ports[0].emit({
      type: 'rpcResult',
      callId: lastRpc().callId,
      ok: false,
      error: 'Could not send that friend request.',
    })

    await expect(pending).rejects.toThrow('Could not send that friend request.')
  })

  it('surfaces a lost session rather than hanging', async () => {
    const client = createPortClient()
    const pending = client.removeFriend('u-nina')

    ports[0].emit({
      type: 'rpcResult',
      callId: lastRpc().callId,
      ok: false,
      error: 'Your Kickback session ended. Sign in again.',
    })

    await expect(pending).rejects.toThrow(/session ended/i)
  })

  it('keeps concurrent calls apart', async () => {
    const client = createPortClient()
    const first = client.searchUsers('nina')
    const firstId = lastRpc().callId
    const second = client.searchUsers('omar')
    const secondId = lastRpc().callId

    expect(secondId).not.toBe(firstId)

    // Answer them out of order; each promise must still get its own result.
    ports[0].emit({ type: 'rpcResult', callId: secondId, ok: true, value: ['omar'] })
    ports[0].emit({ type: 'rpcResult', callId: firstId, ok: true, value: ['nina'] })

    await expect(first).resolves.toEqual(['nina'])
    await expect(second).resolves.toEqual(['omar'])
  })

  it('asks the worker to accept by person, not by request id', async () => {
    // The tab must not need to know a request id to act on "accept".
    const client = createPortClient()
    const pending = client.acceptFriendRequestFrom('u-nina')

    const call = lastRpc()
    expect(call.method).toBe('acceptFriendRequestFrom')
    expect(call.args).toEqual(['u-nina'])

    ports[0].emit({ type: 'rpcResult', callId: call.callId, ok: true, value: 'accepted' })
    await expect(pending).resolves.toBe('accepted')
  })

  it('rejects in-flight calls when the worker is shut down', async () => {
    const client = createPortClient()
    const pending = client.searchUsers('nina')

    ports[0].drop() // MV3 idle termination mid-request

    await expect(pending).rejects.toThrow(/lost its connection/i)
  })

  it('does not resolve a call from an unrelated result id', async () => {
    const client = createPortClient()
    let settled = false
    void client.searchUsers('nina').then(
      () => (settled = true),
      () => (settled = true),
    )

    ports[0].emit({ type: 'rpcResult', callId: 9999, ok: true, value: [] })
    await new Promise((resolve) => setTimeout(resolve, 10))

    expect(settled).toBe(false)
  })
})
