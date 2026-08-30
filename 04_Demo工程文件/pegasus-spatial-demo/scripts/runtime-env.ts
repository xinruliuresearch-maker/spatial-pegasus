import { loadProjectEnv } from './load-project-env'

/** Load the project env exactly as Next.js does and fail closed for operators. */
export function requireRuntimeEnv(name: string): string {
  loadProjectEnv()
  const value = process.env[name]?.trim()
  if (!value) {
    throw new Error(`${name} environment variable is required; refusing to use a fallback database or service`)
  }
  return value
}

export function requireMongoUri(): string {
  return requireRuntimeEnv('MONGODB_URI')
}
