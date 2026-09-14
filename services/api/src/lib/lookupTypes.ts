/**
 * Shared result shape for optional-key lookup modules (§31 Phase 11):
 * either real data, or a named reason it isn't available right now (missing
 * key, upstream error, rate-limited) — never a silently empty/fake result.
 */
export type LookupAvailability<T> = { available: true; data: T } | { available: false; reason: string };
