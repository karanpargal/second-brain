export { config, ensureDataDir, ensureMasterKey, normalizeOllamaKeepAlive } from "./config.js";
export {
  ensureApiToken,
  readApiToken,
  apiTokenPath,
  extractBearerToken,
  extractCookieToken,
  apiTokenCookieHeader,
  isValidApiToken,
  corsOriginFor,
  ALLOWED_ORIGINS,
  API_TOKEN_COOKIE,
} from "./api-token.js";
export {
  encrypt,
  decrypt,
  loadSecrets,
  saveSecrets,
  getSecret,
  setSecret,
  deleteSecret,
  sha256,
  contentHash,
} from "./crypto.js";
export { log } from "./log.js";
export {
  getDb,
  getSqlite,
  createDb,
  closeDb,
  backupDb,
  ensureEmbeddingTables,
  isVecReady,
  schema,
} from "./db/client.js";
export * from "./db/schema.js";
export { migrate } from "./db/migrate.js";
export { seed } from "./db/seed.js";
export { runJob, withBackoff, newId, type JobResult } from "./jobs.js";
export { exportCaptureRulesFile } from "./capture-rules-export.js";
export {
  classifySpam,
  isSpam,
  isSpamText,
  type SpamInput,
  type SpamVerdict,
} from "./spam.js";
export {
  matchUserSpamRule,
  matchUserRule,
  isBlockedByUserRules,
  markLoopAsSpam,
  markLoopNotTracking,
  listUserSpamRules,
  listUserTrackingRules,
  deleteUserSpamRule,
  deleteUserTrackingRule,
  addUserSpamRule,
  addUserTrackingRule,
  invalidateUserSpamCache,
  invalidateUserRulesCache,
  formatUserRulesForPrompt,
  type UserSpamRule,
  type UserTrackingRule,
  type UserSpamMatchType,
  type UserRuleMatchType,
  type UserRuleIntent,
  type UserRuleHit,
} from "./user-spam.js";
export {
  recordLearnClassify,
  recordLearnReward,
  linkLearnCard,
  learnGraphFewShot,
  looksLikeMarket,
  type ChatAudience,
  type ChatTopic,
  type LearnClassifyInput,
} from "./learn-graph.js";
