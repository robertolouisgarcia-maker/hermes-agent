import { afterEach, describe, expect, it } from 'vitest'

import { $activeMissionId, clearActiveMission, setActiveMission } from './conductor'

afterEach(() => {
  $activeMissionId.set(null)
})

describe('conductor store', () => {
  it('starts with no active mission', () => {
    expect($activeMissionId.get()).toBeNull()
  })

  it('setActiveMission selects a lane', () => {
    setActiveMission('mission-a')

    expect($activeMissionId.get()).toBe('mission-a')
  })

  it('setActiveMission switches between lanes', () => {
    setActiveMission('mission-a')
    setActiveMission('mission-b')

    expect($activeMissionId.get()).toBe('mission-b')
  })

  it('re-selecting the same lane does not notify subscribers', () => {
    setActiveMission('mission-a')

    let notifications = 0

    const unsubscribe = $activeMissionId.subscribe(() => {
      notifications += 1
    })

    // nanostores fires once immediately on subscribe.
    notifications = 0

    setActiveMission('mission-a')

    expect(notifications).toBe(0)

    unsubscribe()
  })

  it('clearActiveMission resets the selection', () => {
    setActiveMission('mission-a')
    clearActiveMission()

    expect($activeMissionId.get()).toBeNull()
  })
})
