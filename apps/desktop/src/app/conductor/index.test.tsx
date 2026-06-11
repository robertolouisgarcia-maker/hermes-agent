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
})
