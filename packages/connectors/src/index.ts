export * from './sdk/index.js';
export * from './lib/markup.js';

export { WikipediaConnector } from './connectors/wikipedia.js';
export { HackerNewsConnector } from './connectors/hackernews.js';
export { RssConnector } from './connectors/rss.js';
export { GenericWebConnector } from './connectors/generic-web.js';
export { WaybackConnector } from './connectors/wayback.js';
export { BraveSearchConnector } from './connectors/brave.js';
export { SearxngConnector } from './connectors/searxng.js';
export { GoogleCseConnector } from './connectors/google-cse.js';
export { GitHubConnector } from './connectors/github.js';
export { YouTubeConnector } from './connectors/youtube.js';
export { RedditConnector } from './connectors/reddit.js';
export { MetaGraphConnector } from './connectors/meta.js';
export { InstagramGraphConnector } from './connectors/instagram.js';

import { ConnectorRegistry } from './sdk/registry.js';
import { WikipediaConnector } from './connectors/wikipedia.js';
import { HackerNewsConnector } from './connectors/hackernews.js';
import { RssConnector } from './connectors/rss.js';
import { GenericWebConnector } from './connectors/generic-web.js';
import { WaybackConnector } from './connectors/wayback.js';
import { BraveSearchConnector } from './connectors/brave.js';
import { SearxngConnector } from './connectors/searxng.js';
import { GoogleCseConnector } from './connectors/google-cse.js';
import { GitHubConnector } from './connectors/github.js';
import { YouTubeConnector } from './connectors/youtube.js';
import { RedditConnector } from './connectors/reddit.js';
import { MetaGraphConnector } from './connectors/meta.js';
import { InstagramGraphConnector } from './connectors/instagram.js';

/**
 * Build a registry with every built-in connector. The API service calls this
 * at startup, then wraps each with a runtime ConnectorContext (config, logger,
 * safeFetch, cache).
 */
export function buildDefaultRegistry(): ConnectorRegistry {
  const registry = new ConnectorRegistry();
  for (const c of [
    new WikipediaConnector(),
    new HackerNewsConnector(),
    new RssConnector(),
    new GenericWebConnector(),
    new WaybackConnector(),
    new BraveSearchConnector(),
    new SearxngConnector(),
    new GoogleCseConnector(),
    new GitHubConnector(),
    new YouTubeConnector(),
    new RedditConnector(),
    new MetaGraphConnector(),
    new InstagramGraphConnector(),
  ]) {
    registry.register(c);
  }
  return registry;
}
