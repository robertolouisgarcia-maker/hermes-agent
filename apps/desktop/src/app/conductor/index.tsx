import { useStore } from '@nanostores/react'
import { useQuery } from '@tanstack/react-query'
import type * as React from 'react'
import { useEffect, useMemo } from 'react'

import { StatusDot, type StatusTone } from '@/components/status-dot'
import { ErrorState } from '@/components/ui/error-state'
import { Loader } from '@/components/ui/loader'
import { type Translations, useI18n } from '@/i18n'
import { Activity, GitBranch, Globe, type IconComponent, Lock, Package, SteeringWheel, Zap } from '@/lib/icons'
import { cn } from '@/lib/utils'
import { $activeMissionId, setActiveMission } from '@/store/conductor'

import { OverlayMain, OverlayNavItem, OverlaySidebar, OverlaySplitLayout } from '../overlays/overlay-split-layout'
import { OverlayView } from '../overlays/overlay-view'
import { EmptyState, ListRow, SectionHeading } from '../settings/primitives'

// Poll cadence for the live cockpit. The Conductor runs missions in the
// background (the gateway proxies the PH cockpit tools), so no UI action signals
// a state change — poll the lane list + the selected mission on this interval so
// new states surface within a few seconds. Read-only (Phase 1): no actions yet.
const POLL_INTERVAL_MS = 3000

const MISSIONS_LIMIT = 50

// The system-health pane is the cockpit home: a glance proves the whole machine
// is healthy. The PH Developer-OS self-check is SAFE (no spawn/spend/effect by
// design), so polling it is cheap — a slower cadence than the live lanes is
// plenty for a readiness matrix that only changes when the fleet wiring does.
const SYSTEMCHECK_INTERVAL_MS = 10000

// One JSON-RPC call into the gateway, which proxies the PH Conductor cockpit
// tools. Mirrors how every other overlay reaches the gateway.
type RequestGateway = <T>(method: string, params?: Record<string, unknown>) => Promise<T>

// A gateway tool result. The gateway returns `_ok(rid, result)` for BOTH a
// successful tool call AND a tool-level failure, so a `{ ok: false, reason }`
// envelope can ride back on the resolve path. We only treat `ok === false` as an
// error (success results don't necessarily carry `ok: true`).
interface GatewayResult {
  ok?: boolean
  reason?: string
}

// The mission lanes surfaced in the sidebar. Only the fields the lane row needs;
// the cockpit projection carries the rest. The live tool emits `realmId` +
// `repoFamily` (not `realm` / `repo`).
interface ConductorMission {
  missionId: string
  state?: string
  realmId?: string
  repoFamily?: string
  severity?: string
}

interface ConductorMissionsResponse extends GatewayResult {
  missions?: ConductorMission[]
}

// One governance control on the dashboard card. Every control is owner-approval
// gated and read-only in Phase 1; `requiresOwnerApproval` drives the lock chip.
interface CockpitCardControl {
  id: string
  enabled?: boolean
  requiresOwnerApproval?: boolean
}

// The present refs on the dashboard card. Null entries are skipped at render.
interface CockpitCardRefs {
  validationContract?: null | string
  proofBundle?: null | string
  handoff?: null | string
}

// The cockpit projection (projection.core + projection.surfaces.dashboard.card)
// as the cockpit_projection_get tool emits it. Everything is optional so a
// partial/early projection still renders without throwing.
interface CockpitDashboardCard {
  title?: string
  controls?: CockpitCardControl[]
  refs?: CockpitCardRefs
}

interface CockpitProjectionCore {
  missionId?: string
  title?: string
  ownerGoal?: string
  state?: string
  priority?: string
  severity?: string
  realmId?: string
  repoFamily?: string
  controls?: string[]
  validationContractRef?: null | string
  proofBundleRef?: null | string
  handoffPath?: null | string
}

interface CockpitProjection {
  core?: CockpitProjectionCore
  surfaces?: {
    dashboard?: {
      card?: CockpitDashboardCard
    }
  }
}

interface ConductorCockpitResponse extends GatewayResult {
  projection?: CockpitProjection
}

// ── Developer-OS self-check (system-health) shapes ───────────────────
// The gateway wraps the parsed matrix as { ok: true, report }. The report is
// the developer_os_self_check_v1 matrix the cockpit home renders. Every field
// is optional so a partial/early matrix still renders without throwing.
type SelfCheckVerdict = 'READY' | 'DEGRADED' | 'NOT-READY'
type CapabilityStatus = 'live' | 'degraded' | 'absent'

