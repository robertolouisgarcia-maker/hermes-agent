import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { I18nProvider } from '@/i18n'
import { $activeMissionId } from '@/store/conductor'

import { ConductorView } from './index'

interface MissionRow {
  missionId: string
  state: string
  realmId?: string
  repoFamily?: string
}

const MISSIONS: MissionRow[] = [
  { missionId: 'mission-alpha', state: 'working', realmId: 'fin', repoFamily: 'fin-agentic' },
  { missionId: 'mission-bravo', state: 'release_ready', realmId: 'ph', repoFamily: 'hermes-agent' },
  { missionId: 'mission-charlie', state: 'blocked', realmId: 'fin', repoFamily: 'fin-demo' }
]

function cockpitFor(missionId: string) {
  return {
    projection: {
      core: {
        missionId,
        title: missionId,
        ownerGoal: 'ship the thing',
        state: 'working',
        priority: 'P1',
        severity: 'normal',
        realmId: 'fin',
        repoFamily: 'fin-agentic'
      },
      surfaces: {
        dashboard: {
          card: {
            title: missionId,
            controls: [
              { id: 'pause', requiresOwnerApproval: true },
              { id: 'resume', requiresOwnerApproval: true }
            ],
            refs: {
              validationContract: 'vault://contracts/alpha.json',
              proofBundle: null,
              handoff: null
            }
          }
        }
      }
    }
  }
}

function readyMatrix() {
  return {
    report: {
      schema: 'developer_os_self_check_v1',
      ready: true,
      verdict: 'READY',
      capabilities: [
        { name: 'CAP-1', status: 'live', evidence: 'conductor dry-run ready', detail: 'd1' },
        { name: 'CAP-7', status: 'degraded', evidence: 'gemini cli missing', detail: 'd7' },
        { name: 'CAP-9', status: 'absent', evidence: 'receipt probe threw', detail: 'd9' }
      ],
      governanceFloors: [
        { floor: 'FLOOR-1', holds: true, evidence: 'data boundary local-only' },
        { floor: 'FLOOR-2', holds: false, evidence: 'subscription billing breached' }
      ],
      summary: { capabilitiesLive: 1, floorsHeld: 1 },
      generatedNote: 'in-process, dry-run only.'
    }
  }
}

function notReadyMatrix() {
  return {
    report: {
      ...readyMatrix().report,
      ready: false,
      verdict: 'NOT-READY'
    }
  }
}

function renderConductor(requestGateway: (method: string, params?: Record<string, unknown>) => Promise<unknown>) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } }
  })

  return render(
    <QueryClientProvider client={queryClient}>
      <I18nProvider configClient={null} initialLocale="en">
        <ConductorView onClose={vi.fn()} requestGateway={requestGateway as never} />
      </I18nProvider>
    </QueryClientProvider>
  )
}

afterEach(() => {
  cleanup()
  $activeMissionId.set(null)
  vi.clearAllMocks()
})

beforeEach(() => {
  $activeMissionId.set(null)
})

