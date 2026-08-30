import mongoose from 'mongoose'
import { requireMongoUri } from './runtime-env'

const MONGODB_URI = requireMongoUri()

const ConvSchema = new mongoose.Schema(
  { conversation_id: String, title: String, updated_at: Date, user_id: String, messages: Array },
  { collection: 'conversations' },
)
const C = mongoose.models.Conversation || mongoose.model('Conversation', ConvSchema)

async function main() {
  await mongoose.connect(MONGODB_URI)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const convs = await C.find({}, { conversation_id: 1, title: 1, updated_at: 1, user_id: 1, messages: 1 }).sort({ updated_at: -1 }).limit(10).lean() as any[]
  for (const c of convs) {
    const msgCount = Array.isArray(c.messages) ? c.messages.length : 0
    console.log(`${c.conversation_id} | msgs=${msgCount} | ${c.title} | ${c.updated_at}`)
  }
  await mongoose.disconnect()
}
main().catch(e => { console.error(e); process.exit(1) })
