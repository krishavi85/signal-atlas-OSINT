import type { CapabilityReport } from './capabilities.js';
import type { Connector, ConnectorContext } from './types.js';

/**
 * Connector registry (§3, §33, §41). Connectors register themselves; the
 * orchestrator asks the registry which connectors can serve a given operation
 * *right now* (config-aware).
 */
export class ConnectorRegistry {
  private connectors = new Map<string, Connector>();

  register(connector: Connector): void {
    if (this.connectors.has(connector.id)) {
      throw new Error(`Connector "${connector.id}" already registered`);
    }
    this.connectors.set(connector.id, connector);
  }

  get(id: string): Connector | undefined {
    return this.connectors.get(id);
  }

  all(): Connector[] {
    return [...this.connectors.values()];
  }

  ids(): string[] {
    return [...this.connectors.keys()];
  }

  /** Capability reports for every connector, given the runtime context factory. */
  reports(ctxFor: (id: string) => ConnectorContext | null): CapabilityReport[] {
    return this.all().map((c) => {
      // BaseConnector.capabilities accepts an optional ctx; fall back for plain Connectors.
      const fn = c.capabilities as (ctx?: ConnectorContext | null) => CapabilityReport;
      return fn.call(c, ctxFor(c.id));
    });
  }

  /** Connectors whose EFFECTIVE capabilities include the given key. */
  supporting(
    capability: keyof CapabilityReport['effective'],
    ctxFor: (id: string) => ConnectorContext | null,
  ): Connector[] {
    return this.all().filter((c) => {
      const fn = c.capabilities as (ctx?: ConnectorContext | null) => CapabilityReport;
      return fn.call(c, ctxFor(c.id)).effective[capability] === true;
    });
  }
}
