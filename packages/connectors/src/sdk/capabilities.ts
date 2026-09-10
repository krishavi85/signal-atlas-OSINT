/**
 * Connector capability registry (§31).
 *
 * A connector NEVER claims an operation it cannot perform. The UI reads these
 * flags to render honest "available / unavailable / needs configuration"
 * states instead of fake buttons.
 */

export const CAPABILITY_KEYS = [
  'SEARCH_SUPPORTED',
  'FETCH_SUPPORTED',
  'MONITORING_SUPPORTED',
  'HISTORICAL_SEARCH_SUPPORTED',
  'PUBLIC_PROFILE_SUPPORTED',
  'POST_SEARCH_SUPPORTED',
  'MEDIA_SUPPORTED',
  'BOOLEAN_QUERY_SUPPORTED',
  'DATE_FILTER_SUPPORTED',
  'LANGUAGE_FILTER_SUPPORTED',
  'RATE_LIMITED',
  'AUTH_REQUIRED',
] as const;

export type CapabilityKey = (typeof CAPABILITY_KEYS)[number];

export type Capabilities = Partial<Record<CapabilityKey, boolean>>;

/** Why a capability that is normally supported is currently unavailable. */
export interface CapabilityGap {
  capability: CapabilityKey | 'ALL';
  /** machine reason */
  code:
    | 'MISSING_API_KEY'
    | 'MISSING_OAUTH'
    | 'REQUIRES_APP_REVIEW'
    | 'NOT_IMPLEMENTED'
    | 'DISABLED_BY_CONFIG'
    | 'PLATFORM_RESTRICTION';
  /** human explanation shown in the UI */
  message: string;
  /** exactly which env var / config unblocks it */
  requiredConfig?: string[];
  /** link to setup docs */
  docs?: string;
}

export interface CapabilityReport {
  connectorId: string;
  displayName: string;
  category: 'web-search' | 'news' | 'social' | 'code' | 'reference' | 'user-input' | 'registry';
  /** what the connector can do WHEN fully configured */
  declared: Capabilities;
  /** what it can do RIGHT NOW given current config */
  effective: Capabilities;
  /** the difference, explained */
  gaps: CapabilityGap[];
}

export function effectiveFromGaps(declared: Capabilities, gaps: CapabilityGap[]): Capabilities {
  const eff: Capabilities = { ...declared };
  for (const gap of gaps) {
    if (gap.capability === 'ALL') {
      for (const k of CAPABILITY_KEYS) eff[k] = false;
    } else {
      eff[gap.capability] = false;
    }
  }
  return eff;
}
