import { useStore } from '@nanostores/react'
import { useMutation, useQuery } from '@tanstack/react-query'
import type * as React from 'react'
import { useEffect, useMemo, useState } from 'react'

import { StatusDot, type StatusTone } from '@/components/status-dot'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { ErrorState } from '@/components/ui/error-state'
import { Loader } from '@/components/ui/loader'
import { LogView } from '@/components/ui/log-view'
import { type Translations, useI18n } from '@/i18n'
import {
  Activity,
  Brain,
  CheckCircle2,
  Cpu,
  FileText,
  GitBranch,
  Globe,
  type IconComponent,
  Lock,
  Package,
  Play,
  SteeringWheel,
  Zap
} from '@/lib/icons'
import { cn } from '@/lib/utils'
import { $activeMissionId, setActiveMission } from '@/store/conductor'

import { OverlayMain, OverlayNavItem, OverlayNewButton, OverlaySidebar, OverlaySplitLayout } from '../overlays/overlay-split-layout'
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

// The receipt stream feeds the agent verdicts, the cost economy, and the routing
// win-rate. It is shared by the mission detail (latest receipt for the selected
// lane) AND the system-health routing summary (aggregate across all receipts),
// so it is lifted into ConductorView and polled once on a middle cadence.
const RECEIPTS_INTERVAL_MS = 5000

const RECEIPTS_LIMIT = 100

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

// -- Drive (preview + owner-confirm + run) shapes ---------------------
// The conduct dry plan the gateway returns under { ok: true, plan }. Only the
// fields the drive preview renders (the agents with their role + lane, and the
// top-level reason); everything is optional so a partial plan still renders.
interface ConductPlanAgent {
  role?: string
  lane?: string
  provider?: string
}

interface ConductPlan {
  valid?: boolean
  reason?: string
  mode?: string
  agents?: ConductPlanAgent[]
}

interface ConductorDryRunResponse extends GatewayResult {
  plan?: ConductPlan
}

// The execute response: { ok: true, started: true, approvalId } on success, or
// the { ok: false, reason } envelope on a spawn failure.
interface ConductorExecuteResponse extends GatewayResult {
  started?: boolean
  approvalId?: string
}

// -- Receipts (agents + economy + routing) shapes ---------------------
//
// conductor.receipts.tail returns the receipt event stream. Each event carries a
// receipt whose `agents` array records which engine ran each role + its verdict;
// the cockpit reads these to surface the cross-family agent verdicts (the Wave-4
// gap the mission projection itself does not carry), the per-lane cost economy,
// and a routing win-rate. Everything is optional so a partial receipt still
// renders without throwing.
interface ReceiptAgent {
  role?: string
  provider?: string
  model?: string
  lane?: string
  verdict?: string
}

interface ReceiptBody {
  agents?: ReceiptAgent[]
  // The conductor's diff for this run (CC-E): a `git diff --stat` summary string
  // and the list of changed file paths. Both optional - dry runs and diff-less
  // receipts carry neither, older receipts predate the fields.
  diffStat?: string
  changedFiles?: string[]
}

interface ReceiptEvent {
  eventSequence?: number
  missionId?: string
  receipt?: ReceiptBody
}

interface ConductorReceiptsResponse extends GatewayResult {
  receipts?: ReceiptEvent[]
  nextCursor?: number
}

// Lane → cost tier. Static map in the renderer (no new gateway work): which
// engine lane costs what. local is free, codex rides a subscription, the metered
// frontier lanes (claude/gemini) bill per token, anything else is unknown.
type CostTier = 'free' | 'subscription' | 'metered' | 'unknown'

const LANE_COST_TIER: Record<string, CostTier> = {
  local: 'free',
  codex: 'subscription',
  claude: 'metered',
  gemini: 'metered'
}

function costTier(lane: string | undefined): CostTier {
  return (lane ? LANE_COST_TIER[lane] : undefined) ?? 'unknown'
}

