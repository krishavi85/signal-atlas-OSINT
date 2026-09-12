# Legal & privacy safeguards (§30)

This platform is for **legitimate research using lawfully accessible public
information**. The following are design constraints, enforced in code, not just
policy statements.

## The platform does NOT

- scrape or automate authenticated / access-controlled surfaces
- bypass logins, privacy settings, paywalls, API restrictions, or platform ToS
- circumvent CAPTCHAs, rate limits, or anti-bot / bot-detection systems
- access private messages or non-public account data
- perform covert biometric identification or automated face matching to assert
  that two people are the same individual (there is **no face-detection or
  facial-similarity code anywhere in the codebase**; the media pipeline extracts
  metadata, EXIF/GPS, and perceptual **image** hashes only, and the vision-model
  prompt explicitly forbids identifying, naming, or profiling people — §19).
  Reverse image search (Google Cloud Vision's Web Detection feature) is
  content/perceptual matching against Google's public image index — "has this
  picture appeared elsewhere" — not identity search; Vision API's separate
  face-detection feature is never requested, and the result never asserts who
  is in an image. Services that perform identity-based face search across the
  web (e.g. FaceCheck.id) or aggregate phone/email-to-person lookups are
  explicitly out of scope for this platform, by policy, regardless of the
  provider's own terms
- track precise private real-time location
- ingest illegally obtained or leaked personal databases
- exploit platform vulnerabilities

Connectors that cannot perform an operation lawfully report a
`PLATFORM_RESTRICTION` gap and the capability stays disabled — the UI shows this
honestly rather than presenting a non-functional button (§31, §51).

## Technical guardrails

| Safeguard | Where |
|-----------|-------|
| SSRF protection (scheme allowlist, private/loopback/link-local/metadata IP blocks, DNS-rebind re-check, redirect re-validation) | `services/api/src/lib/safeFetch.ts`, `packages/core/src/ssrf.ts` |
| robots.txt honoured for direct page retrieval | `web-generic` connector |
| Polite rate limiting (token bucket + backoff + jitter), never used to defeat a provider limit | `packages/connectors/src/sdk/rate-limit.ts` |
| Connector credentials encrypted at rest (AES-256-GCM); never sent to the browser | `services/api/src/lib/crypto.ts` |
| No personal data in URLs/query strings; privacy-preserving defaults | app conventions |
| Full audit log of every search, connector call, evidence change, entity merge, AI run | `audit_logs` table (§29) |

## Data retention & deletion (§30)

- Each project may set `retentionDays`. A retention job (Phase 9) prunes evidence
  and derived records older than the window; the audit log retains the ids.
- Evidence can be deleted individually; the deletion is audit-logged with the id
  and content hash so provenance of the removal is preserved.
- "Public" does not mean "unrestricted reuse" — respect copyright and platform
  terms when exporting or republishing.

## Not legal advice

Operators are responsible for compliance with the laws and platform terms
applicable to their jurisdiction and use case (GDPR/UK-GDPR, CCPA, ECHR privacy
rights, DMCA, platform developer agreements, etc.).