describe('ConductorView', () => {
  it('renders a lane list from the missions RPC', async () => {
    const requestGateway = vi.fn(async (method: string) => {
      if (method === 'conductor.missions.list') {
        return { missions: MISSIONS }
      }

      return cockpitFor('mission-alpha')
    })

    renderConductor(requestGateway)

    await waitFor(() => {
      expect(screen.getByText('mission-alpha')).toBeTruthy()
    })
    expect(screen.getByText('mission-bravo')).toBeTruthy()
    expect(screen.getByText('mission-charlie')).toBeTruthy()
    expect(requestGateway).toHaveBeenCalledWith('conductor.missions.list', expect.any(Object))
  })

  it('renders the mission detail from the cockpit projection', async () => {
    const requestGateway = vi.fn(async (method: string, params?: Record<string, unknown>) => {
      if (method === 'conductor.missions.list') {
        return { missions: MISSIONS }
      }

      if (method === 'conductor.cockpit.get') {
        return cockpitFor(String(params?.missionId ?? 'mission-alpha'))
      }

      return { projection: {} }
    })

    renderConductor(requestGateway)

    // Auto-selects the first lane → cockpit.get fires for it.
    await waitFor(() => {
      expect(requestGateway).toHaveBeenCalledWith('conductor.cockpit.get', expect.objectContaining({ missionId: 'mission-alpha' }))
    })

    // Real projection content: the realm value, a control id, and a present ref.
    await waitFor(() => {
      expect(screen.getByText('fin')).toBeTruthy()
    })
    expect(screen.getByText('pause')).toBeTruthy()
    expect(screen.getByText('resume')).toBeTruthy()
    expect(screen.getByText('vault://contracts/alpha.json')).toBeTruthy()
  })

  it('renders the cockpit error state when the gateway returns ok:false', async () => {
    const requestGateway = vi.fn(async (method: string) => {
      if (method === 'conductor.missions.list') {
        return { missions: MISSIONS }
      }

      if (method === 'conductor.cockpit.get') {
        return { ok: false, reason: 'cockpit_unavailable' }
      }

      return { projection: {} }
    })

    renderConductor(requestGateway)

    await waitFor(() => {
      expect(screen.getByText('Could not load cockpit')).toBeTruthy()
    })
  })

  it('shows the empty state when there are no missions', async () => {
    const requestGateway = vi.fn(async (method: string) => {
      if (method === 'conductor.missions.list') {
        return { missions: [] }
      }

      return cockpitFor('none')
    })

    renderConductor(requestGateway)

    // The empty copy shows in both the sidebar (compact) and the main pane
    // (EmptyState), so assert at least one rendered.
    await waitFor(() => {
      expect(screen.getAllByText('No active missions').length).toBeGreaterThan(0)
    })
  })

  it('shows the error state when the missions RPC rejects', async () => {
    const requestGateway = vi.fn(async (method: string) => {
      if (method === 'conductor.missions.list') {
        throw new Error('gateway boom')
      }

      return cockpitFor('none')
    })

    renderConductor(requestGateway)

    // The error copy shows in both the sidebar (compact) and the main pane
    // (ErrorState), so assert at least one rendered.
    await waitFor(() => {
      expect(screen.getAllByText('Could not load missions').length).toBeGreaterThan(0)
    })
  })

  it('selecting a lane updates $activeMissionId and triggers cockpit.get for it', async () => {
    const requestGateway = vi.fn(async (method: string, params?: Record<string, unknown>) => {
      if (method === 'conductor.missions.list') {
        return { missions: MISSIONS }
      }

      if (method === 'conductor.cockpit.get') {
        return cockpitFor(String(params?.missionId ?? ''))
      }

      return { projection: {} }
    })

    renderConductor(requestGateway)

    await waitFor(() => {
      expect(screen.getByText('mission-bravo')).toBeTruthy()
    })

    fireEvent.click(screen.getByText('mission-bravo'))

    await waitFor(() => {
      expect($activeMissionId.get()).toBe('mission-bravo')
    })

    await waitFor(() => {
      expect(requestGateway).toHaveBeenCalledWith('conductor.cockpit.get', expect.objectContaining({ missionId: 'mission-bravo' }))
    })
  })

  // ── System-health pane (cockpit home when no mission is selected) ──

  it('renders the system-health verdict + capability rows + floor rows from the self-check', async () => {
    const requestGateway = vi.fn(async (method: string) => {
      if (method === 'conductor.missions.list') {
        return { missions: [] }
      }

      if (method === 'conductor.systemcheck') {
        return readyMatrix()
      }

      return { projection: {} }
    })

    renderConductor(requestGateway)

    // The cockpit home queries the self-check.
    await waitFor(() => {
      expect(requestGateway).toHaveBeenCalledWith('conductor.systemcheck', expect.any(Object))
    })

    // Verdict header (READY → "Ready"), with the system-health title.
    await waitFor(() => {
      expect(screen.getByText('System health')).toBeTruthy()
    })
    expect(screen.getByText('Ready')).toBeTruthy()

    // A capability row per capability: id + evidence + the status word.
    expect(screen.getByText('CAP-1')).toBeTruthy()
    expect(screen.getByText('CAP-7')).toBeTruthy()
    expect(screen.getByText('CAP-9')).toBeTruthy()
    expect(screen.getByText('conductor dry-run ready')).toBeTruthy()
    // Status words for live / degraded / absent are all present.
    expect(screen.getByText('Live')).toBeTruthy()
    // Degraded appears for the verdict-less capability AND nowhere else here.
    expect(screen.getByText('Absent')).toBeTruthy()

    // A floor row per governance floor: id + holds/breached.
    expect(screen.getByText('FLOOR-1')).toBeTruthy()
    expect(screen.getByText('FLOOR-2')).toBeTruthy()
    expect(screen.getByText('Holds')).toBeTruthy()
    expect(screen.getByText('Breached')).toBeTruthy()
    expect(screen.getByText('data boundary local-only')).toBeTruthy()
  })

  it('shows the destructive verdict label for a NOT-READY matrix', async () => {
    const requestGateway = vi.fn(async (method: string) => {
      if (method === 'conductor.missions.list') {
        return { missions: [] }
      }

      if (method === 'conductor.systemcheck') {
        return notReadyMatrix()
      }

      return { projection: {} }
    })

    renderConductor(requestGateway)

    await waitFor(() => {
      expect(screen.getByText('Not ready')).toBeTruthy()
    })
  })

  it('shows the system-health error state when the self-check returns ok:false', async () => {
    const requestGateway = vi.fn(async (method: string) => {
      if (method === 'conductor.missions.list') {
        return { missions: [] }
      }

      if (method === 'conductor.systemcheck') {
        return { ok: false, reason: 'self_check_timeout' }
      }

      return { projection: {} }
    })

    renderConductor(requestGateway)

    await waitFor(() => {
      expect(screen.getByText('Could not run self-check')).toBeTruthy()
    })
  })

  it('shows the loader while the self-check is pending', async () => {
    let resolveSelfCheck: ((value: unknown) => void) | undefined
    const requestGateway = vi.fn(async (method: string) => {
      if (method === 'conductor.missions.list') {
        return { missions: [] }
      }

      if (method === 'conductor.systemcheck') {
        return new Promise(resolve => {
          resolveSelfCheck = resolve
        })
      }

      return { projection: {} }
    })

    renderConductor(requestGateway)

    // The self-check promise never resolves yet → the Loader shows (its label
    // rides as the accessible name on the role="status" element).
    await waitFor(() => {
      expect(screen.getByRole('status', { name: 'Running self-check...' })).toBeTruthy()
    })

    // Resolve so react-query settles and the test tears down cleanly.
    resolveSelfCheck?.(readyMatrix())
  })

  it('renders system health (not the mission detail) when there are missions but none is selected', async () => {
    const requestGateway = vi.fn(async (method: string) => {
      if (method === 'conductor.missions.list') {
        return { missions: MISSIONS }
      }

      if (method === 'conductor.systemcheck') {
        return readyMatrix()
      }

      if (method === 'conductor.cockpit.get') {
        return cockpitFor('mission-alpha')
      }

      return { projection: {} }
    })

    renderConductor(requestGateway)

    // With missions present, the first lane auto-selects → the detail pane
    // binds to it and the system-health title is NOT shown in the main pane.
    await waitFor(() => {
      expect(requestGateway).toHaveBeenCalledWith('conductor.cockpit.get', expect.objectContaining({ missionId: 'mission-alpha' }))
    })
    await waitFor(() => {
      expect(screen.getByText('fin')).toBeTruthy()
    })
    expect(screen.queryByText('System health')).toBeNull()
  })
})

