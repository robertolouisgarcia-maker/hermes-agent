import { useStore } from '@nanostores/react'
import { useEffect, useState } from 'react'

import { Button } from '@/components/ui/button'
import { ErrorIcon } from '@/components/ui/error-state'
import { Input } from '@/components/ui/input'
import { LogView } from '@/components/ui/log-view'
import type { DesktopConnectionConfig } from '@/global'
import { useI18n } from '@/i18n'
import { FileText, Loader2, LogIn, RefreshCw, Wrench } from '@/lib/icons'
import { getGatewayToken, isWebClient, setGatewayToken } from '@/lib/web-bridge'
import { $desktopBoot } from '@/store/boot'
import { notify, notifyError } from '@/store/notifications'
import { $desktopOnboarding } from '@/store/onboarding'

import type { RemoteReauth } from './boot-failure-reauth'
import { deriveProviderShape, isRemoteReauthFailure, signInLabel } from './boot-failure-reauth'

type BusyAction = 'local' | 'repair' | 'retry' | 'signin' | null

// A remote gateway whose access cookie has lapsed (e.g. the dashboard
// restarted on the remote box) boots into this overlay with a reauth-shaped
// error. The local-recovery buttons (Retry resets the local bootstrap latch;
// Repair re-runs the installer) are no-ops for that case — the only fix is to
// re-establish the remote session. The detection + copy helpers live in
// ./boot-failure-reauth so they're unit-testable without a React render.

// Recovery surface for a hard boot failure (gateway never came up, backend
// exited during startup, bootstrap latched, …). Without this the app shell
// renders dead — "gateway offline", no composer, only a toast — with no way
// to retry, repair the install, switch the gateway, or find the logs.
//
// In a browser (isWebClient) the IPC recovery buttons (Retry / Repair / Use
// local gateway) are dead no-ops, so BootFailureOverlay swaps in the web
// variant (WebBootFailureCard) instead — a "Set gateway token" affordance plus
// "Reload". The picker calls isWebClient() (a plain function, not a hook), so
// each card keeps a stable hook order.
export function BootFailureOverlay() {
  if (isWebClient()) {
    return <WebBootFailureCard />
  }

  return <DesktopBootFailureCard />
}

// The browser-mode recovery card. The Electron contextBridge is absent, so the
// desktop recovery actions (resetBootstrap / repairBootstrap / applyConnectionConfig)
// cannot run — they are IPC calls. The only actionable browser recovery is to set
// the gateway token (the boot failed because none was stored / it was rejected)
// and reload.
function WebBootFailureCard() {
  const boot = useStore($desktopBoot)
  const onboarding = useStore($desktopOnboarding)
  const { t } = useI18n()
  const [token, setToken] = useState(() => getGatewayToken() ?? '')

  const visible = Boolean(boot.error) && !boot.running
  const suppressed = onboarding.flow.status !== 'idle' && onboarding.flow.status !== 'error'

  if (!visible || suppressed) {
    return null
  }

  const copy = t.boot.failure

  const saveAndReload = () => {
    setGatewayToken(token)
    window.location.reload()
  }

  const reload = () => window.location.reload()

  return (
    <div className="fixed inset-0 z-[1400] flex items-center justify-center bg-(--ui-chat-surface-background) p-6">
      <div className="w-full max-w-[40rem] overflow-hidden rounded-xl border border-(--stroke-nous) bg-(--ui-chat-bubble-background) shadow-nous">
        <div className="flex items-start gap-3 px-5 py-4">
          <ErrorIcon className="mt-0.5" size="1.25rem" />
          <div>
            <h2 className="text-[0.9375rem] font-semibold tracking-tight">{copy.webTitle}</h2>
            <p className="mt-1 text-[0.8125rem] leading-5 text-(--ui-text-tertiary)">{copy.webDescription}</p>
          </div>
        </div>

        <div className="grid gap-4 p-5">
          <div className="rounded-2xl border border-destructive/30 bg-destructive/10 px-4 py-3 text-xs text-destructive">
            {boot.error}
          </div>

          <form
            className="grid gap-2"
            onSubmit={event => {
              event.preventDefault()
              saveAndReload()
            }}
          >
            <label className="text-xs font-medium text-(--ui-text-secondary)" htmlFor="hermes-web-gateway-token">
              {copy.gatewayTokenLabel}
            </label>
            <Input
              autoComplete="off"
              autoFocus
              id="hermes-web-gateway-token"
              onChange={event => setToken(event.target.value)}
              placeholder={copy.gatewayTokenPlaceholder}
              type="password"
              value={token}
            />
            <div className="mt-1 flex flex-wrap gap-2">
              <Button disabled={!token.trim()} type="submit">
                {copy.saveTokenAndReload}
              </Button>
              <Button onClick={reload} type="button" variant="secondary">
                <RefreshCw />
                {copy.reload}
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">{copy.webHint}</p>
          </form>
        </div>
      </div>
    </div>
  )
}

