import type { SpatialHttpAdapterOptions } from './http-contract'
import { ContractDrivenSpatialHttpAdapter } from './http-contract'
import { createLux3DOfficialG1WireContract } from './official-contracts'

const OFFICIAL_CN_BASE_URL = 'https://api.aholo3d.cn'

export class Lux3DAdapter extends ContractDrivenSpatialHttpAdapter {
  readonly supportedKind = 'object' as const

  constructor(options: Omit<SpatialHttpAdapterOptions, 'provider'> = {}) {
    super({
      baseUrl: OFFICIAL_CN_BASE_URL,
      contract: createLux3DOfficialG1WireContract(),
      authorizationHeader: apiKey => apiKey,
      ...options,
      provider: 'lux3d',
    })
  }
}

export function createLux3DAdapterFromEnv(
  options: Omit<SpatialHttpAdapterOptions, 'provider' | 'baseUrl' | 'token' | 'allowPaidCalls'> = {},
  env: NodeJS.ProcessEnv = process.env,
): Lux3DAdapter {
  return new Lux3DAdapter({
    ...options,
    baseUrl: env.LUX3D_API_BASE_URL || OFFICIAL_CN_BASE_URL,
    token: env.LUX3D_API_KEY || env.LUX3D_API_TOKEN,
    allowPaidCalls: true,
  })
}
