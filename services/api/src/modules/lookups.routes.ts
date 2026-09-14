import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { buildAhmiaSearchLink, buildDorkQueries, buildReverseImageSearchLinks, buildSearchEngineLinks, pimEyesLauncher } from '@osint/core';
import { badRequest } from '../lib/errors.js';
import { assertProjectAccess } from './projects.js';
import { audit } from './audit.js';
import { currentUser } from '../auth/plugin.js';
import { ingestUrlOrExplain } from '../orchestrator/UrlIngest.js';
import { lookupPhoneNumber } from '../orchestrator/PhoneLookup.js';
import { lookupCompany, type RegistryHit } from '../orchestrator/CorporateLookup.js';
import { geocode, reverseGeocode, wigleLookup, openSkyLookup } from '../orchestrator/GeoLookup.js';
import { urlscanSearch, virusTotalLookup, otxLookup } from '../orchestrator/ThreatIntelLookup.js';
import { githubCodeSearch } from '../orchestrator/CodeSearch.js';
import { resolveConnectorConfig } from '../connectors/runtime.js';
import { loadEnv } from '../env.js';

/**
 * Fast, single/few-request OSINT lookups (§31 Phase 11: phone, corporate
 * registries, geospatial, threat intel, dork/reverse-image toolkit). Unlike
 * the identity scan (hundreds of requests, needs a job), every one of these
 * finishes in a handful of seconds, so they're plain synchronous routes —
 * no job queue, no persistence beyond the audit log. Where a result maps to
 * a real page (a registry filing, a threat report), "add to evidence"
 * reuses the same URL-ingest path as everything else in the app.
 */