// Cost tier → localized label.
function costTierLabel(tier: CostTier, ins: Translations['conductor']['insights']): string {
  if (tier === 'free') {
    return ins.costFree
  }
  if (tier === 'subscription') {
    return ins.costSubscription
  }
  if (tier === 'metered') {
    return ins.costMetered
  }

  return ins.costUnknown
}

// Cost tier → StatusDot tone for the pill pip. free reads as the accent "good"
// pip, metered as a warning, subscription/unknown as a muted/tertiary pip.
function costTierTone(tier: CostTier): StatusTone {
  if (tier === 'free') {
    return 'good'
  }
  if (tier === 'metered') {
    return 'warn'
  }

  return 'muted'
}

// Agent verdict → StatusDot tone. pass/passed/ok read as success (good),
// fail/failed as destructive (bad), anything else as a warning.
function agentVerdictTone(verdict: string | undefined): StatusTone {
  const v = verdict?.toLowerCase()
  if (v === 'pass' || v === 'passed' || v === 'ok') {
    return 'good'
  }
  if (v === 'fail' || v === 'failed') {
    return 'bad'
  }

  return 'warn'
}

// Whether an agent verdict counts as a routing win.
function isWin(verdict: string | undefined): boolean {
  return agentVerdictTone(verdict) === 'good'
}

// Win-rate → StatusDot tone. >=0.8 good, >=0.5 warn, else bad.
function winRateTone(wins: number, total: number): StatusTone {
  if (total === 0) {
    return 'muted'
  }
  const rate = wins / total
  if (rate >= 0.8) {
    return 'good'
  }
  if (rate >= 0.5) {
    return 'warn'
  }

  return 'bad'
}

// The latest receipt for a mission: the one with the max eventSequence whose
// missionId matches. Null when the mission has no receipt yet.
function latestReceiptFor(receipts: ReceiptEvent[], missionId: string | null): ReceiptEvent | null {
  if (!missionId) {
    return null
  }

  let latest: ReceiptEvent | null = null
  for (const event of receipts) {
    if (event.missionId !== missionId) {
      continue
    }
    if (!latest || (event.eventSequence ?? 0) > (latest.eventSequence ?? 0)) {
      latest = event
    }
  }

  return latest
}

// One routing row: an engine (provider:model) with its lane, cost tier, and
// aggregate win/total across every receipt's agents.
interface RoutingRow {
  key: string
  provider: string
  model: string
  lane?: string
  wins: number
  total: number
}

