import type { SpatialBuildStatus } from './types'

const TRANSITIONS: Readonly<Record<SpatialBuildStatus, readonly SpatialBuildStatus[]>> = {
  prepared: ['submitting', 'cancelled'],
  submitting: ['submitted', 'failed', 'unknown'],
  submitted: ['running', 'materializing', 'failed', 'cancelled'],
  running: ['running', 'materializing', 'failed', 'cancelled'],
  materializing: ['published', 'failed', 'cancelled'],
  published: [],
  failed: [],
  unknown: [],
  cancelled: [],
}

export class InvalidSpatialStatusTransitionError extends Error {
  readonly code = 'INVALID_SPATIAL_STATUS_TRANSITION'

  constructor(from: SpatialBuildStatus, to: SpatialBuildStatus) {
    super(`Invalid SpatialBuildJob transition: ${from} -> ${to}`)
    this.name = 'InvalidSpatialStatusTransitionError'
  }
}

export function canTransitionSpatialStatus(
  from: SpatialBuildStatus,
  to: SpatialBuildStatus,
): boolean {
  return TRANSITIONS[from].includes(to)
}

export function assertSpatialStatusTransition(
  from: SpatialBuildStatus,
  to: SpatialBuildStatus,
): void {
  if (!canTransitionSpatialStatus(from, to)) {
    throw new InvalidSpatialStatusTransitionError(from, to)
  }
}

export function allowedSpatialTransitionSources(
  to: SpatialBuildStatus,
): SpatialBuildStatus[] {
  return (Object.keys(TRANSITIONS) as SpatialBuildStatus[])
    .filter(from => canTransitionSpatialStatus(from, to))
}
