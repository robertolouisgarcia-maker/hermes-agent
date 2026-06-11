import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  buildWebGatewayWsUrl,
  createWebBridge,
  getGatewayToken,
  HERMES_GATEWAY_TOKEN_KEY,
  installWebBridge,
  isWebClient,
  isWebGatewayTokenRequired,
  setGatewayToken,
  WebGatewayTokenRequiredError
} from './web-bridge'

// jsdom's location.origin is non-configurable, so rather than mutate it we pin
// a deterministic origin via createWebBridge(origin) (the production default is
// window.location.origin). HTTP/HTTPS scheme behaviour is covered directly on
// the pure buildWebGatewayWsUrl(origin, token).
const ORIGIN = 'http://127.0.0.1:9122'

// Node's experimental built-in localStorage shadows jsdom's but is disabled
// unless `--localstorage-file` is passed, so `window.localStorage` can be
// undefined under the run harness. Provide a minimal in-memory implementation
// when one is missing; a no-op where jsdom/Node already supplies it.
function ensureLocalStorage() {
  if (typeof window !== 'undefined' && !window.localStorage) {
    const store = new Map<string, string>()
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      value: {
        getItem: (key: string) => (store.has(key) ? store.get(key)! : null),
        setItem: (key: string, value: string) => void store.set(key, String(value)),
        removeItem: (key: string) => void store.delete(key),
        clear: () => store.clear(),
        key: (index: number) => Array.from(store.keys())[index] ?? null,
        get length() {
          return store.size
        }
      }
    })
  }
}

beforeEach(() => {
  ensureLocalStorage()
  delete (window as { hermesDesktop?: unknown }).hermesDesktop
  window.localStorage.clear()
  // installWebBridge flips a module-level web-client flag; it only ever flips
  // true on a real install (never reset to false within a process), so the
  // "desktop already present" no-op test asserts the RETURN value, not isWebClient().
})

afterEach(() => {
  delete (window as { hermesDesktop?: unknown }).hermesDesktop
  window.localStorage.clear()
  vi.restoreAllMocks()
})

describe('buildWebGatewayWsUrl', () => {
  it('mints ws://<host>/api/ws?token=<encoded> for an http origin', () => {
    expect(buildWebGatewayWsUrl('http://127.0.0.1:9122', 'abc')).toBe('ws://127.0.0.1:9122/api/ws?token=abc')
  })

  it('mints wss:// for an https origin', () => {
    expect(buildWebGatewayWsUrl('https://host.ts.net', 'abc')).toBe('wss://host.ts.net/api/ws?token=abc')
  })

  it('url-encodes the token', () => {
    expect(buildWebGatewayWsUrl('https://host.ts.net', 'a b/c?d')).toBe(
      'wss://host.ts.net/api/ws?token=a%20b%2Fc%3Fd'
    )
  })

  it('preserves a path prefix from the origin', () => {
    expect(buildWebGatewayWsUrl('https://host.ts.net/hermes', 't')).toBe('wss://host.ts.net/hermes/api/ws?token=t')
  })
})

describe('token storage', () => {
  it('round-trips a token through localStorage', () => {
    expect(getGatewayToken()).toBeNull()
    setGatewayToken('secret-token')
    expect(window.localStorage.getItem(HERMES_GATEWAY_TOKEN_KEY)).toBe('secret-token')
    expect(getGatewayToken()).toBe('secret-token')
  })

  it('clears the token when set to null or empty', () => {
    setGatewayToken('secret-token')
    setGatewayToken(null)
    expect(getGatewayToken()).toBeNull()
    setGatewayToken('secret-token')
    setGatewayToken('   ')
    expect(getGatewayToken()).toBeNull()
  })

  it('trims surrounding whitespace', () => {
    setGatewayToken('  padded  ')
    expect(getGatewayToken()).toBe('padded')
  })
})

describe('installWebBridge', () => {
  it('installs the shim when window.hermesDesktop is undefined', () => {
    expect(window.hermesDesktop).toBeUndefined()
    const installed = installWebBridge()
    expect(installed).toBe(true)
    expect(window.hermesDesktop).toBeDefined()
    expect(typeof window.hermesDesktop.getConnection).toBe('function')
    expect(typeof window.hermesDesktop.getGatewayWsUrl).toBe('function')
    // isWebClient reflects that the shim is the active bridge.
    expect(isWebClient()).toBe(true)
  })

  it('is a NO-OP when a real bridge already exists (desktop path preserved)', () => {
    const realBridge = { marker: 'electron' } as unknown as Window['hermesDesktop']
    ;(window as { hermesDesktop?: unknown }).hermesDesktop = realBridge

    const installed = installWebBridge()

    expect(installed).toBe(false)
    // The existing bridge is untouched — byte-for-byte the same object.
    expect(window.hermesDesktop).toBe(realBridge)
  })
})

