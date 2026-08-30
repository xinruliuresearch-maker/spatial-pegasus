import mongoose, { Schema, Document } from 'mongoose'

export type MemoryType = 'user' | 'project' | 'feedback' | 'reference'

export interface MemoryDocument extends Document {
  memory_id: string
  user_id: string
  name: string
  description: string
  type: MemoryType
  content: string
  tags: string[]
  access_count: number
  last_accessed_at: Date
  created_at: Date
  updated_at: Date
}

const MemorySchema = new Schema<MemoryDocument>(
  {
    memory_id: { type: String, required: true, unique: true, index: true },
    user_id: { type: String, required: true, index: true },
    name: { type: String, required: true },
    description: { type: String, default: '' },
    type: { type: String, enum: ['user', 'project', 'feedback', 'reference'], required: true },
    content: { type: String, default: '' },
    tags: { type: [String], default: [] },
    access_count: { type: Number, default: 0 },
    last_accessed_at: { type: Date, default: Date.now },
  },
  { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' } }
)

// Text index for keyword search across name, description, content, tags
MemorySchema.index(
  { name: 'text', description: 'text', content: 'text', tags: 'text' },
  { weights: { name: 10, tags: 5, description: 3, content: 1 } }
)

export const Memory =
  mongoose.models.Memory ||
  mongoose.model<MemoryDocument>('Memory', MemorySchema)
