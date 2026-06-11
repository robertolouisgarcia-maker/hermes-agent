import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { en } from '@/i18n/en'
import { installWebBridge } from '@/lib/web-bridge'
import { $desktopBoot } from '@/store/boot'

import { BootFailureOverlay } from './boot-failure-overlay'

// The web failure card must NOT render the IPC recovery buttons (Retry / Repair
// install / Use local gateway) — those are dead no-ops in a browser. It renders
// a "Set gateway token" affordance plus "Reload". This test drives the REAL
// BootFailureOverlay through the real web-bridge install so isWebClient() is true.
//
// installWebBridge() flips a process-wide flag true (it never resets to false),
// which is exactly what we want here: every test in this file runs in web mode.

// In-memory localStorage shim (Node's built-in is disabled without
// --localstorage-file, so window.localStorage can be undefined under the harness).
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

function failBoot(message = 'A gateway token is required to connect from a browser.') {
  $desktopBoot.set({
    error: message,
    fakeMode: false,
    message,
    phase: 'renderer.error',
    progress: 50,
    running: false,
    timestamp: Date.now(),
    visible: true
  })
}

beforeEach(() => {
  ensureLocalStorage()
  window.localStorage.clear()
  // No real Electron bridge -> installWebBridge installs the shim and flips
  // isWebClient() true for the whole process.
  delete (window as { hermesDesktop?: unknown }).hermesDesktop
  installWebBridge()
})

afterEach(() => {
  cleanup()
  window.localStorage.clear()
  vi.restoreAllMocks()
})

describe('BootFailureOverlay in web mode', () => {
  it('renders the web variant (no IPC recovery buttons) when isWebClient is true', () => {
    failBoot()
    render(<BootFailureOverlay />)

    const copy = en.boot.failure

    // Web affordances present.
    expect(screen.getByText(copy.webTitle)).toBeTruthy()
    expect(screen.getByText(copy.saveTokenAndReload)).toBeTruthy()
    expect(screen.getByText(copy.reload)).toBeTruthy()

    // Dead IPC recovery buttons must NOT be present.
    expect(screen.queryByText(copy.retry)).toBeNull()
    expect(screen.queryByText(copy.repairInstall)).toBeNull()
    expect(screen.queryByText(copy.useLocalGateway)).toBeNull()
    expect(screen.queryByText(copy.openLogs)).toBeNull()
  })

  it('renders nothing when there is no boot error', () => {
    $desktopBoot.set({
      error: null,
      fakeMode: false,
      message: 'ready',
      phase: 'renderer.ready',
      progress: 100,
      running: false,
      timestamp: Date.now(),
      visible: false
    })

    const { container } = render(<BootFailureOverlay />)
    expect(container.firstChild).toBeNull()
  })
})
