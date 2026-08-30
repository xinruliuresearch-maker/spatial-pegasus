import { assertSafeLocalEnvironment } from './demo-local'

// local:status runs this validation in a child process because the shared
// startup checker deliberately terminates on invalid production-style config.
// The parent reports only readiness, never captured environment values.
assertSafeLocalEnvironment()