// Aggregate the routing brain: group every agent across all receipts by
// provider:model, counting wins (verdict pass) / total. The lane is taken from
// the first agent seen for the engine (an engine rides one lane).
function aggregateRouting(receipts: ReceiptEvent[]): RoutingRow[] {
  const byEngine = new Map<string, RoutingRow>()

  for (const event of receipts) {
    for (const agent of event.receipt?.agents ?? []) {
      const provider = agent.provider ?? '—'
      const model = agent.model ?? '—'
      const key = `${provider}:${model}`
      let row = byEngine.get(key)
      if (!row) {
        row = { key, provider, model, lane: agent.lane, wins: 0, total: 0 }
        byEngine.set(key, row)
      }
      row.total += 1
      if (isWin(agent.verdict)) {
        row.wins += 1
      }
    }
  }

  return [...byEngine.values()]
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

// The per-lane cost badge: a small pill, lane + cost-tier label, toned by tier.
// Composed from the StatusDot primitive + tokens (no new chrome). Shared by the
// agent rows (the per-run economy) and the routing rows (the routing brain).
function CostBadge({ lane, ins }: { lane: string | undefined; ins: Translations['conductor']['insights'] }) {
  const tier = costTier(lane)

  return (
    <span className="inline-flex items-center gap-1.5 rounded-md bg-(--ui-bg-quaternary) px-2 py-0.5 text-[length:var(--conversation-caption-font-size)] text-(--ui-text-secondary)">
      <StatusDot tone={costTierTone(tier)} />
      <span className="font-mono">{ins.laneCost(lane ?? '—', costTierLabel(tier, ins))}</span>
    </span>
  )
}

interface ConductorViewProps extends React.ComponentProps<'section'> {
  onClose: () => void
  requestGateway: RequestGateway
}

export function ConductorView({ onClose, requestGateway }: ConductorViewProps) {
  const { t } = useI18n()
  const c = t.conductor
  const activeMissionId = useStore($activeMissionId)

  // The drive dialog: preview a conduct (dry plan), then with an explicit owner
  // confirm, run it locally. Closed by default; the sidebar "New run" opens it.
  const [driveOpen, setDriveOpen] = useState(false)

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

  // The receipt stream: lifted here so both the mission detail (latest receipt
  // for the selected lane) and the system-health routing summary (aggregate)
  // read the same single poll. Throw on the {ok:false} envelope so both consumers
  // route to a receipts ErrorState rather than rendering stale/blank insights.
  const receiptsQuery = useQuery({
    queryKey: ['conductor', 'receipts'],
    queryFn: async () => {
      const res = await requestGateway<ConductorReceiptsResponse>('conductor.receipts.tail', {
        afterSequence: 0,
        limit: RECEIPTS_LIMIT
      })

      if (res && res.ok === false) {
        throw new Error(res.reason ?? 'receipts_unavailable')
      }

      return res
    },
    refetchInterval: RECEIPTS_INTERVAL_MS
  })

  const receipts = useMemo(() => receiptsQuery.data?.receipts ?? [], [receiptsQuery.data])

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

          <OverlayNewButton icon="play" label={c.drive.newRun} onClick={() => setDriveOpen(true)} />

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
              receipts={receipts}
              receiptsError={receiptsQuery.isError}
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
              receipts={receipts}
              receiptsError={receiptsQuery.isError}
            />
          )}
        </OverlayMain>
      </OverlaySplitLayout>

      <DriveDialog c={c} onOpenChange={setDriveOpen} open={driveOpen} requestGateway={requestGateway} />
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
  receipts,
  receiptsError,
  report
}: {
  c: Translations['conductor']
  isError: boolean
  isLoading: boolean
  receipts: ReceiptEvent[]
  receiptsError: boolean
  report?: SelfCheckReport
}) {
  const s = c.system
  const ins = c.insights

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
          <p className="py-2 text-xs text-muted-foreground">{s.noFloors}</p>
        ) : (
          <div className="flex flex-col">
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

        <RoutingSection ins={ins} receipts={receipts} receiptsError={receiptsError} />
      </div>
    </div>
  )
}

