/**
 * web-bridge.ts
 *
 * Lets the SAME desktop renderer boot in a plain browser (iPhone Safari, M1
 * Chrome) with no Electron. Today boot HARD-REQUIRES window.hermesDesktop (the
 * Electron contextBridge from electron/preload.cjs): use-gateway-boot.ts reads
 * `window.hermesDesktop` and, finding it undefined in a browser, dies with dead
 * IPC recovery buttons.
 *
 * installWebBridge() installs a same-origin-HTTP/WS-backed object onto
 * window.hermesDesktop that MIRRORS the slice of the preload surface the boot +
 * reconnect machinery touches:
 *   - getConnection / getGatewayWsUrl  -> a client-side WS URL minted from
 *     location.origin + a stored token, mirroring
 *     electron/connection-config.cjs buildGatewayWsUrl():
 *       ws(s)://<host>/api/ws?token=<encoded>  (https -> wss, http -> ws)
 *   - revalidateConnection            -> GET /api/status
 *   - getBootProgress                 -> a static completed snapshot
 *   - onBootProgress / onBackendExit / onPowerResume / onWindowStateChanged
 *                                     -> register harmlessly, return a no-op
 *                                        unsubscriber the boot teardown calls
 *   - profile.get                     -> the default profile id
 *   - profile.set / touchBackend / getConnectionConfig -> minimal safe stubs
 *
 * When the REAL Electron bridge is present, installWebBridge() is a no-op and
 * isWebClient() stays false, so the desktop code path is byte-unchanged.
 *
 * Auth (token mode v1): the token is read from localStorage (HERMES_GATEWAY_TOKEN_KEY).
 * If absent, getConnection still resolves (no hard crash) with an empty wsUrl and
 * a `tokenRequired` marker; getGatewayWsUrl throws a tagged WebGatewayTokenRequiredError
 * so the boot fails RECOVERABLY into the web failure card (Set gateway token + Reload).
 * The token only ever appears in the WS ?token= query, which the backend already
 * expects.
 */

import type {
  BackendExit,
  DesktopActiveProfile,
  DesktopBootProgress,
  DesktopConnectionConfig,
  HermesApiRequest,
  HermesConnection,
  HermesWindowState
} from '@/global'

/** localStorage key the web client reads the gateway token from. */
export const HERMES_GATEWAY_TOKEN_KEY = 'hermes.gateway.token'

/** The default profile id the web client boots as (v1: single profile). */
const DEFAULT_PROFILE = 'default'

/**
 * Marks a recoverable "no gateway token stored yet" condition. getConnection()
 * never throws this (it resolves a token-less connection); getGatewayWsUrl()
 * throws it so the boot fails into the web failure card rather than dialing a
 * token-less socket.
 */
export class WebGatewayTokenRequiredError extends Error {
  readonly tokenRequired = true

  constructor(message = 'A gateway token is required to connect from a browser.') {
    super(message)
    this.name = 'WebGatewayTokenRequiredError'
  }
}

export function isWebGatewayTokenRequired(error: unknown): error is WebGatewayTokenRequiredError {
  return (
    error instanceof WebGatewayTokenRequiredError ||
    (typeof error === 'object' && error !== null && (error as { tokenRequired?: unknown }).tokenRequired === true)
  )
}

/** Read the stored gateway token, or null when none is set / storage is blocked. */
export function getGatewayToken(): null | string {
  try {
    const value = window.localStorage.getItem(HERMES_GATEWAY_TOKEN_KEY)

    return value && value.trim() ? value.trim() : null
  } catch {
    return null
  }
}

/**
 * Persist (or clear, when passed null/empty) the gateway token. Best-effort:
 * restricted storage just leaves the token unset, which surfaces as the
 * recoverable "token required" state rather than a crash.
 */
export function setGatewayToken(token: null | string): void {
  try {
    const trimmed = token?.trim()

    if (!trimmed) {
      window.localStorage.removeItem(HERMES_GATEWAY_TOKEN_KEY)
    } else {
      window.localStorage.setItem(HERMES_GATEWAY_TOKEN_KEY, trimmed)
    }
  } catch {
    // Storage is a convenience; ignore failures in restricted contexts.
  }
}

/**
 * Build the gateway WS URL CLIENT-SIDE from an http(s) origin + token, mirroring
 * electron/connection-config.cjs buildGatewayWsUrl semantics:
 *   https -> wss, http -> ws ; path is <origin-prefix>/api/ws?token=<encoded>.
 * Same-origin by default (location.origin), so it rides the exact host the
 * renderer was served from (tailscale serve -> loopback proxy -> backend).
 */