describe('web bridge connection', () => {
  it('getConnection builds ws://<origin-host>/api/ws?token=<t> from a stored token', async () => {
    setGatewayToken('tok123')
    const bridge = createWebBridge(ORIGIN)
    const conn = await bridge.getConnection()

    expect(conn.wsUrl).toBe('ws://127.0.0.1:9122/api/ws?token=tok123')
    expect(conn.baseUrl).toBe('http://127.0.0.1:9122')
    expect(conn.authMode).toBe('token')
    expect(conn.mode).toBe('remote')
    expect(conn.token).toBe('tok123')
  })

  it('getConnection mints wss:// over https', async () => {
    setGatewayToken('tok123')
    const bridge = createWebBridge('https://robertos-macbook-pro.alpaca-goby.ts.net')
    const conn = await bridge.getConnection()

    expect(conn.wsUrl).toBe('wss://robertos-macbook-pro.alpaca-goby.ts.net/api/ws?token=tok123')
  })

  it('getGatewayWsUrl returns the same ws url as getConnection', async () => {
    setGatewayToken('tok123')
    const bridge = createWebBridge(ORIGIN)
    const conn = await bridge.getConnection()
    const wsUrl = await bridge.getGatewayWsUrl()

    expect(wsUrl).toBe(conn.wsUrl)
  })

  it('getConnection with a MISSING token yields a recoverable state, NOT a throw', async () => {
    const bridge = createWebBridge(ORIGIN)

    // Must resolve (not reject): an empty wsUrl + tokenRequired marker.
    const conn = await bridge.getConnection()
    expect(conn.wsUrl).toBe('')
    expect((conn as { tokenRequired?: boolean }).tokenRequired).toBe(true)
  })

  it('getGatewayWsUrl with a MISSING token throws a tagged token-required error', async () => {
    const bridge = createWebBridge(ORIGIN)

    await expect(bridge.getGatewayWsUrl()).rejects.toBeInstanceOf(WebGatewayTokenRequiredError)

    let thrown: unknown
    try {
      await bridge.getGatewayWsUrl()
    } catch (err) {
      thrown = err
    }
    expect(isWebGatewayTokenRequired(thrown)).toBe(true)
  })
})

describe('web bridge lifecycle subscriptions', () => {
  it('on* subscriptions return a callable no-op unsubscriber', () => {
    const bridge = createWebBridge(ORIGIN)

    const offBoot = bridge.onBootProgress(() => undefined)
    const offExit = bridge.onBackendExit(() => undefined)
    const offPower = bridge.onPowerResume?.(() => undefined)
    const offWindow = bridge.onWindowStateChanged?.(() => undefined)

    for (const off of [offBoot, offExit, offPower, offWindow]) {
      expect(typeof off).toBe('function')
      // Calling it must not throw.
      expect(() => off?.()).not.toThrow()
    }
  })

  it('getBootProgress returns a completed snapshot', async () => {
    const bridge = createWebBridge(ORIGIN)
    const snapshot = await bridge.getBootProgress()

    expect(snapshot.running).toBe(false)
    expect(snapshot.progress).toBe(100)
    expect(snapshot.error).toBeNull()
  })

  it('profile.get returns the default profile id', async () => {
    const bridge = createWebBridge(ORIGIN)
    const pref = await bridge.profile.get()
    expect(pref.profile).toBe('default')
  })
})

describe('revalidateConnection', () => {
  it('calls GET /api/status and returns ok on success', async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => ({ ok: true }) as Response)
    vi.stubGlobal('fetch', fetchMock)

    const bridge = createWebBridge(ORIGIN)
    const result = await bridge.revalidateConnection!()

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [calledUrl, calledInit] = fetchMock.mock.calls[0]
    expect(String(calledUrl)).toContain('/api/status')
    expect(calledInit?.method).toBe('GET')
    expect(result).toEqual({ ok: true, rebuilt: false })
  })

  it('swallows a fetch failure into a not-ok result (never throws)', async () => {
    const fetchMock = vi.fn(async () => {
      throw new Error('network down')
    })
    vi.stubGlobal('fetch', fetchMock)

    const bridge = createWebBridge(ORIGIN)
    await expect(bridge.revalidateConnection!()).resolves.toEqual({ ok: false, rebuilt: false })
  })
})

describe('web bridge api() REST layer', () => {
  it('issues a same-origin fetch carrying the session token header, parses JSON', async () => {
    setGatewayToken('tok-123')
    const calls: Array<[string, RequestInit | undefined]> = []
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      calls.push([url, init])
      return new Response(JSON.stringify({ ok: true, n: 7 }), { status: 200 })
    })
    vi.stubGlobal('fetch', fetchMock)
    const bridge = createWebBridge('https://lab.example.ts.net')
    const out = await bridge.api<{ ok: boolean; n: number }>({ path: '/api/sessions', method: 'GET' })
    expect(out).toEqual({ ok: true, n: 7 })
    const [calledUrl, calledInit] = calls[0]
    expect(calledUrl).toBe('https://lab.example.ts.net/api/sessions')
    expect((calledInit?.headers as Record<string, string>)['X-Hermes-Session-Token']).toBe('tok-123')
    vi.unstubAllGlobals()
  })

  it('serializes a body + sets content-type, and throws on a non-ok response', async () => {
    setGatewayToken('tok-9')
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      expect((init?.headers as Record<string, string>)['Content-Type']).toBe('application/json')
      expect(init?.body).toBe(JSON.stringify({ q: 'hi' }))
      return new Response(JSON.stringify({ error: 'nope' }), { status: 400 })
    })
    vi.stubGlobal('fetch', fetchMock)
    const bridge = createWebBridge('https://lab.example.ts.net')
    await expect(bridge.api({ path: '/api/search', method: 'POST', body: { q: 'hi' } })).rejects.toThrow(/nope/)
    vi.unstubAllGlobals()
  })
})
