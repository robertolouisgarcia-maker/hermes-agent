import { atom } from 'nanostores'

// The mission lane the cockpit detail pane is bound to. View-only selection
// state: the lane list and the selected mission's cockpit projection are server
// data and live in react-query, not here — this atom only records which lane the
// operator is looking at so the sidebar highlight and the detail query agree.
export const $activeMissionId = atom<null | string>(null)

// Select (or clear) the active mission lane. Idempotent: re-selecting the same
// lane is a no-op so a stray re-click doesn't churn subscribers.
export function setActiveMission(missionId: null | string): void {
  if ($activeMissionId.get() === missionId) {
    return
  }

  $activeMissionId.set(missionId)
}

// Clear the active mission (e.g. when the cockpit overlay closes) so re-opening
// it starts from the auto-selected first lane rather than a stale id.
export function clearActiveMission(): void {
  setActiveMission(null)
}