interface SelfCheckCapability {
  name: string
  status?: CapabilityStatus
  evidence?: string
  detail?: string
}

interface SelfCheckFloor {
  floor: string
  holds?: boolean
  evidence?: string
}

interface SelfCheckReport {
  schema?: string
  ready?: boolean
  verdict?: SelfCheckVerdict | string
  capabilities?: SelfCheckCapability[]
  governanceFloors?: SelfCheckFloor[]
  summary?: Record<string, number>
  generatedNote?: string
}

interface ConductorSystemcheckResponse extends GatewayResult {
  report?: SelfCheckReport
}

// Verdict → StatusDot tone. READY reads as success (good), DEGRADED as a
// warning, NOT-READY as destructive, anything unknown as a muted pip.
const VERDICT_TONE: Record<string, StatusTone> = {
  READY: 'good',
  DEGRADED: 'warn',
  'NOT-READY': 'bad'
}

function verdictTone(verdict: string | undefined): StatusTone {
  return (verdict ? VERDICT_TONE[verdict] : undefined) ?? 'muted'
}

// Capability status → tone. live=good, degraded=warn, absent=bad, else muted.
const CAPABILITY_TONE: Record<string, StatusTone> = {
  live: 'good',
  degraded: 'warn',
  absent: 'bad'
}

function capabilityTone(status: string | undefined): StatusTone {
  return (status ? CAPABILITY_TONE[status] : undefined) ?? 'muted'
}

// State → StatusDot tone. release_ready reads as success, in-flight states
// (working/leased) as the accent "good" pip, validating as a warning, blocked as
// destructive, everything else as a muted/tertiary pip. Single source so the
// lane pip and the detail heading never drift.
const STATE_TONE: Record<string, StatusTone> = {
  release_ready: 'good',
  working: 'good',
  leased: 'good',
  validating: 'warn',
  blocked: 'bad'
}

function stateTone(state: string | undefined): StatusTone {
  return (state ? STATE_TONE[state] : undefined) ?? 'muted'
}

function stateLabel(state: string | undefined, c: Translations['conductor']): string {
  if (!state) {
    return c.states.unknown
  }

  return c.states[state] ?? state
}

// Short, stable lane label: the trailing path segment of a slash/colon-scoped
// missionId so long ids ("fin/mission-2026-...") stay readable in the 13rem
// sidebar without losing the full id (kept in title for hover).
function shortMissionId(missionId: string): string {
  const tail = missionId.split(/[/:]/).filter(Boolean).pop()

  return tail || missionId
}

interface ConductorViewProps extends React.ComponentProps<'section'> {
  onClose: () => void
  requestGateway: RequestGateway
}

