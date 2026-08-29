import { expect, vi } from 'vitest'

/**
 * A kit for testing WHEN things happen.
 *
 * Almost every defect that reached a browser during the friends beta was a
 * timing failure rather than a calculation failure: a trigger that fired a
 * second too early, a reconnect that replayed nothing, a request discarded
 * because another was open, a consumer reading state a beat before it changed.
 * Pure-function tests cannot see any of that, and neither can a test that
 * awaits a promise and asserts the end state.
 *
 * What catches them is being able to say, cheaply and exactly:
 *
 *     A starts -> B changes -> A resolves -> assert
 *
 * So the pieces here are all about holding the world still: responses that
 * resolve when told to, ports that connect and die on command, and a clock
 * that only moves when asked. Nothing sleeps.
 */

/** A promise somebody else decides the fate of. */
export interface Deferred<T> {
  promise: Promise<T>
  resolve(value: T): void
  reject(error: unknown): void
  settled: boolean
}

export function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  const handle: Deferred<T> = {
    promise,
    settled: false,
    resolve(value) {
      handle.settled = true
      resolve(value)
    },
    reject(error) {
      handle.settled = true
      reject(error)
    },
  }
  return handle
}

/**
 * A queue of controllable calls.
 *
 * Wrap anything async and you can answer its calls in any order, fail one, or
 * leave one hanging for as long as the test needs - which is what makes
 * "B arrives before A" a one-liner rather than a mock framework exercise.
 */
export interface CallQueue<A, R> {
  /** The function under test calls this. */
  fn(args: A): Promise<R>
  /** Everything asked for, in order. */
  calls: A[]
  /** How many are still unanswered. */
  open(): number
  /** Answer the first open call matching the predicate. */
  resolveWhere(match: (args: A) => boolean, value: R): void
  /** Answer the oldest open call. */
  resolveNext(value: R | ((args: A) => R)): void
  /** Fail the oldest open call. */
  rejectNext(error?: unknown): void
  /** Answer every open call. */
  drain(value: R | ((args: A) => R)): void
}

export function createCallQueue<A, R>(): CallQueue<A, R> {
  const calls: A[] = []
  const pending: Array<{ args: A; gate: Deferred<R> }> = []

  const answer = (index: number, value: R | ((args: A) => R)) => {
    const [entry] = pending.splice(index, 1)
    entry.gate.resolve(typeof value === 'function' ? (value as (args: A) => R)(entry.args) : value)
  }

  return {
    calls,
    fn(args: A) {
      calls.push(args)
      const gate = deferred<R>()
      pending.push({ args, gate })
      return gate.promise
    },
    open: () => pending.length,
    resolveWhere(match, value) {
      const index = pending.findIndex((entry) => match(entry.args))
      expect(index, 'no open call matched').toBeGreaterThanOrEqual(0)
      answer(index, value)
    },
    resolveNext(value) {
      expect(pending.length, 'no open call to resolve').toBeGreaterThan(0)
      answer(0, value)
    },
    rejectNext(error = new Error('test failure')) {
      expect(pending.length, 'no open call to reject').toBeGreaterThan(0)
      const [entry] = pending.splice(0, 1)
      entry.gate.reject(error)
    },
    drain(value) {
      while (pending.length > 0) answer(0, value)
    },
  }
}

// ------------------------------------------------------------------- ports

/**
 * A `chrome.runtime.Port`, as far as the code under test can tell.
 *
 * Real enough to reproduce the MV3 failure that reached production: a worker
 * is evicted, every port dies, the content scripts reconnect, and whatever the
 * new worker fails to learn is simply not there.
 */
export interface FakePort {
  name: string
  live: boolean
  onMessage: { addListener(fn: (message: unknown) => void): void }
  onDisconnect: { addListener(fn: () => void): void }
  postMessage(message: unknown): void
  disconnect(): void
  /** Kill it the way an evicted worker does. */
  drop(): void
}

export interface PortNetwork {
  /** Every live port, in connection order. */
  connected: FakePort[]
  /** What the worker does with a message. Replace per test. */
  deliver(handler: (port: FakePort, message: unknown) => void): void
  /** MV3 eviction: every port dies and the worker forgets everything. */
  evictWorker(): void
  /** Undo the global chrome stub. */
  restore(): void
}

/**
 * Installs a fake `chrome.runtime` on globalThis and returns the network.
 *
 * Ports are plain objects because that is exactly what the worker keys tabs by
 * - the port itself - which is why Watchside needs no `tabs` permission.
 */
export function installPortNetwork(): PortNetwork {
  let connected: FakePort[] = []
  let handler: (port: FakePort, message: unknown) => void = () => {}

  const makePort = (name: string): FakePort => {
    const listeners: Array<(message: unknown) => void> = []
    const closers: Array<() => void> = []
    const port: FakePort = {
      name,
      live: true,
      onMessage: { addListener: (fn) => listeners.push(fn) },
      onDisconnect: { addListener: (fn) => closers.push(fn) },
      postMessage: (message) => {
        if (!port.live) throw new Error('Attempting to use a disconnected port object')
        handler(port, message)
      },
      disconnect: () => port.drop(),
      drop: () => {
        if (!port.live) return
        port.live = false
        connected = connected.filter((other) => other !== port)
        network.connected = connected
        closers.forEach((fn) => fn())
      },
    }
    return port
  }

  const previous = (globalThis as { chrome?: unknown }).chrome
  ;(globalThis as { chrome?: unknown }).chrome = {
    runtime: {
      connect: ({ name }: { name: string }) => {
        const port = makePort(name)
        connected.push(port)
        network.connected = connected
        return port
      },
    },
  }

  const network: PortNetwork = {
    connected,
    deliver(next) {
      handler = next
    },
    evictWorker() {
      handler = () => {}
      for (const port of [...connected]) port.drop()
    },
    restore() {
      if (previous === undefined) delete (globalThis as { chrome?: unknown }).chrome
      else (globalThis as { chrome?: unknown }).chrome = previous
    },
  }
  return network
}

// ------------------------------------------------------------------- clock

/**
 * Move time forward and let every microtask that was waiting on it run.
 *
 * Long enough by default to cover the client's 500ms reconnect backoff and the
 * one-second coalesce windows, which are the two delays most tests need to
 * step over.
 */
export const settle = (ms = 1_500) => vi.advanceTimersByTimeAsync(ms)
