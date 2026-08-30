/**
 * Next.js instrumentation hook — runs once per server process at startup.
 *
 * Why split across two files: Next's static analyzer inspects every file
 * that `register()` statically imports. If we referenced `process.on` /
 * `process.exit` here directly, the Edge-runtime bundle would warn about
 * Node APIs even though the runtime guard below never actually reaches them.
 * Dynamic import of instrumentation-node keeps Node APIs off the Edge path.
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return

  const { registerNode } = await import('./instrumentation-node')
  registerNode()
}