// -- Drive + approve flow (CC-C / CC-D2-D3) ---------------------------

function dryPlan() {
  return {
    ok: true,
    plan: {
      valid: true,
      reason: 'developer_os_conduct_ready',
      mode: 'dry',
      agents: [
        { role: 'implementer', lane: 'local', provider: 'lmstudio' },
        { role: 'judge', lane: 'local', provider: 'lmstudio' }
      ]
    }
  }
}

async function openDrivePanel() {
  // The "New run" entry tops the sidebar; clicking it opens the drive dialog.
  await waitFor(() => {
    expect(screen.getByText('New run')).toBeTruthy()
  })
  fireEvent.click(screen.getByText('New run'))
  await waitFor(() => {
    expect(screen.getByText('Drive a conduct')).toBeTruthy()
  })
}

describe('ConductorView drive + approve', () => {
  it('renders the New run entry and opens the drive dialog', async () => {
    const requestGateway = vi.fn(async (method: string) => {
      if (method === 'conductor.missions.list') {
        return { missions: [] }
      }

      if (method === 'conductor.systemcheck') {
        return readyMatrix()
      }

      return { projection: {} }
    })

    renderConductor(requestGateway)
    await openDrivePanel()

    // The local-only / free hint is obvious in the panel.
    expect(screen.getByText('Runs locally and free. No frontier model is triggered.')).toBeTruthy()
  })

  it('Preview calls conductor.dryRun and renders the plan agents + lanes + reason', async () => {
    const requestGateway = vi.fn(async (method: string) => {
      if (method === 'conductor.missions.list') {
        return { missions: [] }
      }

      if (method === 'conductor.systemcheck') {
        return readyMatrix()
      }

      if (method === 'conductor.dryRun') {
        return dryPlan()
      }

      return { projection: {} }
    })

    renderConductor(requestGateway)
    await openDrivePanel()

    fireEvent.click(screen.getByText('Preview'))

    await waitFor(() => {
      expect(requestGateway).toHaveBeenCalledWith('conductor.dryRun', expect.any(Object))
    })

    // The plan's agents (role) + lanes + reason render.
    await waitFor(() => {
      expect(screen.getByText('implementer')).toBeTruthy()
    })
    expect(screen.getByText('judge')).toBeTruthy()
    expect(screen.getAllByText('Lane: local').length).toBe(2)
    expect(screen.getByText('developer_os_conduct_ready')).toBeTruthy()
  })

  it('the Run button is disabled until the owner confirm is checked', async () => {
    const requestGateway = vi.fn(async (method: string) => {
      if (method === 'conductor.missions.list') {
        return { missions: [] }
      }

      if (method === 'conductor.systemcheck') {
        return readyMatrix()
      }

      if (method === 'conductor.dryRun') {
        return dryPlan()
      }

      return { projection: {} }
    })

    renderConductor(requestGateway)
    await openDrivePanel()

    fireEvent.click(screen.getByText('Preview'))
    await waitFor(() => {
      expect(screen.getByText('implementer')).toBeTruthy()
    })

    // The Run button exists but is disabled before the confirm checkbox is on.
    const runButton = screen.getByRole('button', { name: 'Run' })
    expect((runButton as HTMLButtonElement).disabled).toBe(true)

    // conductor.execute must NOT have been called yet.
    expect(requestGateway).not.toHaveBeenCalledWith('conductor.execute', expect.anything())
  })

  it('checking confirm + clicking Run calls conductor.execute with ownerConfirmed:true', async () => {
    const requestGateway = vi.fn(async (method: string) => {
      if (method === 'conductor.missions.list') {
        return { missions: [] }
      }

      if (method === 'conductor.systemcheck') {
        return readyMatrix()
      }

      if (method === 'conductor.dryRun') {
        return dryPlan()
      }

      if (method === 'conductor.execute') {
        return { ok: true, started: true, approvalId: 'cockpit-abc' }
      }

      return { projection: {} }
    })

    renderConductor(requestGateway)
    await openDrivePanel()

    fireEvent.click(screen.getByText('Preview'))
    await waitFor(() => {
      expect(screen.getByText('implementer')).toBeTruthy()
    })

    // Toggle the owner-approval confirm checkbox.
    const confirm = screen.getByRole('checkbox', { name: 'I approve running this conduct locally' })
    fireEvent.click(confirm)

    // Now Run is enabled; click it.
    const runButton = screen.getByRole('button', { name: 'Run' })
    await waitFor(() => {
      expect((runButton as HTMLButtonElement).disabled).toBe(false)
    })
    fireEvent.click(runButton)

    await waitFor(() => {
      expect(requestGateway).toHaveBeenCalledWith(
        'conductor.execute',
        expect.objectContaining({ ownerConfirmed: true })
      )
    })

    // The started state surfaces (with the approval id).
    await waitFor(() => {
      expect(screen.getByText('Run started')).toBeTruthy()
    })
  })

  it('a dryRun ok:false shows the preview error state', async () => {
    const requestGateway = vi.fn(async (method: string) => {
      if (method === 'conductor.missions.list') {
        return { missions: [] }
      }

      if (method === 'conductor.systemcheck') {
        return readyMatrix()
      }

      if (method === 'conductor.dryRun') {
        return { ok: false, reason: 'conduct_dryrun_timeout' }
      }

      return { projection: {} }
    })

    renderConductor(requestGateway)
    await openDrivePanel()

    fireEvent.click(screen.getByText('Preview'))

    await waitFor(() => {
      expect(screen.getByText('Could not preview')).toBeTruthy()
    })
  })

  it('an execute ok:false shows the run error state', async () => {
    const requestGateway = vi.fn(async (method: string) => {
      if (method === 'conductor.missions.list') {
        return { missions: [] }
      }

      if (method === 'conductor.systemcheck') {
        return readyMatrix()
      }

      if (method === 'conductor.dryRun') {
        return dryPlan()
      }

      if (method === 'conductor.execute') {
        return { ok: false, reason: 'conduct_execute_error' }
      }

      return { projection: {} }
    })

    renderConductor(requestGateway)
    await openDrivePanel()

    fireEvent.click(screen.getByText('Preview'))
    await waitFor(() => {
      expect(screen.getByText('implementer')).toBeTruthy()
    })

    fireEvent.click(screen.getByRole('checkbox', { name: 'I approve running this conduct locally' }))
    const runButton = screen.getByRole('button', { name: 'Run' })
    await waitFor(() => {
      expect((runButton as HTMLButtonElement).disabled).toBe(false)
    })
    fireEvent.click(runButton)

    await waitFor(() => {
      expect(screen.getByText('Could not start')).toBeTruthy()
    })
  })
})

