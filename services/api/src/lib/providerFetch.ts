/**
 * Fetch wrapper for AI-provider API calls (chat/embeddings/transcription).
 *
 * Deliberately NOT SSRF-guarded like `safeFetch` — these targets are either a
 * hardcoded public API host (api.anthropic.com, api.openai.com) or the
 * operator's own OLLAMA_BASE_URL, set via server-side config, not derived
 * from user/attacker input. The SSRF guard's whole purpose is to stop the
 * server being tricked into fetching an attacker-influenced URL (a search
 * result, a media asset link); it does not apply to config the operator
 * chose themselves — and blocking it here was a real bug, since running
 * Ollama on localhost is the standard, expected setup.
 */
export interface ProviderFetchInit extends RequestInit {
  timeoutMs?: number;
}

export async function providerFetch(url: string, init: ProviderFetchInit = {}): Promise<Response> {
  const { timeoutMs = 30_000, ...rest } = init;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const upstreamSignal = init.signal;
  if (upstreamSignal) upstreamSignal.addEventListener('abort', () => controller.abort(), { once: true });
  try {
    return await fetch(url, { ...rest, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}