export async function lookupsRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', app.authenticate);

  app.get('/lookups/status', async () => {
    const env = loadEnv();
    const githubConfig = await resolveConnectorConfig('github');
    return {
      phone: { numverify: Boolean(env.NUMVERIFY_API_KEY) },
      corporate: { openCorporates: Boolean(env.OPENCORPORATES_API_KEY), companiesHouse: Boolean(env.COMPANIES_HOUSE_API_KEY), secEdgar: true, usptoLauncherOnly: true },
      geospatial: { nominatim: true, wigle: Boolean(env.WIGLE_API_NAME && env.WIGLE_API_TOKEN), openSky: true },
      threatIntel: { virusTotal: Boolean(env.VIRUSTOTAL_API_KEY), urlscan: true, otx: Boolean(env.OTX_API_KEY) },
      // GITHUB_TOKEN can come from a plain env var or the encrypted
      // per-connector credential vault (Connectors UI) — check the same way
      // the GitHub connector itself resolves it, not just the env var.
      dorks: { githubCodeSearch: Boolean(githubConfig.GITHUB_TOKEN) },
    };
  });

  // ── Phone ──────────────────────────────────────────────────────────────
  app.post('/projects/:id/lookups/phone', async (req) => {
    const { id } = z.object({ id: z.string() }).parse(req.params);
    await assertProjectAccess(req, id);
    const { number, defaultCountry } = z.object({ number: z.string().min(1).max(32), defaultCountry: z.string().length(2).optional() }).parse(req.body ?? {});
    const u = currentUser(req);
    const result = await lookupPhoneNumber(number, defaultCountry);
    await audit({ projectId: id, actorId: u.id, actorLabel: `user:${u.email}`, action: 'SEARCH_EXECUTED', targetType: 'phone_lookup', summary: `Phone lookup: ${number}` });
    return result;
  });

  // ── Corporate ──────────────────────────────────────────────────────────
  app.post('/projects/:id/lookups/company', async (req) => {
    const { id } = z.object({ id: z.string() }).parse(req.params);
    await assertProjectAccess(req, id);
    const { name } = z.object({ name: z.string().trim().min(1).max(200) }).parse(req.body ?? {});
    const u = currentUser(req);
    const result = await lookupCompany(name);
    await audit({ projectId: id, actorId: u.id, actorLabel: `user:${u.email}`, action: 'SEARCH_EXECUTED', targetType: 'company_lookup', summary: `Corporate registry lookup: ${name}` });
    return result;
  });

  app.post('/projects/:id/lookups/company/add-evidence', async (req) => {
    const { id } = z.object({ id: z.string() }).parse(req.params);
    await assertProjectAccess(req, id, 'EDITOR');
    const hit = z.object({ registry: z.string(), name: z.string(), identifier: z.string().nullable(), jurisdiction: z.string().nullable(), url: z.string().url() }).parse(req.body ?? {}) as RegistryHit;
    const ingested = await ingestUrlOrExplain(id, hit.url);
    return { evidenceId: ingested.evidenceId, reused: ingested.reusedExisting };
  });

  // ── Geospatial ─────────────────────────────────────────────────────────
  app.post('/projects/:id/lookups/geocode', async (req) => {
    const { id } = z.object({ id: z.string() }).parse(req.params);
    await assertProjectAccess(req, id);
    const { query } = z.object({ query: z.string().trim().min(1).max(300) }).parse(req.body ?? {});
    const u = currentUser(req);
    const result = await geocode(query);
    await audit({ projectId: id, actorId: u.id, actorLabel: `user:${u.email}`, action: 'SEARCH_EXECUTED', targetType: 'geocode', summary: `Geocode: ${query}` });
    return result;
  });

  app.post('/projects/:id/lookups/reverse-geocode', async (req) => {
    const { id } = z.object({ id: z.string() }).parse(req.params);
    await assertProjectAccess(req, id);
    const { lat, lon } = z.object({ lat: z.number().min(-90).max(90), lon: z.number().min(-180).max(180) }).parse(req.body ?? {});
    const result = await reverseGeocode(lat, lon);
    return result;
  });

  app.post('/projects/:id/lookups/wigle', async (req) => {
    const { id } = z.object({ id: z.string() }).parse(req.params);
    await assertProjectAccess(req, id);
    const { query } = z.object({ query: z.string().trim().min(1).max(100) }).parse(req.body ?? {});
    const u = currentUser(req);
    const result = await wigleLookup(query);
    await audit({ projectId: id, actorId: u.id, actorLabel: `user:${u.email}`, action: 'SEARCH_EXECUTED', targetType: 'wigle_lookup', summary: `WiGLE WiFi lookup: ${query}` });
    return result;
  });

  app.post('/projects/:id/lookups/flight', async (req) => {
    const { id } = z.object({ id: z.string() }).parse(req.params);
    await assertProjectAccess(req, id);
    const { icao24 } = z.object({ icao24: z.string().trim().min(1).max(10) }).parse(req.body ?? {});
    const u = currentUser(req);
    const result = await openSkyLookup(icao24);
    await audit({ projectId: id, actorId: u.id, actorLabel: `user:${u.email}`, action: 'SEARCH_EXECUTED', targetType: 'flight_lookup', summary: `OpenSky flight lookup: ${icao24}` });
    return result;
  });

  // ── Threat intel ───────────────────────────────────────────────────────
  app.post('/projects/:id/lookups/threat/urlscan', async (req) => {
    const { id } = z.object({ id: z.string() }).parse(req.params);
    await assertProjectAccess(req, id);
    const { query } = z.object({ query: z.string().trim().min(1).max(300) }).parse(req.body ?? {});
    const u = currentUser(req);
    const result = await urlscanSearch(query);
    await audit({ projectId: id, actorId: u.id, actorLabel: `user:${u.email}`, action: 'SEARCH_EXECUTED', targetType: 'urlscan_lookup', summary: `URLScan.io search: ${query}` });
    return result;
  });

  app.post('/projects/:id/lookups/threat/virustotal', async (req) => {
    const { id } = z.object({ id: z.string() }).parse(req.params);
    await assertProjectAccess(req, id);
    const { target, type } = z.object({ target: z.string().trim().min(1).max(300), type: z.enum(['domain', 'ip_address', 'file', 'url']) }).parse(req.body ?? {});
    const u = currentUser(req);
    const result = await virusTotalLookup(target, type);
    await audit({ projectId: id, actorId: u.id, actorLabel: `user:${u.email}`, action: 'SEARCH_EXECUTED', targetType: 'virustotal_lookup', summary: `VirusTotal ${type} lookup: ${target}` });
    return result;
  });

  app.post('/projects/:id/lookups/threat/otx', async (req) => {
    const { id } = z.object({ id: z.string() }).parse(req.params);
    await assertProjectAccess(req, id);
    const { indicator, type } = z.object({ indicator: z.string().trim().min(1).max(300), type: z.enum(['domain', 'IPv4', 'hostname']) }).parse(req.body ?? {});
    const u = currentUser(req);
    const result = await otxLookup(indicator, type);
    await audit({ projectId: id, actorId: u.id, actorLabel: `user:${u.email}`, action: 'SEARCH_EXECUTED', targetType: 'otx_lookup', summary: `OTX ${type} lookup: ${indicator}` });
    return result;
  });

  app.post('/lookups/threat/add-evidence', async (req) => {
    const { projectId, url } = z.object({ projectId: z.string(), url: z.string().url() }).parse(req.body ?? {});
    await assertProjectAccess(req, projectId, 'EDITOR');
    const ingested = await ingestUrlOrExplain(projectId, url);
    return { evidenceId: ingested.evidenceId, reused: ingested.reusedExisting };
  });

  // ── Dork / reverse-image toolkit (pure, no network — §31) ──────────────
  app.post('/lookups/dorks', async (req) => {
    const { targetType, value } = z
      .object({ targetType: z.enum(['domain', 'email', 'phone', 'username', 'generic']), value: z.string().trim().min(1).max(300) })
      .parse(req.body ?? {});
    const queries = buildDorkQueries(targetType, value);
    if (queries.length === 0) throw badRequest('No dork queries could be built for that value.');
    return { queries: queries.map((q) => ({ ...q, links: buildSearchEngineLinks(q.query) })), ahmia: buildAhmiaSearchLink(value) };
  });

  app.post('/lookups/reverse-image', async (req) => {
    const { imageUrl } = z.object({ imageUrl: z.string().url() }).parse(req.body ?? {});
    return { links: buildReverseImageSearchLinks(imageUrl), pimEyes: pimEyesLauncher() };
  });

  // GitHub's own official code-search API — see CodeSearch.ts for why
  // grep.app was evaluated and dropped instead of used here.
  app.post('/projects/:id/lookups/code-search', async (req) => {
    const { id } = z.object({ id: z.string() }).parse(req.params);
    await assertProjectAccess(req, id);
    const { query } = z.object({ query: z.string().trim().min(1).max(300) }).parse(req.body ?? {});
    const u = currentUser(req);
    const result = await githubCodeSearch(query);
    await audit({ projectId: id, actorId: u.id, actorLabel: `user:${u.email}`, action: 'SEARCH_EXECUTED', targetType: 'code_search', summary: `GitHub code search: ${query}` });
    return result;
  });
}