export function buildWebGatewayWsUrl(origin: string, token: string): string {
  const parsed = new URL(origin)
  const wsScheme = parsed.protocol === 'https:' ? 'wss' : 'ws'
  const prefix = parsed.pathname.replace(/\/+$/, '')

  return `${wsScheme}://${parsed.host}${prefix}/api/ws?token=${encodeURIComponent(token)}`
}

// Tracks whether the shim is the active bridge (i.e. there was no real Electron
// preload). Flipped true only by installWebBridge() when it installs the shim.
let webClientActive = false

/**
 * True once the web shim is installed — i.e. the app is running in a browser
 * with no Electron bridge. Desktop-only surfaces (installer, Repair, log reveal,
 * profile pools, pty terminal) gate behind this.
 */
export function isWebClient(): boolean {
  return webClientActive
}

// A no-op unsubscriber the boot teardown can call unconditionally.
function noopUnsubscribe(): void {
  // Nothing to tear down: the web shim never wires real listeners.
}

function currentOrigin(origin?: string): string {
  return origin ?? window.location.origin
}

/** A completed boot snapshot: in web mode there is no local backend to start. */
function completedBootProgress(): DesktopBootProgress {
  return {
    error: null,
    fakeMode: false,
    message: 'ready',
    phase: 'renderer.ready',
    progress: 100,
    running: false,
    timestamp: Date.now()
  }
}

/**
 * Build a HermesConnection for the same-origin gateway. When no token is stored
 * the connection still resolves (tokenRequired marker, empty wsUrl) so the boot
 * degrades into the recoverable web failure card instead of crashing.
 */
function buildWebConnection(
  profile?: null | string,
  originOverride?: string
): HermesConnection & { tokenRequired?: boolean } {
  const origin = currentOrigin(originOverride)
  const token = getGatewayToken()
  const wsUrl = token ? buildWebGatewayWsUrl(origin, token) : ''
  const scope = String(profile ?? '').trim() || DEFAULT_PROFILE

  return {
    baseUrl: origin,
    isFullscreen: false,
    mode: 'remote',
    authMode: 'token',
    nativeOverlayWidth: 0,
    source: 'settings',
    token: token ?? '',
    wsUrl,
    logs: [],
    profile: scope,
    windowButtonPosition: null,
    tokenRequired: !token
  }
}

/** The web client's connection config (token-mode remote, never OAuth). */
function buildWebConnectionConfig(profile?: null | string, originOverride?: string): DesktopConnectionConfig {
  const token = getGatewayToken()

  return {
    envOverride: false,
    mode: 'remote',
    profile: String(profile ?? '').trim() || null,
    remoteAuthMode: 'token',
    remoteOauthConnected: false,
    remoteTokenPreview: token ? `...${token.slice(-6)}` : null,
    remoteTokenSet: Boolean(token),
    remoteUrl: currentOrigin(originOverride)
  }
}

/**
 * The shim object installed onto window.hermesDesktop. Typed as a partial of the
 * real bridge: only the methods the boot + reconnect machinery actually touch
 * are real; the rest are intentionally absent (callers already guard them with
 * optional chaining) or minimal safe stubs.
 */
export type WebBridge = Pick<
  NonNullable<Window['hermesDesktop']>,
  | 'api'
  | 'getConnection'
  | 'revalidateConnection'
  | 'touchBackend'
  | 'getGatewayWsUrl'
  | 'getBootProgress'
  | 'getConnectionConfig'
  | 'profile'
  | 'onWindowStateChanged'
  | 'onBackendExit'
  | 'onPowerResume'
  | 'onBootProgress'
>

/**
 * Build the web shim. `origin` defaults to the live `window.location.origin`
 * (the host the renderer was served from); it is injectable purely so tests can
 * pin a deterministic origin without mutating jsdom's non-configurable
 * `location.origin`.
 */
