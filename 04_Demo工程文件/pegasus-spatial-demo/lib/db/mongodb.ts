import mongoose from 'mongoose'

// NOTE: do NOT throw at module load — `next build` imports this module while
// collecting API route metadata, and env vars are intentionally not baked into
// Docker images. Defer the check to the first `connectDB()` call instead.
const cached: { conn: typeof mongoose | null; promise: Promise<typeof mongoose> | null } = {
  conn: null,
  promise: null,
}

export async function connectDB(): Promise<typeof mongoose> {
  if (cached.conn) return cached.conn

  const MONGODB_URI = process.env.MONGODB_URI
  if (!MONGODB_URI) {
    // Fail loud at first use rather than silently falling back to localhost —
    // in a container the fallback URL would be wrong anyway, and the cryptic
    // connection-refused error downstream is worse than an explicit config error.
    throw new Error('MONGODB_URI environment variable is required')
  }

  if (!cached.promise) {
    // Redact credentials in the startup log.
    const safeUri = MONGODB_URI.replace(/\/\/([^:]+):([^@]+)@/, '//$1:***@')
    console.log('[mongodb] Connecting to:', safeUri)
    cached.promise = mongoose.connect(MONGODB_URI, {
      // Pool sized for single-instance ~50-user internal test. When we horizontally
      // scale, revisit: each app replica opens its own pool, so total connections
      // to MongoDB = replicas × maxPoolSize. Cap replicas × 20 ≤ mongo's connection limit.
      maxPoolSize: 20,
      minPoolSize: 2,
      // Longer than Mongoose defaults so docker-compose ordering (mongo starts slower
      // than app) doesn't crash the app on first boot. 15s is generous but harmless.
      serverSelectionTimeoutMS: 15000,
      connectTimeoutMS: 15000,
      // Per-socket inactivity timeout. 45s covers our longest realistic DB operation
      // (GridFS upload of a 5MB image); shorter risks cutting off slow writes.
      socketTimeoutMS: 45000,
    })
  }

  const pending = cached.promise
  try {
    cached.conn = await pending
    return cached.conn
  } catch (error) {
    // A rejected connection promise must not become a permanent process-wide
    // failure. This is common when the app starts while Docker/MongoDB is still
    // waking up, and the next caller should be allowed to establish a new one.
    if (cached.promise === pending) {
      cached.promise = null
      cached.conn = null
    }
    throw error
  }
}
