export { embedText, embedBatch, cosine, lastEmbedMeta } from "./embeddings.js";
export {
  runEnrichPipeline,
  scoreItem,
  scorePending,
  embedUnembeddedItems,
  embedPendingChunks,
  retrieveMemory,
  recordFeedback,
  type RetrievalHit,
} from "./scoring.js";
