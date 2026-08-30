import type { UserPlan } from './llm-registry'

/** Fixed capabilities for the account-free, single-machine local deployment. */
export async function getUserPlan(ownerId: string): Promise<UserPlan> {
  void ownerId
  return 'team'
}

export interface UserModelOverrides {
  forced_main_alias?: string
  test_mode: boolean
}

export async function getUserModelOverrides(ownerId: string): Promise<UserModelOverrides> {
  void ownerId
  return { forced_main_alias: undefined, test_mode: false }
}