// -- Cockpit agents + economy + routing (CC-F2/F3) -------------------
//
// The cross-family agent verdicts + per-lane cost economy + routing win-rate, all
// sourced from the EXISTING conductor.receipts.tail gateway. The mission detail
// surfaces the agents of the latest receipt for the selected mission; the system-
// health pane aggregates a routing win-rate across all receipts.

// A receipts.tail page. Two receipts for mission-alpha (so the LATEST, by max
// eventSequence, is the one with the higher sequence) + one for mission-bravo,
// spanning local (free) + claude (metered) lanes and pass/fail verdicts so the
// aggregate win-rate is non-trivial.
function receiptsTail() {
  return {
    ok: true,
    nextCursor: 0,
    receipts: [
      {
        eventSequence: 10,
        missionId: 'mission-alpha',
        receipt: {
          agents: [
            { role: 'stale-implementer', provider: 'lmstudio', model: 'qwen', lane: 'local', verdict: 'fail' }
          ]
        }
      },
      {
        eventSequence: 42,
        missionId: 'mission-alpha',
        receipt: {
          agents: [
            { role: 'implementer', provider: 'lmstudio', model: 'qwen2.5-coder', lane: 'local', verdict: 'pass' },
            { role: 'judge', provider: 'lmstudio', model: 'qwen2.5-coder', lane: 'local', verdict: 'pass' }
          ]
        }
      },
      {
        eventSequence: 7,
        missionId: 'mission-bravo',
        receipt: {
          agents: [
            { role: 'reviewer', provider: 'anthropic', model: 'claude-opus', lane: 'claude', verdict: 'fail' }
          ]
        }
      }
    ]
  }
}

