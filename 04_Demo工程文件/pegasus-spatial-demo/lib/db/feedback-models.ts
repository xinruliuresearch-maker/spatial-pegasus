import mongoose, { Schema, Document } from 'mongoose'

export interface FeedbackDocument extends Document {
  feedback_id: string
  user_id: string
  content: string
  page_url: string
  created_at: Date
}

const FeedbackSchema = new Schema<FeedbackDocument>(
  {
    feedback_id: { type: String, required: true, unique: true, index: true },
    user_id: { type: String, required: true, index: true },
    content: { type: String, required: true },
    page_url: { type: String, default: '' },
  },
  {
    // Pin the physical collection name used by the deployment administrator.
    // to `feedback` (singular); without this, Mongoose's default pluralization
    // gives us `feedbacks` and admin's feedback-management page can't see
    // anything users submit through Sci-Pegasus.
    collection: 'feedback',
    timestamps: { createdAt: 'created_at', updatedAt: false },
  },
)

export const Feedback =
  mongoose.models.Feedback ||
  mongoose.model<FeedbackDocument>('Feedback', FeedbackSchema)