export function createWebBridge(origin?: string): WebBridge {
  return {
    // wsUrl is minted client-side from location.origin + the stored token. This
    // never throws on a missing token — the connection resolves with an empty
    // wsUrl + tokenRequired marker so boot fails recoverably (see getGatewayWsUrl).
    getConnection: async (profile?: null | string): Promise<HermesConnection> => buildWebConnection(profile, origin),

    // GET /api/status — the boot tolerates whatever this returns (it's a
    // best-effort liveness probe in the reconnect path, called with .catch()).
    revalidateConnection: async (): Promise<{ ok: boolean; rebuilt: boolean }> => {
      try {
        const res = await fetch(`${currentOrigin(origin)}/api/status`, {
          method: 'GET',
          headers: { Accept: 'application/json' }
        })

        return { ok: res.ok, rebuilt: false }
      } catch {
        return { ok: false, rebuilt: false }
      }
    },

    // The REST data layer the whole renderer uses (sessions, settings, search,
    // ...). In Electron this proxies through the main process to the gateway;
    // in web mode it is a same-origin fetch with the session-token header,
    // mirroring the main-process hermes:api handler. Same-origin, so the path
    // rides the exact host serving the renderer (no baseUrl needed). The token
    // (when present) goes ONLY in the X-Hermes-Session-Token header.
    api: async <T>(request: HermesApiRequest): Promise<T> => {
      const token = getGatewayToken()
      const headers: Record<string, string> = { Accept: 'application/json' }
      if (token) {
        headers['X-Hermes-Session-Token'] = token
      }
      const hasBody = request.body !== undefined && request.body !== null
      if (hasBody) {
        headers['Content-Type'] = 'application/json'
      }
      const res = await fetch(`${currentOrigin(origin)}${request.path}`, {
        method: (request.method ?? 'GET').toUpperCase(),
        headers,
        body: hasBody ? JSON.stringify(request.body) : undefined
      })
      const text = await res.text()
      const parsed = text ? (JSON.parse(text) as unknown) : undefined
      if (!res.ok) {
        const message =
          parsed && typeof parsed === 'object' && 'error' in parsed
            ? String((parsed as { error: unknown }).error)
            : `hermes_api_${res.status}`
        throw new Error(message)
      }
      return parsed as T
    },

    // No pooled backends in web mode; nothing to keep warm.
    touchBackend: async (): Promise<{ ok: boolean }> => ({ ok: true }),

    // The single source of truth for the WS URL. Throws a tagged token-required
    // error when no token is stored so resolveGatewayWsUrl/boot surfaces the
    // recoverable web failure card instead of dialing a token-less socket.
    getGatewayWsUrl: async (): Promise<string> => {
      const token = getGatewayToken()

      if (!token) {
        throw new WebGatewayTokenRequiredError()
      }

      return buildWebGatewayWsUrl(currentOrigin(origin), token)
    },

    // No local backend boot to report — synthesize a completed snapshot.
    getBootProgress: async (): Promise<DesktopBootProgress> => completedBootProgress(),

    getConnectionConfig: async (profile?: null | string): Promise<DesktopConnectionConfig> =>
      buildWebConnectionConfig(profile, origin),

    profile: {
      get: async (): Promise<DesktopActiveProfile> => ({ profile: DEFAULT_PROFILE }),
      // Profile switching spawns a backend under a new HERMES_HOME on the
      // desktop; there is no such thing in web mode, so this is a safe no-op.
      set: async (): Promise<DesktopActiveProfile> => ({ profile: DEFAULT_PROFILE })
    },

    // The boot wires these wake/lifecycle listeners and tears them down via the
    // returned unsubscriber. The browser has its own visibilitychange/online
    // handlers (in the hook), so these just need to register harmlessly and hand
    // back a callable no-op.
    onWindowStateChanged: (_callback: (payload: HermesWindowState) => void) => noopUnsubscribe,
    onBackendExit: (_callback: (payload: BackendExit) => void) => noopUnsubscribe,
    onPowerResume: (_callback: () => void) => noopUnsubscribe,
    onBootProgress: (_callback: (payload: DesktopBootProgress) => void) => noopUnsubscribe
  }
}

/**
 * At app entry, BEFORE the boot gate reads window.hermesDesktop: if the real
 * Electron bridge is absent, install the web shim and flag web-client mode.
 * Idempotent and a strict no-op when the real bridge (or a previously-installed
 * shim) is already present — the desktop path stays byte-unchanged.
 *
 * Returns true when (and only when) it installed the shim.
 */
export function installWebBridge(): boolean {
  if (typeof window === 'undefined') {
    return false
  }

  // Real Electron bridge present (or shim already installed): do nothing.
  if (window.hermesDesktop) {
    return false
  }

  ;(window as { hermesDesktop?: unknown }).hermesDesktop = createWebBridge()
  webClientActive = true

  return true
}
