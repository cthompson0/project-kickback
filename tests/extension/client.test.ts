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
