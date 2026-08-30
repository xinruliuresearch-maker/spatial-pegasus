import assert from 'node:assert/strict'
import mongoose from 'mongoose'

async function main(): Promise<void> {
  const previousUri = process.env.MONGODB_URI
  const originalConnect = mongoose.connect
  let connectCalls = 0

  process.env.MONGODB_URI = 'mongodb://127.0.0.1:27018/sci_pegasus_connection_retry_test'
  mongoose.connect = (async () => {
    connectCalls += 1
    if (connectCalls === 1) throw new Error('simulated initial connection failure')
    return mongoose
  }) as typeof mongoose.connect

  try {
    const { connectDB } = await import('../mongodb')
    await assert.rejects(connectDB(), /simulated initial connection failure/)
    assert.equal(await connectDB(), mongoose)
    assert.equal(await connectDB(), mongoose)
    assert.equal(connectCalls, 2, 'a rejected cached promise must be retried exactly once')
  } finally {
    mongoose.connect = originalConnect
    if (previousUri === undefined) delete process.env.MONGODB_URI
    else process.env.MONGODB_URI = previousUri
  }

  console.log('✓ MongoDB connection resilience verification passed')
}

void main()