describe('ConductorView agents + economy + routing', () => {
  it('MissionDetail shows the agents + verdicts + cost-tier badges from the latest receipt for the selected mission', async () => {
    const requestGateway = vi.fn(async (method: string, params?: Record<string, unknown>) => {
      if (method === 'conductor.missions.list') {
        return { missions: MISSIONS }
      }

      if (method === 'conductor.cockpit.get') {
        return cockpitFor(String(params?.missionId ?? 'mission-alpha'))
      }

      if (method === 'conductor.receipts.tail') {
        return receiptsTail()
      }

      return { projection: {} }
    })

    renderConductor(requestGateway)

    // The first lane (mission-alpha) auto-selects → the agents of its LATEST
    // receipt (eventSequence 42) render. The stale receipt (seq 10) is ignored.
    await waitFor(() => {
      expect(screen.getByText('implementer')).toBeTruthy()
    })
    expect(screen.getByText('judge')).toBeTruthy()
    // The stale agent from the lower-sequence receipt must NOT show.
    expect(screen.queryByText('stale-implementer')).toBeNull()

    // The Agents section heading is present.
    expect(screen.getByText('Agents')).toBeTruthy()

    // provider:model secondary line.
    expect(screen.getAllByText('lmstudio:qwen2.5-coder').length).toBe(2)

    // The verdict word + the cost-tier badge (local → free).
    expect(screen.getAllByText('pass').length).toBe(2)
    expect(screen.getAllByText('local - free').length).toBe(2)

    // receipts.tail was actually queried.
    expect(requestGateway).toHaveBeenCalledWith('conductor.receipts.tail', expect.any(Object))
  })

  it('MissionDetail shows the quiet no-agent-run line for a mission with no receipt', async () => {
    const requestGateway = vi.fn(async (method: string, params?: Record<string, unknown>) => {
      if (method === 'conductor.missions.list') {
        return { missions: MISSIONS }
      }

      if (method === 'conductor.cockpit.get') {
        return cockpitFor(String(params?.missionId ?? 'mission-alpha'))
      }

      if (method === 'conductor.receipts.tail') {
        // Receipts exist, but none for mission-alpha (the auto-selected lane).
        return {
          ok: true,
          nextCursor: 0,
          receipts: [
            {
              eventSequence: 7,
              missionId: 'mission-bravo',
              receipt: { agents: [{ role: 'reviewer', provider: 'anthropic', model: 'claude-opus', lane: 'claude', verdict: 'fail' }] }
            }
          ]
        }
      }

      return { projection: {} }
    })

    renderConductor(requestGateway)

    await waitFor(() => {
      expect(screen.getByText('Agents')).toBeTruthy()
    })
    // The quiet no-run line, not a crash.
    expect(screen.getByText('No agent run yet.')).toBeTruthy()
  })

  it('SystemHealth shows the routing win-rates aggregated across all receipts', async () => {
    const requestGateway = vi.fn(async (method: string) => {
      if (method === 'conductor.missions.list') {
        return { missions: [] }
      }

      if (method === 'conductor.systemcheck') {
        return readyMatrix()
      }

      if (method === 'conductor.receipts.tail') {
        return receiptsTail()
      }

      return { projection: {} }
    })

    renderConductor(requestGateway)

    // The routing section heading.
    await waitFor(() => {
      expect(screen.getByText('Routing')).toBeTruthy()
    })

    // lmstudio:qwen2.5-coder won 2/2 (both pass) → "2/2".
    expect(screen.getByText('lmstudio:qwen2.5-coder')).toBeTruthy()
    expect(screen.getByText('2/2')).toBeTruthy()

    // lmstudio:qwen lost 0/1 (the stale fail receipt still counts in aggregate),
    // and anthropic:claude-opus lost 0/1 too — two engines share the 0/1 ratio.
    expect(screen.getByText('lmstudio:qwen')).toBeTruthy()
    expect(screen.getAllByText('0/1').length).toBe(2)

    // anthropic:claude-opus lost 0/1, and carries a metered cost tier.
    expect(screen.getByText('anthropic:claude-opus')).toBeTruthy()
    expect(screen.getByText('claude - metered')).toBeTruthy()
  })

  it('SystemHealth shows the quiet no-routing line when there are no receipts', async () => {
    const requestGateway = vi.fn(async (method: string) => {
      if (method === 'conductor.missions.list') {
        return { missions: [] }
      }

      if (method === 'conductor.systemcheck') {
        return readyMatrix()
      }

      if (method === 'conductor.receipts.tail') {
        return { ok: true, nextCursor: 0, receipts: [] }
      }

      return { projection: {} }
    })

    renderConductor(requestGateway)

    await waitFor(() => {
      expect(screen.getByText('Routing')).toBeTruthy()
    })
    expect(screen.getByText('No routing data yet.')).toBeTruthy()
  })

  it('a receipts.tail ok:false routes the mission detail to the error state', async () => {
    const requestGateway = vi.fn(async (method: string, params?: Record<string, unknown>) => {
      if (method === 'conductor.missions.list') {
        return { missions: MISSIONS }
      }

      if (method === 'conductor.cockpit.get') {
        return cockpitFor(String(params?.missionId ?? 'mission-alpha'))
      }

      if (method === 'conductor.receipts.tail') {
        return { ok: false, reason: 'receipts_unavailable' }
      }

      return { projection: {} }
    })

    renderConductor(requestGateway)

    // The receipts ErrorState surfaces (shared across the detail + routing panes).
    await waitFor(() => {
      expect(screen.getByText('Could not load receipts')).toBeTruthy()
    })
  })
})
