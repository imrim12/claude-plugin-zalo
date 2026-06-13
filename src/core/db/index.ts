// Public barrel for the db layer. Consumers import from here ('../core/db/index.ts'); the entity
// files import helpers from './client.ts' directly (never from this barrel — avoids a cycle).
// Note: the internal query helpers (allRows/getRow/run/runReturningId) are deliberately NOT
// re-exported, to keep them off the public surface.
export { db, dbPrune, type InsertMessage, type MessageRow, type OutboundRow } from './client.ts'
export * from './message.ts'
export * from './outbound.ts'
export * from './perm.ts'
export * from './meta.ts'