export function ConductorView({ onClose, requestGateway }: ConductorViewProps) {
  const { t } = useI18n()
  const c = t.conductor
  const activeMissionId = useStore($activeMissionId)

  const missionsQuery = useQuery({
    queryKey: ['conductor', 'missions'],
    queryFn: async () => {
      const res = await requestGateway<ConductorMissionsResponse>('conductor.missions.list', { limit: MISSIONS_LIMIT })

      // The gateway resolves a {ok:false, reason} envelope on tool failure;
      // throw so react-query routes it to the ErrorState path instead of
      // rendering a blank lane list.
      if (res && res.ok === false) {
        throw new Error(res.reason ?? 'conductor_unavailable')
      }

      return res
    },
    refetchInterval: POLL_INTERVAL_MS
  })

  const missions = useMemo(() => missionsQuery.data?.missions ?? [], [missionsQuery.data])

  // The lane the detail pane binds to: the explicitly selected one if it still
  // exists, else the first lane, so the right pane is never empty while missions
  // exist. The store stays authoritative for the highlight + the active query.
  const selectedMissionId = useMemo(() => {
    if (activeMissionId && missions.some(mission => mission.missionId === activeMissionId)) {
      return activeMissionId
    }

    return missions[0]?.missionId ?? null
  }, [activeMissionId, missions])

  // Mirror the resolved selection into the store so the sidebar highlight and the
  // cockpit query agree even before the operator clicks a lane.
  useEffect(() => {
    if (selectedMissionId && selectedMissionId !== activeMissionId) {
      setActiveMission(selectedMissionId)
    }
  }, [activeMissionId, selectedMissionId])

  const cockpitQuery = useQuery({
    queryKey: ['conductor', 'cockpit', selectedMissionId],
    queryFn: async () => {
      const res = await requestGateway<ConductorCockpitResponse>('conductor.cockpit.get', {
        missionId: selectedMissionId
      })

      // Same {ok:false} envelope on the cockpit tool: throw so the detail pane
      // shows the cockpit ErrorState rather than an endless spinner.
      if (res && res.ok === false) {
        throw new Error(res.reason ?? 'conductor_unavailable')
      }

      return res
    },
    refetchInterval: POLL_INTERVAL_MS,
    enabled: !!selectedMissionId
  })

  const selectedMission = useMemo(
    () => missions.find(mission => mission.missionId === selectedMissionId) ?? null,
    [missions, selectedMissionId]
  )

  // The system-health matrix is the cockpit home. It is independent of any
  // mission selection (global readiness), so it polls on its own slow cadence
  // and renders in the main pane whenever no lane is bound to the detail view.
  const systemcheckQuery = useQuery({
    queryKey: ['conductor', 'systemcheck'],
    queryFn: async () => {
      const res = await requestGateway<ConductorSystemcheckResponse>('conductor.systemcheck', {})

      // Same {ok:false} envelope as the cockpit tools: throw so react-query
      // routes it to the system-health ErrorState rather than a blank pane.
      if (res && res.ok === false) {
        throw new Error(res.reason ?? 'systemcheck_unavailable')
      }

      return res
    },
    refetchInterval: SYSTEMCHECK_INTERVAL_MS
  })

  // No lane is bound to the detail pane: the cockpit home is system health.
  const showSystemHealth = !selectedMissionId

  return (
    <OverlayView closeLabel={c.close} onClose={onClose}>
      <OverlaySplitLayout>
        <OverlaySidebar>
          <div className="mb-1 flex items-center gap-2 px-2 pt-1 text-[length:var(--conversation-text-font-size)] font-medium">
            <SteeringWheel className="size-4 text-muted-foreground" />
            <span>{c.title}</span>
          </div>

          {missionsQuery.isError ? (
            <p className="px-2 py-4 text-center text-xs text-destructive">{c.lanesError}</p>
          ) : missionsQuery.isPending ? (
            <div className="grid place-items-center py-6">
              <Loader label={c.loading} />
            </div>
          ) : missions.length === 0 ? (
            <p className="px-2 py-4 text-center text-xs text-muted-foreground">{c.emptyLanes}</p>
          ) : (
            missions.map(mission => (
              <OverlayNavItem
                active={selectedMissionId === mission.missionId}
                icon={iconForRealm(mission.realmId)}
                key={mission.missionId}
                label={shortMissionId(mission.missionId)}
                onClick={() => setActiveMission(mission.missionId)}
                trailing={<StatusDot className="shrink-0" tone={stateTone(mission.state)} />}
              />
            ))
          )}
        </OverlaySidebar>

        <OverlayMain>
          {showSystemHealth ? (
            <SystemHealth
              c={c}
              isError={systemcheckQuery.isError}
              isLoading={systemcheckQuery.isPending}
              report={systemcheckQuery.data?.report}
            />
          ) : (
            <MissionDetail
              c={c}
              cockpit={cockpitQuery.data?.projection}
              isError={cockpitQuery.isError}
              isLoading={cockpitQuery.isLoading && !!selectedMissionId}
              mission={selectedMission}
              missionsError={missionsQuery.isError}
              missionsLoading={missionsQuery.isPending}
              noMissions={!missionsQuery.isPending && !missionsQuery.isError && missions.length === 0}
            />
          )}
        </OverlayMain>
      </OverlaySplitLayout>
    </OverlayView>
  )
}

function iconForRealm(realmId: string | undefined): IconComponent {
  if (realmId === 'ph' || realmId === 'personal-hermes') {
    return SteeringWheel
  }

  return Globe
}