// The routing brain: which engines are winning + at what cost. Aggregates every
// agent across all receipts by provider:model, rendering a win/total ratio toned
// by win-rate plus the engine's cost tier. Composed from existing primitives +
// tokens; flat, no new gateway calls. The receipts error rides through so the
// pane shows the receipts ErrorState rather than silently dropping the section.
function RoutingSection({
  ins,
  receipts,
  receiptsError
}: {
  ins: Translations['conductor']['insights']
  receipts: ReceiptEvent[]
  receiptsError: boolean
}) {
  const rows = useMemo(() => aggregateRouting(receipts), [receipts])

  return (
    <>
      <SectionHeading icon={Brain} meta={rows.length ? String(rows.length) : undefined} title={ins.routingTitle} />
      {receiptsError ? (
        <div className="mb-6 grid min-h-32 place-items-center">
          <ErrorState description={ins.receiptsErrorDesc} title={ins.receiptsError} />
        </div>
      ) : rows.length === 0 ? (
        <p className="py-2 pb-6 text-xs text-muted-foreground">{ins.noRouting}</p>
      ) : (
        <div className="mb-6 flex flex-col">
          {rows.map(row => (
            <ListRow
              action={
                <span className="inline-flex items-center gap-2 text-[length:var(--conversation-text-font-size)] text-foreground sm:justify-self-end">
                  <StatusDot tone={winRateTone(row.wins, row.total)} />
                  {ins.winRate(row.wins, row.total)}
                </span>
              }
              description={<CostBadge ins={ins} lane={row.lane} />}
              key={row.key}
              title={<span className="font-mono">{row.key}</span>}
            />
          ))}
        </div>
      )}
    </>
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
  noMissions,
  receipts,
  receiptsError
}: {
  c: Translations['conductor']
  cockpit?: CockpitProjection
  isError: boolean
  isLoading: boolean
  mission: ConductorMission | null
  missionsError: boolean
  missionsLoading: boolean
  noMissions: boolean
  receipts: ReceiptEvent[]
  receiptsError: boolean
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

        <AgentsSection ins={c.insights} missionId={mission.missionId} receipts={receipts} receiptsError={receiptsError} />

        <ChangesSection ch={c.changes} missionId={mission.missionId} receipts={receipts} />

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

// The cross-family agent verdicts for a mission: the agents of its LATEST receipt
// (max eventSequence), each with its engine (provider:model), the verdict pip +
// word, and the per-lane cost badge. This is the Wave-4 gap the mission
// projection itself does not carry. Composed from existing primitives + tokens;
// a quiet no-run line when the mission has no receipt (never a crash).
function AgentsSection({
  ins,
  missionId,
  receipts,
  receiptsError
}: {
  ins: Translations['conductor']['insights']
  missionId: string
  receipts: ReceiptEvent[]
  receiptsError: boolean
}) {
  const agents = useMemo(() => {
    const latest = latestReceiptFor(receipts, missionId)

    return latest?.receipt?.agents ?? []
  }, [receipts, missionId])

  return (
    <>
      <SectionHeading icon={Cpu} meta={agents.length ? String(agents.length) : undefined} title={ins.agentsTitle} />
      {receiptsError ? (
        <div className="grid min-h-32 place-items-center">
          <ErrorState description={ins.receiptsErrorDesc} title={ins.receiptsError} />
        </div>
      ) : agents.length === 0 ? (
        <p className="py-2 text-xs text-muted-foreground">{ins.noAgentRun}</p>
      ) : (
        <div className="flex flex-col">
          {agents.map((agent, index) => (
            <ListRow
              action={
                <span className="inline-flex items-center gap-2 sm:justify-self-end">
                  <span className="inline-flex items-center gap-2 text-[length:var(--conversation-text-font-size)] text-foreground">
                    <StatusDot tone={agentVerdictTone(agent.verdict)} />
                    {agent.verdict ?? '—'}
                  </span>
                  <CostBadge ins={ins} lane={agent.lane} />
                </span>
              }
              description={<span className="font-mono">{`${agent.provider ?? '—'}:${agent.model ?? '—'}`}</span>}
              key={`${agent.role ?? 'agent'}-${index}`}
              title={<span className="font-mono">{agent.role ?? '—'}</span>}
            />
          ))}
        </div>
      )}
    </>
  )
}

// The conductor's diff for a mission: the diff carried on its LATEST receipt
// (max eventSequence). The `git diff --stat` summary renders in the shared
// LogView (mono), the changed files as a flat list under a counted subheading.
// A diff-less receipt (dry run) shows a quiet "no changes recorded" line; a
// mission with NO receipt renders nothing (the Agents section owns the no-run
// case, so this section stays silent rather than duplicating it). Composed from
// existing primitives + tokens; no new gateway calls (reuses the receipts feed).
function ChangesSection({
  ch,
  missionId,
  receipts
}: {
  ch: Translations['conductor']['changes']
  missionId: string
  receipts: ReceiptEvent[]
}) {
  const latest = useMemo(() => latestReceiptFor(receipts, missionId), [receipts, missionId])

  // No receipt at all for this mission: render nothing for the Changes section.
  if (!latest) {
    return null
  }

  const diffStat = latest.receipt?.diffStat?.trim() ?? ''
  const changedFiles = latest.receipt?.changedFiles ?? []
  const hasDiff = diffStat.length > 0 || changedFiles.length > 0

  return (
    <>
      <SectionHeading icon={FileText} title={ch.changesTitle} />
      {!hasDiff ? (
        <p className="py-2 text-xs text-muted-foreground">{ch.noChanges}</p>
      ) : (
        <div className="flex flex-col gap-2 py-1">
          {diffStat.length > 0 && <LogView className="max-h-48">{diffStat}</LogView>}
          {changedFiles.length > 0 && (
            <div className="flex flex-col">
              <SectionHeading icon={GitBranch} meta={String(changedFiles.length)} title={ch.changedFilesTitle} />
              {changedFiles.map(file => (
                <ListRow
                  key={file}
                  title={<span className="font-mono text-[length:var(--conversation-caption-font-size)] break-all text-(--ui-text-secondary)">{file}</span>}
                />
              ))}
            </div>
          )}
        </div>
      )}
    </>
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

// -- Drive dialog: preview a conduct, then owner-confirm + run it -----
//
// The interactive heart of the cockpit. Step 1 PREVIEW calls conductor.dryRun
// (side-effect-free, no spawn/spend) and renders the plan's agents + lanes +
// reason. Step 2 RUN is GATED behind an explicit owner-approval checkbox (the
// confirm IS the Phase-2 approval); only when it is checked does the Run button
// enable and call conductor.execute({ ownerConfirmed: true, approvalId }). The
// run is LOCAL and FREE - a hint line makes that obvious and reassures that no
// frontier model is triggered. Composed from the Dialog + Button + Checkbox
// primitives and existing list primitives; flat, tokens only.
function DriveDialog({
  c,
  onOpenChange,
  open,
  requestGateway
}: {
  c: Translations['conductor']
  onOpenChange: (open: boolean) => void
  open: boolean
  requestGateway: RequestGateway
}) {
  const d = c.drive

  // The owner-approval confirm. The Run button is disabled until this is true.
  const [confirmed, setConfirmed] = useState(false)

  // Generate one approvalId per dialog session (regenerated on each open). It is
  // opaque; the gateway accepts it and rides it on the owner-gated CLI flag.
  const [approvalId, setApprovalId] = useState(() => makeApprovalId())

  // Reset the dialog's transient state whenever it (re)opens so a prior preview,
  // confirm, or started receipt never leaks into a fresh drive.
  const previewMutation = useMutation({
    mutationFn: async () => {
      const res = await requestGateway<ConductorDryRunResponse>('conductor.dryRun', {})
      if (res && res.ok === false) {
        throw new Error(res.reason ?? 'conduct_dryrun_unavailable')
      }

      return res
    }
  })

  const executeMutation = useMutation({
    mutationFn: async () => {
      const res = await requestGateway<ConductorExecuteResponse>('conductor.execute', {
        approvalId,
        mockModel: true,
        ownerConfirmed: true
      })
      if (res && res.ok === false) {
        throw new Error(res.reason ?? 'conduct_execute_unavailable')
      }

      return res
    }
  })

  // On open transition, clear everything so each drive starts clean.
  useEffect(() => {
    if (open) {
      setConfirmed(false)
      setApprovalId(makeApprovalId())
      previewMutation.reset()
      executeMutation.reset()
    }
    // Only react to the open transition; the mutations are stable refs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  const plan = previewMutation.data?.plan
  const agents = plan?.agents ?? []
  const started = executeMutation.data?.started === true
  const startedApprovalId = executeMutation.data?.approvalId ?? approvalId

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle icon={SteeringWheel}>{d.title}</DialogTitle>
          <DialogDescription>{d.intro}</DialogDescription>
        </DialogHeader>

        {started ? (
          <div className="grid place-items-center gap-3 py-6 text-center">
            <CheckCircle2 className="size-7 text-primary" />
            <div>
              <div className="text-[length:var(--conversation-text-font-size)] font-medium text-foreground">{d.started}</div>
              <div className="mt-1 max-w-prose text-[length:var(--conversation-caption-font-size)] leading-(--conversation-caption-line-height) text-(--ui-text-tertiary)">
                {d.startedDesc}
              </div>
              <div className="mt-2 font-mono text-[0.68rem] text-muted-foreground/60">{d.startedApproval(startedApprovalId)}</div>
            </div>
          </div>
        ) : (
          <div className="grid gap-1">
            {/* Local-only + free hint: keep it obvious frontier is not triggered. */}
            <div className="flex items-center gap-2 text-[length:var(--conversation-caption-font-size)] text-(--ui-text-tertiary)">
              <Lock className="size-3 shrink-0" />
              <span>{d.localHint}</span>
            </div>

            {previewMutation.isError ? (
              <div className="grid min-h-32 place-items-center">
                <ErrorState description={d.previewErrorDesc} title={d.previewError} />
              </div>
            ) : previewMutation.isPending ? (
              <div className="grid min-h-32 place-items-center">
                <Loader label={d.previewing} />
              </div>
            ) : !plan ? (
              <EmptyState description={d.noPlanDesc} title={d.noPlan} />
            ) : (
              <div>
                <SectionHeading icon={Package} meta={agents.length ? String(agents.length) : undefined} title={d.agents} />
                {agents.length === 0 ? (
                  <p className="py-2 text-xs text-muted-foreground">{d.noAgents}</p>
                ) : (
                  <div className="flex flex-col">
                    {agents.map((agent, index) => (
                      <ListRow
                        action={
                          <span className="font-mono text-[length:var(--conversation-caption-font-size)] text-(--ui-text-secondary) sm:justify-self-end">
                            {d.laneLabel(agent.lane ?? '—')}
                          </span>
                        }
                        description={agent.provider}
                        key={`${agent.role ?? 'agent'}-${index}`}
                        title={<span className="font-mono">{agent.role ?? '—'}</span>}
                      />
                    ))}
                  </div>
                )}

                {plan.reason && (
                  <p className="mt-1 font-mono text-[0.68rem] text-muted-foreground/60">
                    <span>{d.planReason}: </span>
                    <span>{plan.reason}</span>
                  </p>
                )}

                {/* Owner approval gate: the Run button stays disabled until checked. */}
                <label className="mt-3 flex cursor-pointer items-start gap-2.5">
                  <Checkbox
                    aria-label={d.confirm}
                    checked={confirmed}
                    className="mt-0.5"
                    onCheckedChange={value => setConfirmed(value === true)}
                  />
                  <span className="text-[length:var(--conversation-text-font-size)] text-foreground">{d.confirm}</span>
                </label>

                {executeMutation.isError && (
                  <div className="mt-3 grid place-items-center">
                    <ErrorState description={d.runErrorDesc} title={d.runError} />
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        <DialogFooter>
          {started ? (
            <Button onClick={() => onOpenChange(false)} variant="secondary">
              {d.done}
            </Button>
          ) : (
            <>
              <Button onClick={() => previewMutation.mutate()} variant="secondary">
                {previewMutation.isPending ? d.previewing : plan ? d.previewAgain : d.preview}
              </Button>
              <Button
                disabled={!confirmed || !plan || executeMutation.isPending}
                onClick={() => executeMutation.mutate()}
              >
                <Play />
                {executeMutation.isPending ? d.running : d.run}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// A short, opaque approval id (no clock dependency the renderer cannot trust).
// crypto.randomUUID where available, else a random hex fallback.
function makeApprovalId(): string {
  const uuid =
    typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : Math.random().toString(16).slice(2)

  return `cockpit-${uuid}`
}
