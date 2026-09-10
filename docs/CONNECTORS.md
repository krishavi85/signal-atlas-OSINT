# Connectors

A connector is a module implementing the contract in
`packages/connectors/src/sdk/types.ts`:

```ts
interface Connector {
  id: string;
  displayName: string;
  capabilities(ctx?): CapabilityReport;      // §31 — declared vs effective + gaps
  search(params, ctx): Promise<SearchOutcome>;
  fetch(params, ctx): Promise<RawDocument>;
  parse(input, ctx): Promise<unknown>;
  normalize(parsed, { discoveryQuery }, ctx): Promise<NormalizedResult>;
  healthCheck(ctx): Promise<ConnectorHealth>; // §32
  rateLimitStatus(): RateLimitStatus;         // §38
}
```

Extend `BaseConnector` — it supplies the capability-gap machinery, a
token-bucket rate limiter with exponential backoff + jitter, rate-limited
`getJson` / `getText` helpers, and honest default "unsupported" implementations
so a connector only overrides what it truly does.

`ConnectorContext` gives a connector its resolved config (env vars + AES-256-GCM
encrypted DB credentials), a scoped logger, the SSRF-guarded `safeFetch`, and a
shared response cache. Secrets are assembled only in the API process and never
sent to the browser.

Register a new connector in `packages/connectors/src/index.ts` →
`buildDefaultRegistry()`. On next API start it is synced into the `connectors`
table and appears in the UI with its honest capability/health state.

---

## Built-in connectors

### Key-free (work immediately)

| id | Source | Notes |
|----|--------|-------|
| `wikipedia` | MediaWiki Action API + REST summary | language editions via `scope.lang` |
| `hackernews` | Algolia HN Search API | stories + comments, date filters, pagination |
| `rss` | RSS / Atom feeds | **requires `scope.feeds`** (comma-separated feed URLs); does not crawl for feeds |
| `web-generic` | one user-supplied URL | robots-aware, SSRF-guarded, content-hashed; fetch only, no search |

### Key-gated (report `NOT_CONFIGURED` until set — never fabricate results)

| id | Required config | How to obtain |
|----|-----------------|---------------|
| `brave-search` | `BRAVE_SEARCH_API_KEY` | https://brave.com/search/api/ (free tier ~2k/mo) |
| `searxng` | `SEARXNG_BASE_URL` | run a SearXNG instance with `search.formats: [json]` enabled |
| `google-cse` | `GOOGLE_CSE_API_KEY`, `GOOGLE_CSE_CX` | Programmable Search Engine + Cloud API key (100 q/day free) |
| `github` | *(none required)* — `GITHUB_TOKEN` optional | PAT raises limit 60→5000 req/h |
| `youtube` | `YOUTUBE_DATA_API_KEY` | Google Cloud → YouTube Data API v3 (10k units/day) |
| `reddit` | `REDDIT_CLIENT_ID`, `REDDIT_CLIENT_SECRET` | reddit.com/prefs/apps → "script" app |
| `facebook-graph` | `META_GRAPH_ACCESS_TOKEN` (+ app id/secret) | Meta app + **App Review** for `pages_read_*`; only Pages the token can read; **no cross-Facebook search exists for third parties** |
| `instagram-graph` | `INSTAGRAM_GRAPH_ACCESS_TOKEN`, `INSTAGRAM_BUSINESS_USER_ID` | IG Business/Creator + connected FB Page + App Review for `instagram_basic`; exposes `business_discovery` (public profile + recent media of a business account **by username**) |

### Setting credentials

- **Environment**: put keys in `.env` (see `.env.example`). Applies to all projects.
- **Runtime (admin)**: `PUT /api/v1/connectors/:id/credentials` with a JSON object
  of key→value. Values are encrypted with `CREDENTIAL_ENC_KEY` and override env.
  `DELETE` the same path to clear them.

After setting credentials the API immediately re-runs that connector's
`healthCheck()` and the Connectors page reflects the new state.

---

## What connectors will never do (§30)

- Scrape authenticated or access-controlled pages
- Bypass logins, privacy settings, rate limits, CAPTCHAs, or anti-bot systems
- Access private messages or non-public account data
- Solve CAPTCHAs or emulate human interaction to evade detection

If a platform does not offer a lawful API for something, the connector reports a
`PLATFORM_RESTRICTION` gap and the capability stays off.