function DesktopBootFailureCard() {
  const boot = useStore($desktopBoot)
  const onboarding = useStore($desktopOnboarding)
  const { t } = useI18n()
  const [busy, setBusy] = useState<BusyAction>(null)
  const [logs, setLogs] = useState<string[]>([])
  const [showLogs, setShowLogs] = useState(false)
  const [remoteReauth, setRemoteReauth] = useState<RemoteReauth | null>(null)

  const visible = Boolean(boot.error) && !boot.running
  // While first-run onboarding owns the picker/flow we let it surface its own
  // progress; the recovery overlay is for hard failures, which it covers via a
  // higher z-index regardless of onboarding state.
  const suppressed = onboarding.flow.status !== 'idle' && onboarding.flow.status !== 'error'

  useEffect(() => {
    if (!visible) {
      return
    }

    void window.hermesDesktop
      ?.getRecentLogs()
      .then(res => setLogs(res.lines ?? []))
      .catch(() => undefined)
  }, [visible])

  // Resolve whether this boot failure is a remote-gateway reauth so we can
  // offer the actionable "Sign in" path instead of the local-only recovery
  // buttons. Runs whenever the overlay becomes visible.
  useEffect(() => {
    if (!visible) {
      setRemoteReauth(null)

      return
    }

    let cancelled = false

    void (async () => {
      const desktop = window.hermesDesktop

      if (!desktop?.getConnectionConfig) {
        return
      }

      let config: DesktopConnectionConfig

      try {
        config = await desktop.getConnectionConfig()
      } catch {
        return
      }

      if (cancelled || !isRemoteReauthFailure(config)) {
        return
      }

      // Best-effort probe for the provider shape so the button copy matches
      // what the user will see in the login window (password form vs OAuth
      // redirect). Probe failure just keeps the generic copy.
      let shape = deriveProviderShape(null)

      try {
        const probe = await desktop.probeConnectionConfig(config.remoteUrl)
        shape = deriveProviderShape(probe?.providers)
      } catch {
        // Generic copy is fine.
      }

      if (!cancelled) {
        setRemoteReauth({ url: config.remoteUrl, ...shape })
      }
    })()

    return () => {
      cancelled = true
    }
  }, [visible])

  if (!visible || suppressed) {
    return null
  }

  const retry = async () => {
    setBusy('retry')
    await window.hermesDesktop?.resetBootstrap().catch(() => undefined)
    window.location.reload()
  }

  const repair = async () => {
    setBusy('repair')
    await window.hermesDesktop?.repairBootstrap().catch(() => undefined)
    window.location.reload()
  }

  const switchToLocalGateway = async () => {
    setBusy('local')
    // applyConnectionConfig reloads the window from the main process.
    await window.hermesDesktop?.applyConnectionConfig({ mode: 'local' }).catch(() => undefined)
    setBusy(null)
  }

  // Open the gateway's login window (renders the username/password form for a
  // basic gateway, or the OAuth redirect otherwise — the desktop drives both
  // through the same window). On a successful sign-in the session cookie is
  // re-established in the persistent partition; reload so boot re-runs and the
  // reconnect now mints a ticket against a live session.
  const signInRemote = async () => {
    if (!remoteReauth) {
      return
    }

    setBusy('signin')

    try {
      const result = await window.hermesDesktop?.oauthLoginConnectionConfig(remoteReauth.url)

      if (result?.connected) {
        notify({ kind: 'success', title: t.boot.failure.signedInTitle, message: t.boot.failure.signedInMessage })
        window.location.reload()

        return
      }

      notify({
        kind: 'warning',
        title: t.boot.failure.signInIncompleteTitle,
        message: t.boot.failure.signInIncompleteMessage
      })
    } catch (err) {
      notifyError(err, t.boot.failure.signInFailed)
    } finally {
      setBusy(null)
    }
  }

  const openLogs = () => void window.hermesDesktop?.revealLogs().catch(() => undefined)
  const copy = t.boot.failure

  const label = signInLabel(remoteReauth, {
    identityProvider: copy.identityProvider,
    remoteGateway: copy.signInToRemoteGateway,
    withProvider: copy.signInWithProvider
  })

  return (
    <div className="fixed inset-0 z-[1400] flex items-center justify-center bg-(--ui-chat-surface-background) p-6">
      <div className="w-full max-w-[40rem] overflow-hidden rounded-xl border border-(--stroke-nous) bg-(--ui-chat-bubble-background) shadow-nous">
        <div className="flex items-start gap-3 px-5 py-4">
          <ErrorIcon className="mt-0.5" size="1.25rem" />
          <div>
            <h2 className="text-[0.9375rem] font-semibold tracking-tight">
              {remoteReauth ? copy.remoteTitle : copy.title}
            </h2>
            <p className="mt-1 text-[0.8125rem] leading-5 text-(--ui-text-tertiary)">
              {remoteReauth ? copy.remoteDescription : copy.description}
            </p>
          </div>
        </div>

        <div className="grid gap-4 p-5">
          <div className="rounded-2xl border border-destructive/30 bg-destructive/10 px-4 py-3 text-xs text-destructive">
            {boot.error}
          </div>

          <div className="grid gap-2">
            <div className="flex flex-wrap gap-2">
              {remoteReauth ? (
                <Button disabled={Boolean(busy)} onClick={() => void signInRemote()}>
                  {busy === 'signin' ? <Loader2 className="animate-spin" /> : <LogIn />}
                  {label}
                </Button>
              ) : (
                <Button disabled={Boolean(busy)} onClick={() => void retry()}>
                  {busy === 'retry' ? <Loader2 className="animate-spin" /> : <RefreshCw />}
                  {copy.retry}
                </Button>
              )}
              {!remoteReauth ? (
                <Button disabled={Boolean(busy)} onClick={() => void repair()} variant="secondary">
                  {busy === 'repair' ? <Loader2 className="animate-spin" /> : <Wrench />}
                  {copy.repairInstall}
                </Button>
              ) : null}
              <Button disabled={Boolean(busy)} onClick={() => void switchToLocalGateway()} variant="secondary">
                {busy === 'local' ? <Loader2 className="animate-spin" /> : null}
                {copy.useLocalGateway}
              </Button>
              <Button onClick={openLogs} variant="ghost">
                <FileText />
                {copy.openLogs}
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              {remoteReauth ? copy.remoteSignInHint : copy.repairHint}
            </p>
          </div>

          {logs.length > 0 ? (
            <div className="grid gap-2">
              <Button
                className="-ml-2 self-start font-medium"
                onClick={() => setShowLogs(v => !v)}
                size="xs"
                type="button"
                variant="text"
              >
                {showLogs ? copy.hideRecentLogs : copy.showRecentLogs}
              </Button>
              {showLogs ? <LogView className="max-h-48">{logs.slice(-40).join('')}</LogView> : null}
            </div>
          ) : null}
        </div>
      </div>
    </div>
  )
}