// The cockpit home: the Developer-OS self-check readiness matrix. One glance
// proves the whole machine is healthy — a verdict header, every capability with
// its live/degraded/absent pip + evidence, and every governance floor with a
// holds/breached pip. Composed entirely from existing primitives + tokens.
function SystemHealth({
  c,
  isError,
  isLoading,
  report
}: {
  c: Translations['conductor']
  isError: boolean
  isLoading: boolean
  report?: SelfCheckReport
}) {
  const s = c.system

  if (isError) {
    return (
      <div className="grid min-h-48 place-items-center">
        <ErrorState description={s.errorDesc} title={s.error} />
      </div>
    )
  }

  // Spin only while genuinely fetching with no prior matrix.
  if (isLoading) {
    return (
      <div className="grid min-h-48 place-items-center">
        <Loader label={s.loading} />
      </div>
    )
  }

  // Settled but the tool returned no matrix: an empty state, not a spinner.
  if (!report) {
    return <EmptyState description={s.emptyDesc} title={s.empty} />
  }

  const capabilities = report.capabilities ?? []
  const floors = report.governanceFloors ?? []
  const verdict = report.verdict
  const verdictLabel = verdictText(verdict, s)

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto w-full max-w-2xl">
        <SectionHeading icon={Activity} title={s.title} />

        <div className="flex flex-col">
          <ListRow
            action={
              <span className="inline-flex items-center gap-2 text-[length:var(--conversation-text-font-size)] text-foreground sm:justify-self-end">
                <StatusDot tone={verdictTone(verdict)} />
                {verdictLabel}
              </span>
            }
            description={report.summary ? s.summary(report.summary.capabilitiesLive ?? 0, capabilities.length, report.summary.floorsHeld ?? 0, floors.length) : undefined}
            title={s.verdict}
          />
        </div>

        <SectionHeading
          icon={Zap}
          meta={capabilities.length ? String(capabilities.length) : undefined}
          title={s.capabilities}
        />
        {capabilities.length === 0 ? (
          <p className="py-2 text-xs text-muted-foreground">{s.noCapabilities}</p>
        ) : (
          <div className="flex flex-col">
            {capabilities.map(capability => (
              <ListRow
                action={
                  <span className="inline-flex items-center gap-2 text-[length:var(--conversation-text-font-size)] text-foreground sm:justify-self-end">
                    <StatusDot tone={capabilityTone(capability.status)} />
                    {capabilityStatusText(capability.status, s)}
                  </span>
                }
                description={capability.evidence}
                key={capability.name}
                title={<span className="font-mono">{capability.name}</span>}
              />
            ))}
          </div>
        )}

        <SectionHeading
          icon={Lock}
          meta={floors.length ? String(floors.length) : undefined}
          title={s.floors}
        />
        {floors.length === 0 ? (
          <p className="py-2 pb-6 text-xs text-muted-foreground">{s.noFloors}</p>
        ) : (
          <div className="mb-6 flex flex-col">
            {floors.map(floor => (
              <ListRow
                action={
                  <span className="inline-flex items-center gap-2 text-[length:var(--conversation-text-font-size)] text-foreground sm:justify-self-end">
                    <StatusDot tone={floor.holds ? 'good' : 'bad'} />
                    {floor.holds ? s.holds : s.breached}
                  </span>
                }
                description={floor.evidence}
                key={floor.floor}
                title={<span className="font-mono">{floor.floor}</span>}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

// Verdict → localized label. READY/DEGRADED/NOT-READY are known; an unknown
// verdict falls back to the raw string (never blank).
function verdictText(verdict: string | undefined, s: Translations['conductor']['system']): string {
  if (verdict === 'READY') {
    return s.verdictReady
  }
  if (verdict === 'DEGRADED') {
    return s.verdictDegraded
  }
  if (verdict === 'NOT-READY') {
    return s.verdictNotReady
  }

  return verdict ?? s.verdictUnknown
}

// Capability status → localized word. live/degraded/absent known; else raw.
function capabilityStatusText(status: string | undefined, s: Translations['conductor']['system']): string {
  if (status === 'live') {
    return s.statusLive
  }
  if (status === 'degraded') {
    return s.statusDegraded
  }
  if (status === 'absent') {
    return s.statusAbsent
  }

  return status ?? s.verdictUnknown
}

function MissionDetail({
  c,
  cockpit,
  isError,
  isLoading,
  mission,
  missionsError,
  missionsLoading,
  noMissions
}: {
  c: Translations['conductor']
  cockpit?: CockpitProjection
  isError: boolean
  isLoading: boolean
  mission: ConductorMission | null
  missionsError: boolean
  missionsLoading: boolean
  noMissions: boolean
}) {
  if (missionsError) {
    return (
      <div className="grid min-h-48 place-items-center">
        <ErrorState description={c.lanesErrorDesc} title={c.lanesError} />
      </div>
    )
  }

  if (missionsLoading) {
    return (
      <div className="grid min-h-48 place-items-center">
        <Loader label={c.loading} />
      </div>
    )
  }

  if (noMissions || !mission) {
    return <EmptyState description={c.emptyDesc} title={c.emptyLanes} />
  }

  if (isError) {
    return (
      <div className="grid min-h-48 place-items-center">
        <ErrorState description={c.cockpitErrorDesc} title={c.cockpitError} />
      </div>
    )
  }

  // Spin only while the cockpit query is genuinely fetching with no prior data.
  if (isLoading) {
    return (
      <div className="grid min-h-48 place-items-center">
        <Loader label={c.cockpitLoading} />
      </div>
    )
  }

  // Settled but the tool returned no projection: show an empty state instead of
  // an endless spinner.
  if (!cockpit) {
    return <EmptyState description={c.noProjectionDesc} title={c.noProjection} />
  }

  const core = cockpit.core ?? {}
  const card = cockpit.surfaces?.dashboard?.card ?? {}

  // Controls come off the card (rich {id, requiresOwnerApproval} chips); fall
  // back to core.controls (a bare id list) when the card omits them.
  const controls: CockpitCardControl[] =
    card.controls ?? (core.controls ?? []).map(id => ({ id }))

  // Refs come off the card; fall back to the flat core.*Ref fields. Skip nulls.
  const refs: CockpitCardRefs = card.refs ?? {
    validationContract: core.validationContractRef,
    proofBundle: core.proofBundleRef,
    handoff: core.handoffPath
  }
  const refRows = [
    { label: c.refValidationContract, value: refs.validationContract },
    { label: c.refProofBundle, value: refs.proofBundle },
    { label: c.refHandoff, value: refs.handoff }
  ].filter((row): row is { label: string; value: string } => !!row.value)

  const state = core.state ?? mission.state
  const realmId = core.realmId ?? mission.realmId
  const repoFamily = core.repoFamily ?? mission.repoFamily
  const severity = core.severity ?? mission.severity

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto w-full max-w-2xl">
        <SectionHeading icon={SteeringWheel} title={card.title || mission.missionId} />

        <div className="flex flex-col">
          <ListRow
            action={
              <span className="inline-flex items-center gap-2 text-[length:var(--conversation-text-font-size)] text-foreground sm:justify-self-end">
                <StatusDot tone={stateTone(state)} />
                {stateLabel(state, c)}
              </span>
            }
            title={c.fieldState}
          />
          <ListRow action={detailValue(core.priority)} title={c.fieldPriority} />
          <ListRow action={detailValue(severity)} title={c.fieldSeverity} />
          <ListRow action={detailValue(realmId)} title={c.fieldRealm} />
          <ListRow action={detailValue(repoFamily)} title={c.fieldRepo} />
          <ListRow action={detailValue(core.ownerGoal)} title={c.fieldOwnerGoal} />
        </div>

        <SectionHeading
          icon={Package}
          meta={controls.length ? String(controls.length) : undefined}
          title={c.controlsTitle}
        />
        {controls.length === 0 ? (
          <p className="py-2 text-xs text-muted-foreground">{c.noControls}</p>
        ) : (
          <div className="flex flex-wrap gap-2 py-2">
            {controls.map(control => (
              <span
                className="inline-flex items-center gap-1.5 rounded-md bg-(--ui-bg-quaternary) px-2 py-1 text-[length:var(--conversation-caption-font-size)] text-(--ui-text-secondary)"
                key={control.id}
                title={control.requiresOwnerApproval ? c.ownerApproval : undefined}
              >
                {control.requiresOwnerApproval && (
                  <Lock aria-label={c.ownerApproval} className="size-3 text-muted-foreground" />
                )}
                <span className="font-mono">{control.id}</span>
              </span>
            ))}
          </div>
        )}

        <SectionHeading
          icon={GitBranch}
          meta={refRows.length ? String(refRows.length) : undefined}
          title={c.refsTitle}
        />
        {refRows.length === 0 ? (
          <p className="py-2 pb-6 text-xs text-muted-foreground">{c.noRefs}</p>
        ) : (
          <div className="mb-6 flex flex-col">
            {refRows.map(row => (
              <ListRow
                action={
                  <span className="font-mono text-[length:var(--conversation-caption-font-size)] break-all text-(--ui-text-secondary) sm:justify-self-end">
                    {row.value}
                  </span>
                }
                key={row.label}
                title={row.label}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

function detailValue(value: string | undefined): React.ReactNode {
  return (
    <span
      className={cn(
        'text-[length:var(--conversation-text-font-size)] sm:justify-self-end',
        value ? 'text-foreground' : 'text-muted-foreground'
      )}
    >
      {value || '—'}
    </span>
  )
}
