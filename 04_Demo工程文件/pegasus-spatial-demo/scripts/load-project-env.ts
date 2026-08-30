import { loadEnvConfig } from '@next/env'

/** Match Next.js env loading when an operational script is run via jiti. */
export function loadProjectEnv(): void {
  loadEnvConfig(process.cwd(), process.env.NODE_ENV !== 'production')
}
