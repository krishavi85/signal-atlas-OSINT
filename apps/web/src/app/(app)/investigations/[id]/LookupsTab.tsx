'use client';

import { useState } from 'react';
import { api, ApiRequestError } from '@/lib/api';
import { useApi } from '@/lib/useApi';
import { Badge, Spinner } from '@/components/ui';

interface LookupsStatus {
  phone: { numverify: boolean };
  corporate: { openCorporates: boolean; companiesHouse: boolean; secEdgar: boolean; usptoLauncherOnly: boolean };
  geospatial: { nominatim: boolean; wigle: boolean; openSky: boolean };
  threatIntel: { virusTotal: boolean; urlscan: boolean; otx: boolean };
  dorks: { githubCodeSearch: boolean };
}

type Availability<T> = { available: true; data: T } | { available: false; reason: string };

interface SearchLink {
  engine: string;
  url: string;
}

const SECTIONS = ['Phone', 'Corporate', 'Geospatial', 'Threat Intel', 'Dorks'] as const;
type Section = (typeof SECTIONS)[number];

export function LookupsTab({ projectId, canEdit }: { projectId: string; canEdit: boolean }) {
  const [section, setSection] = useState<Section>('Phone');
  const status = useApi<LookupsStatus>('/lookups/status');

  return (
    <div className="space-y-4">
      <div className="scrollbar-none flex gap-1 overflow-x-auto rounded-lg border border-ink-800 bg-ink-900 p-1">
        {SECTIONS.map((s) => (
          <button
            key={s}
            onClick={() => setSection(s)}
            className={`shrink-0 rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${
              section === s ? 'bg-ink-750 text-slate-100' : 'text-slate-500 hover:text-slate-300'
            }`}
          >
            {s}
          </button>
        ))}
      </div>

      {status.loading ? (
        <Spinner />
      ) : (
        <>
          {section === 'Phone' && <PhoneSection projectId={projectId} numverify={status.data?.phone.numverify ?? false} />}
          {section === 'Corporate' && <CorporateSection projectId={projectId} canEdit={canEdit} />}
          {section === 'Geospatial' && <GeoSection projectId={projectId} status={status.data?.geospatial} />}
          {section === 'Threat Intel' && <ThreatIntelSection projectId={projectId} canEdit={canEdit} status={status.data?.threatIntel} />}
          {section === 'Dorks' && <DorksSection projectId={projectId} status={status.data?.dorks} />}
        </>
      )}
    </div>
  );
}

function LinkList({ links }: { links: SearchLink[] }) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {links.map((l) => (
        <a key={l.engine} href={l.url} target="_blank" rel="noreferrer" className="btn-ghost px-2 py-0.5 text-[11px]">
          {l.engine}
        </a>
      ))}
    </div>
  );
}

function GapNotice({ reason }: { reason: string }) {
  return <p className="text-xs text-amber-400">{reason}</p>;
}

function errorMessage(e: unknown): string {
  if (e instanceof ApiRequestError) return e.body.error?.message ?? e.message;
  return e instanceof Error ? e.message : 'Request failed';
}

// ── Phone ────────────────────────────────────────────────────────────────

interface PhoneResult {
  input: string;
  valid: boolean;
  possible: boolean;
  e164: string | null;
  international: string | null;
  national: string | null;
  country: string | null;
  countryCallingCode: string | null;
  declaredType: string | null;
  carrierLookup: { available: true; carrier: string | null; lineType: string | null; location: string | null } | { available: false; reason: string };
  dorkQueries: Array<{ label: string; query: string; links: SearchLink[] }>;
}

function PhoneSection({ projectId, numverify }: { projectId: string; numverify: boolean }) {
  const [number, setNumber] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<PhoneResult | null>(null);
  const [err, setErr] = useState<string | null>(null);

  async function run() {
    if (!number.trim()) return;
    setBusy(true);
    setErr(null);
    try {
      setResult(await api<PhoneResult>(`/projects/${projectId}/lookups/phone`, { method: 'POST', body: JSON.stringify({ number: number.trim() }) }));
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Lookup failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-3">
      <div className="card p-4">
        <h3 className="text-sm font-semibold text-slate-200">Phone OSINT</h3>
        <p className="mt-1 text-xs text-slate-500">
          Offline parsing/validation/type via libphonenumber.
          {!numverify && ' Set NUMVERIFY_API_KEY for a live carrier/line-type/location lookup.'}
        </p>
        <div className="mt-3 flex gap-2">
          <input className="input" placeholder="+14155552671" value={number} onChange={(e) => setNumber(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && run()} />
          <button className="btn-primary" onClick={run} disabled={busy || !number.trim()}>
            {busy ? 'Looking up…' : 'Lookup'}
          </button>
        </div>
        {err && <p className="mt-2 text-xs text-red-400">{err}</p>}
      </div>

      {result && (
        <div className="card space-y-3 p-4 text-sm">
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone={result.valid ? 'green' : result.possible ? 'amber' : 'red'}>{result.valid ? 'valid' : result.possible ? 'possible' : 'invalid'}</Badge>
            {result.country && <span className="text-slate-300">{result.country}</span>}
            {result.declaredType && <Badge tone="blue">{result.declaredType}</Badge>}
          </div>
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
            <dt className="text-slate-600">E.164</dt>
            <dd className="font-mono text-slate-300">{result.e164 ?? '—'}</dd>
            <dt className="text-slate-600">International</dt>
            <dd className="text-slate-300">{result.international ?? '—'}</dd>
            <dt className="text-slate-600">National</dt>
            <dd className="text-slate-300">{result.national ?? '—'}</dd>
          </dl>
          <div className="border-t border-ink-800 pt-2 text-xs">
            <p className="mb-1 font-semibold text-slate-400">Carrier / line type / location</p>
            {result.carrierLookup.available ? (
              <p className="text-slate-300">
                {result.carrierLookup.carrier ?? 'unknown carrier'} · {result.carrierLookup.lineType ?? 'unknown type'} · {result.carrierLookup.location ?? 'unknown location'}
              </p>
            ) : (
              <GapNotice reason={result.carrierLookup.reason} />
            )}
          </div>
          {result.dorkQueries.map((q) => (
            <div key={q.label} className="border-t border-ink-800 pt-2">
              <p className="mb-1 text-xs font-semibold text-slate-400">{q.label}</p>
              <LinkList links={q.links} />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Corporate ────────────────────────────────────────────────────────────

interface RegistryHit {
  registry: string;
  name: string;
  identifier: string | null;
  jurisdiction: string | null;
  url: string;
}

interface CorporateResult {
  query: string;
  secEdgar: { available: true; companies: RegistryHit[]; mentions: RegistryHit[] } | { available: false; reason: string };
  openCorporates: { available: true; hits: RegistryHit[] } | { available: false; reason: string };
  companiesHouse: { available: true; hits: RegistryHit[] } | { available: false; reason: string };
  usptoSearchUrl: string;
}

function RegistryHitRow({ hit, projectId, canEdit }: { hit: RegistryHit; projectId: string; canEdit: boolean }) {
  const [added, setAdded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  async function add() {
    setBusy(true);
    setErr(null);
    try {
      await api(`/projects/${projectId}/lookups/company/add-evidence`, { method: 'POST', body: JSON.stringify(hit) });
      setAdded(true);
    } catch (e) {
      setErr(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <li className="rounded border border-ink-800 px-2 py-1.5 text-xs">
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone="blue">{hit.registry}</Badge>
        <span className="font-medium text-slate-200">{hit.name}</span>
        {hit.identifier && <span className="text-slate-600">{hit.identifier}</span>}
        <a href={hit.url} target="_blank" rel="noreferrer" className="ml-auto truncate text-accent hover:underline">
          {hit.url}
        </a>
        {canEdit && (
          <button className="btn-ghost shrink-0 px-2 py-0.5" onClick={add} disabled={busy || added}>
            {added ? 'in evidence' : busy ? 'adding…' : 'add to evidence'}
          </button>
        )}
      </div>
      {err && <p className="mt-1 text-[11px] text-red-400">{err}</p>}
    </li>
  );
}

function CorporateSection({ projectId, canEdit }: { projectId: string; canEdit: boolean }) {
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<CorporateResult | null>(null);
  const [err, setErr] = useState<string | null>(null);

  async function run() {
    if (!name.trim()) return;
    setBusy(true);
    setErr(null);
    try {
      setResult(await api<CorporateResult>(`/projects/${projectId}/lookups/company`, { method: 'POST', body: JSON.stringify({ name: name.trim() }) }));
    } catch (e) {
      setErr(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-3">
      <div className="card p-4">
        <h3 className="text-sm font-semibold text-slate-200">Corporate / registry OSINT</h3>
        <p className="mt-1 text-xs text-slate-500">SEC EDGAR is always live (US public registrants). OpenCorporates/Companies House need a free key.</p>
        <div className="mt-3 flex gap-2">
          <input className="input" placeholder="company name" value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && run()} />
          <button className="btn-primary" onClick={run} disabled={busy || !name.trim()}>
            {busy ? 'Searching…' : 'Search'}
          </button>
        </div>
        {err && <p className="mt-2 text-xs text-red-400">{err}</p>}
      </div>

      {result && (
        <>
          <div className="card p-4">
            <p className="mb-2 text-xs font-semibold text-slate-300">SEC EDGAR</p>
            {result.secEdgar.available ? (
              <div className="space-y-2">
                {result.secEdgar.companies.length > 0 ? (
                  <ul className="space-y-1.5">
                    {result.secEdgar.companies.map((h) => (
                      <RegistryHitRow key={h.url} hit={h} projectId={projectId} canEdit={canEdit} />
                    ))}
                  </ul>
                ) : (
                  <p className="text-xs text-slate-600">No exact registrant match.</p>
                )}
                {result.secEdgar.mentions.length > 0 && (
                  <details className="text-xs">
                    <summary className="cursor-pointer text-slate-500">Mentioned in {result.secEdgar.mentions.length} other filing(s) — not a company match, just full-text hits</summary>
                    <ul className="mt-1.5 space-y-1.5">
                      {result.secEdgar.mentions.map((h) => (
                        <RegistryHitRow key={h.url} hit={h} projectId={projectId} canEdit={canEdit} />
                      ))}
                    </ul>
                  </details>
                )}
              </div>
            ) : (
              <GapNotice reason={result.secEdgar.reason} />
            )}
          </div>

          <div className="card p-4">
            <p className="mb-2 text-xs font-semibold text-slate-300">OpenCorporates</p>
            {result.openCorporates.available ? (
              <ul className="space-y-1.5">
                {result.openCorporates.hits.map((h) => (
                  <RegistryHitRow key={h.url} hit={h} projectId={projectId} canEdit={canEdit} />
                ))}
              </ul>
            ) : (
              <GapNotice reason={result.openCorporates.reason} />
            )}
          </div>

          <div className="card p-4">
            <p className="mb-2 text-xs font-semibold text-slate-300">Companies House (UK)</p>
            {result.companiesHouse.available ? (
              <ul className="space-y-1.5">
                {result.companiesHouse.hits.map((h) => (
                  <RegistryHitRow key={h.url} hit={h} projectId={projectId} canEdit={canEdit} />
                ))}
              </ul>
            ) : (
              <GapNotice reason={result.companiesHouse.reason} />
            )}
          </div>

          <div className="card p-4">
            <p className="mb-2 text-xs font-semibold text-slate-300">USPTO trademark search</p>
            <p className="mb-2 text-xs text-slate-500">No documented API for name search was confirmed — opens USPTO&apos;s own search tool instead of guessing at one.</p>
            <a href={result.usptoSearchUrl} target="_blank" rel="noreferrer" className="btn-ghost px-2 py-1 text-xs">
              Open USPTO trademark search ↗
            </a>
          </div>
        </>
      )}
    </div>
  );
}

// ── Geospatial ───────────────────────────────────────────────────────────

interface GeocodeHit {
  displayName: string;
  lat: number;
  lon: number;
  type: string | null;
  osmUrl: string;
}
interface WifiHit {
  ssid: string | null;
  netid: string;
  lat: number;
  lon: number;
  lastUpdate: string | null;
}
interface FlightState {
  icao24: string;
  callsign: string | null;
  originCountry: string;
  lat: number | null;
  lon: number | null;
  altitudeM: number | null;
  velocityMs: number | null;
  onGround: boolean;
}

function GeoSection({ projectId, status }: { projectId: string; status?: LookupsStatus['geospatial'] }) {
  const [place, setPlace] = useState('');
  const [geoBusy, setGeoBusy] = useState(false);
  const [geoResult, setGeoResult] = useState<Availability<GeocodeHit[]> | null>(null);

  const [wifi, setWifi] = useState('');
  const [wifiBusy, setWifiBusy] = useState(false);
  const [wifiResult, setWifiResult] = useState<Availability<WifiHit[]> | null>(null);

  const [icao, setIcao] = useState('');
  const [flightBusy, setFlightBusy] = useState(false);
  const [flightResult, setFlightResult] = useState<Availability<FlightState | null> | null>(null);

  async function runGeocode() {
    if (!place.trim()) return;
    setGeoBusy(true);
    try {
      setGeoResult(await api(`/projects/${projectId}/lookups/geocode`, { method: 'POST', body: JSON.stringify({ query: place.trim() }) }));
    } catch (e) {
      setGeoResult({ available: false, reason: errorMessage(e) });
    } finally {
      setGeoBusy(false);
    }
  }
  async function runWifi() {
    if (!wifi.trim()) return;
    setWifiBusy(true);
    try {
      setWifiResult(await api(`/projects/${projectId}/lookups/wigle`, { method: 'POST', body: JSON.stringify({ query: wifi.trim() }) }));
    } catch (e) {
      setWifiResult({ available: false, reason: errorMessage(e) });
    } finally {
      setWifiBusy(false);
    }
  }
  async function runFlight() {
    if (!icao.trim()) return;
    setFlightBusy(true);
    try {
      setFlightResult(await api(`/projects/${projectId}/lookups/flight`, { method: 'POST', body: JSON.stringify({ icao24: icao.trim() }) }));
    } catch (e) {
      setFlightResult({ available: false, reason: errorMessage(e) });
    } finally {
      setFlightBusy(false);
    }
  }

  return (
    <div className="space-y-3">
      <div className="card p-4">
        <h3 className="text-sm font-semibold text-slate-200">Geocode (Nominatim / OpenStreetMap)</h3>
        <div className="mt-3 flex gap-2">
          <input className="input" placeholder="address or place name" value={place} onChange={(e) => setPlace(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && runGeocode()} />
          <button className="btn-primary" onClick={runGeocode} disabled={geoBusy || !place.trim()}>
            {geoBusy ? 'Searching…' : 'Geocode'}
          </button>
        </div>
        {geoResult &&
          (geoResult.available ? (
            <ul className="mt-3 space-y-1.5 text-xs">
              {geoResult.data.map((r) => (
                <li key={r.osmUrl} className="rounded border border-ink-800 p-2">
                  <a href={r.osmUrl} target="_blank" rel="noreferrer" className="text-accent hover:underline">
                    {r.displayName}
                  </a>
                  <p className="mt-0.5 text-slate-600">
                    {r.lat.toFixed(5)}, {r.lon.toFixed(5)} {r.type && `· ${r.type}`}
                  </p>
                </li>
              ))}
              {geoResult.data.length === 0 && <p className="text-slate-600">No results.</p>}
            </ul>
          ) : (
            <div className="mt-2">
              <GapNotice reason={geoResult.reason} />
            </div>
          ))}
      </div>

      <div className="card p-4">
        <h3 className="text-sm font-semibold text-slate-200">WiGLE WiFi lookup</h3>
        {!status?.wigle && <p className="mt-1 text-xs text-amber-400">Set WIGLE_API_NAME/WIGLE_API_TOKEN (free account) to enable.</p>}
        <div className="mt-3 flex gap-2">
          <input className="input" placeholder="SSID or BSSID (aa:bb:cc:dd:ee:ff)" value={wifi} onChange={(e) => setWifi(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && runWifi()} />
          <button className="btn-primary" onClick={runWifi} disabled={wifiBusy || !wifi.trim()}>
            {wifiBusy ? 'Searching…' : 'Search'}
          </button>
        </div>
        {wifiResult &&
          (wifiResult.available ? (
            <ul className="mt-3 space-y-1 text-xs">
              {wifiResult.data.map((w) => (
                <li key={w.netid} className="rounded border border-ink-800 p-2 text-slate-300">
                  {w.ssid ?? '(hidden SSID)'} · {w.netid} · {w.lat.toFixed(5)}, {w.lon.toFixed(5)}
                </li>
              ))}
              {wifiResult.data.length === 0 && <p className="text-slate-600">No results.</p>}
            </ul>
          ) : (
            <div className="mt-2">
              <GapNotice reason={wifiResult.reason} />
            </div>
          ))}
      </div>

      <div className="card p-4">
        <h3 className="text-sm font-semibold text-slate-200">Flight lookup (OpenSky)</h3>
        <div className="mt-3 flex gap-2">
          <input className="input" placeholder="ICAO24 hex (e.g. 4b1806)" value={icao} onChange={(e) => setIcao(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && runFlight()} />
          <button className="btn-primary" onClick={runFlight} disabled={flightBusy || !icao.trim()}>
            {flightBusy ? 'Looking up…' : 'Lookup'}
          </button>
        </div>
        {flightResult &&
          (flightResult.available ? (
            flightResult.data ? (
              <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
                <dt className="text-slate-600">Callsign</dt>
                <dd className="text-slate-300">{flightResult.data.callsign ?? '—'}</dd>
                <dt className="text-slate-600">Origin country</dt>
                <dd className="text-slate-300">{flightResult.data.originCountry}</dd>
                <dt className="text-slate-600">Position</dt>
                <dd className="text-slate-300">{flightResult.data.lat != null ? `${flightResult.data.lat.toFixed(4)}, ${flightResult.data.lon?.toFixed(4)}` : 'unknown'}</dd>
                <dt className="text-slate-600">Altitude</dt>
                <dd className="text-slate-300">{flightResult.data.altitudeM != null ? `${Math.round(flightResult.data.altitudeM)} m` : '—'}</dd>
                <dt className="text-slate-600">On ground</dt>
                <dd className="text-slate-300">{String(flightResult.data.onGround)}</dd>
              </dl>
            ) : (
              <p className="mt-2 text-xs text-slate-600">No live state for that ICAO24 right now (not currently airborne/tracked).</p>
            )
          ) : (
            <div className="mt-2">
              <GapNotice reason={flightResult.reason} />
            </div>
          ))}
      </div>
    </div>
  );
}

// ── Threat intel ─────────────────────────────────────────────────────────

interface UrlScanHit {
  url: string;
  domain: string;
  scanDate: string;
  reportUrl: string;
}
interface VtSummary {
  type: string;
  malicious: number;
  suspicious: number;
  harmless: number;
  undetected: number;
  reportUrl: string;
}
interface OtxHit {
  name: string;
  id: string;
  malwareFamilies: string[];
  reportUrl: string;
}

function AddEvidenceButton({ projectId, url, canEdit }: { projectId: string; url: string; canEdit: boolean }) {
  const [added, setAdded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  if (!canEdit) return null;
  return (
    <span className="inline-flex items-center gap-1.5">
      <button
        className="btn-ghost shrink-0 px-2 py-0.5 text-[11px]"
        disabled={busy || added}
        onClick={async () => {
          setBusy(true);
          setErr(null);
          try {
            await api('/lookups/threat/add-evidence', { method: 'POST', body: JSON.stringify({ projectId, url }) });
            setAdded(true);
          } catch (e) {
            setErr(errorMessage(e));
          } finally {
            setBusy(false);
          }
        }}
      >
        {added ? 'in evidence' : busy ? 'adding…' : 'add to evidence'}
      </button>
      {err && <span className="text-[11px] text-red-400">{err}</span>}
    </span>
  );
}

function ThreatIntelSection({ projectId, canEdit, status }: { projectId: string; canEdit: boolean; status?: LookupsStatus['threatIntel'] }) {
  const [urlscanQuery, setUrlscanQuery] = useState('');
  const [urlscanBusy, setUrlscanBusy] = useState(false);
  const [urlscanResult, setUrlscanResult] = useState<Availability<UrlScanHit[]> | null>(null);

  const [vtTarget, setVtTarget] = useState('');
  const [vtType, setVtType] = useState<'domain' | 'ip_address' | 'file' | 'url'>('domain');
  const [vtBusy, setVtBusy] = useState(false);
  const [vtResult, setVtResult] = useState<Availability<VtSummary> | null>(null);

  const [otxIndicator, setOtxIndicator] = useState('');
  const [otxType, setOtxType] = useState<'domain' | 'IPv4' | 'hostname'>('domain');
  const [otxBusy, setOtxBusy] = useState(false);
  const [otxResult, setOtxResult] = useState<Availability<OtxHit[]> | null>(null);

  return (
    <div className="space-y-3">
      <div className="card p-4">
        <h3 className="text-sm font-semibold text-slate-200">URLScan.io search</h3>
        <p className="mt-1 text-xs text-slate-500">Searches already-submitted scans (no key needed) — e.g. domain:example.com</p>
        <div className="mt-3 flex gap-2">
          <input className="input" placeholder="domain:example.com" value={urlscanQuery} onChange={(e) => setUrlscanQuery(e.target.value)} />
          <button
            className="btn-primary"
            disabled={urlscanBusy || !urlscanQuery.trim()}
            onClick={async () => {
              setUrlscanBusy(true);
              try {
                setUrlscanResult(await api(`/projects/${projectId}/lookups/threat/urlscan`, { method: 'POST', body: JSON.stringify({ query: urlscanQuery.trim() }) }));
              } catch (e) {
                setUrlscanResult({ available: false, reason: errorMessage(e) });
              } finally {
                setUrlscanBusy(false);
              }
            }}
          >
            {urlscanBusy ? 'Searching…' : 'Search'}
          </button>
        </div>
        {urlscanResult &&
          (urlscanResult.available ? (
            <ul className="mt-3 space-y-1.5 text-xs">
              {urlscanResult.data.map((h) => (
                <li key={h.reportUrl} className="flex flex-wrap items-center gap-2 rounded border border-ink-800 p-2">
                  <span className="truncate text-slate-300">{h.url}</span>
                  <span className="text-slate-600">{new Date(h.scanDate).toLocaleDateString()}</span>
                  <a href={h.reportUrl} target="_blank" rel="noreferrer" className="ml-auto text-accent hover:underline">
                    report ↗
                  </a>
                  <AddEvidenceButton projectId={projectId} url={h.reportUrl} canEdit={canEdit} />
                </li>
              ))}
              {urlscanResult.data.length === 0 && <p className="text-slate-600">No scans found.</p>}
            </ul>
          ) : (
            <div className="mt-2">
              <GapNotice reason={urlscanResult.reason} />
            </div>
          ))}
      </div>

      <div className="card p-4">
        <h3 className="text-sm font-semibold text-slate-200">VirusTotal reputation</h3>
        {!status?.virusTotal && <p className="mt-1 text-xs text-amber-400">Set VIRUSTOTAL_API_KEY (free tier) to enable.</p>}
        <div className="mt-3 flex gap-2">
          <select className="input w-32 flex-none" value={vtType} onChange={(e) => setVtType(e.target.value as typeof vtType)}>
            <option value="domain">domain</option>
            <option value="ip_address">IP</option>
            <option value="url">URL</option>
            <option value="file">file hash</option>
          </select>
          <input className="input" placeholder="target" value={vtTarget} onChange={(e) => setVtTarget(e.target.value)} />
          <button
            className="btn-primary"
            disabled={vtBusy || !vtTarget.trim()}
            onClick={async () => {
              setVtBusy(true);
              try {
                setVtResult(await api(`/projects/${projectId}/lookups/threat/virustotal`, { method: 'POST', body: JSON.stringify({ target: vtTarget.trim(), type: vtType }) }));
              } catch (e) {
                setVtResult({ available: false, reason: errorMessage(e) });
              } finally {
                setVtBusy(false);
              }
            }}
          >
            {vtBusy ? 'Checking…' : 'Check'}
          </button>
        </div>
        {vtResult &&
          (vtResult.available ? (
            <div className="mt-3 flex flex-wrap items-center gap-2 text-xs">
              <Badge tone={vtResult.data.malicious > 0 ? 'red' : vtResult.data.suspicious > 0 ? 'amber' : 'green'}>{vtResult.data.malicious} malicious</Badge>
              <Badge tone="neutral">{vtResult.data.suspicious} suspicious</Badge>
              <Badge tone="neutral">{vtResult.data.harmless} harmless</Badge>
              <a href={vtResult.data.reportUrl} target="_blank" rel="noreferrer" className="ml-auto text-accent hover:underline">
                full report ↗
              </a>
              <AddEvidenceButton projectId={projectId} url={vtResult.data.reportUrl} canEdit={canEdit} />
            </div>
          ) : (
            <div className="mt-2">
              <GapNotice reason={vtResult.reason} />
            </div>
          ))}
      </div>

      <div className="card p-4">
        <h3 className="text-sm font-semibold text-slate-200">AlienVault OTX pulses</h3>
        {!status?.otx && <p className="mt-1 text-xs text-amber-400">Set OTX_API_KEY (free account) to enable.</p>}
        <div className="mt-3 flex gap-2">
          <select className="input w-32 flex-none" value={otxType} onChange={(e) => setOtxType(e.target.value as typeof otxType)}>
            <option value="domain">domain</option>
            <option value="hostname">hostname</option>
            <option value="IPv4">IPv4</option>
          </select>
          <input className="input" placeholder="indicator" value={otxIndicator} onChange={(e) => setOtxIndicator(e.target.value)} />
          <button
            className="btn-primary"
            disabled={otxBusy || !otxIndicator.trim()}
            onClick={async () => {
              setOtxBusy(true);
              try {
                setOtxResult(await api(`/projects/${projectId}/lookups/threat/otx`, { method: 'POST', body: JSON.stringify({ indicator: otxIndicator.trim(), type: otxType }) }));
              } catch (e) {
                setOtxResult({ available: false, reason: errorMessage(e) });
              } finally {
                setOtxBusy(false);
              }
            }}
          >
            {otxBusy ? 'Checking…' : 'Check'}
          </button>
        </div>
        {otxResult &&
          (otxResult.available ? (
            <ul className="mt-3 space-y-1.5 text-xs">
              {otxResult.data.map((p) => (
                <li key={p.id} className="flex flex-wrap items-center gap-2 rounded border border-ink-800 p-2">
                  <span className="text-slate-300">{p.name}</span>
                  {p.malwareFamilies.map((f) => (
                    <Badge key={f} tone="red">
                      {f}
                    </Badge>
                  ))}
                  <a href={p.reportUrl} target="_blank" rel="noreferrer" className="ml-auto text-accent hover:underline">
                    pulse ↗
                  </a>
                </li>
              ))}
              {otxResult.data.length === 0 && <p className="text-slate-600">No pulses reference this indicator.</p>}
            </ul>
          ) : (
            <div className="mt-2">
              <GapNotice reason={otxResult.reason} />
            </div>
          ))}
      </div>
    </div>
  );
}

// ── Dorks / reverse image ────────────────────────────────────────────────

interface CodeSearchHit {
  repo: string;
  path: string;
  url: string;
}

function DorksSection({ projectId, status }: { projectId: string; status?: LookupsStatus['dorks'] }) {
  const [targetType, setTargetType] = useState<'domain' | 'email' | 'phone' | 'username' | 'generic'>('domain');
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [queries, setQueries] = useState<Array<{ label: string; query: string; links: SearchLink[] }> | null>(null);
  const [ahmia, setAhmia] = useState<SearchLink | null>(null);

  const [imageUrl, setImageUrl] = useState('');
  const [imgBusy, setImgBusy] = useState(false);
  const [imgResult, setImgResult] = useState<{ links: SearchLink[]; pimEyes: SearchLink } | null>(null);

  const [codeQuery, setCodeQuery] = useState('');
  const [codeBusy, setCodeBusy] = useState(false);
  const [codeResult, setCodeResult] = useState<Availability<CodeSearchHit[]> | null>(null);

  async function runDorks() {
    if (!value.trim()) return;
    setBusy(true);
    try {
      const res = await api<{ queries: typeof queries; ahmia: SearchLink }>('/lookups/dorks', { method: 'POST', body: JSON.stringify({ targetType, value: value.trim() }) });
      setQueries(res.queries);
      setAhmia(res.ahmia);
    } finally {
      setBusy(false);
    }
  }

  async function runReverseImage() {
    if (!imageUrl.trim()) return;
    setImgBusy(true);
    try {
      setImgResult(await api('/lookups/reverse-image', { method: 'POST', body: JSON.stringify({ imageUrl: imageUrl.trim() }) }));
    } finally {
      setImgBusy(false);
    }
  }

  async function runCode() {
    if (!codeQuery.trim()) return;
    setCodeBusy(true);
    try {
      setCodeResult(await api(`/projects/${projectId}/lookups/code-search`, { method: 'POST', body: JSON.stringify({ query: codeQuery.trim() }) }));
    } catch (e) {
      setCodeResult({ available: false, reason: errorMessage(e) });
    } finally {
      setCodeBusy(false);
    }
  }

  return (
    <div className="space-y-3">
      <div className="card p-4">
        <h3 className="text-sm font-semibold text-slate-200">Dork query generator</h3>
        <p className="mt-1 text-xs text-slate-500">Builds search-engine queries for you to run yourself — nothing here is auto-executed against a search engine.</p>
        <div className="mt-3 flex gap-2">
          <select className="input w-32 flex-none" value={targetType} onChange={(e) => setTargetType(e.target.value as typeof targetType)}>
            <option value="domain">domain</option>
            <option value="email">email</option>
            <option value="phone">phone</option>
            <option value="username">username</option>
            <option value="generic">generic</option>
          </select>
          <input className="input" placeholder="value" value={value} onChange={(e) => setValue(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && runDorks()} />
          <button className="btn-primary" onClick={runDorks} disabled={busy || !value.trim()}>
            {busy ? 'Building…' : 'Build'}
          </button>
        </div>
        {queries && (
          <div className="mt-3 space-y-2.5">
            {queries.map((q) => (
              <div key={q.label} className="rounded border border-ink-800 p-2">
                <p className="text-xs font-semibold text-slate-400">{q.label}</p>
                <code className="mt-0.5 block break-all text-[11px] text-slate-500">{q.query}</code>
                <div className="mt-1.5">
                  <LinkList links={q.links} />
                </div>
              </div>
            ))}
            {ahmia && (
              <div className="rounded border border-ink-800 p-2">
                <p className="text-xs font-semibold text-slate-400">Dark web index (clearnet, indexes .onion sites)</p>
                <div className="mt-1.5">
                  <LinkList links={[ahmia]} />
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      <div className="card p-4">
        <h3 className="text-sm font-semibold text-slate-200">GitHub code search</h3>
        {!status?.githubCodeSearch && <p className="mt-1 text-xs text-amber-400">Set GITHUB_TOKEN (free personal access token) — unauthenticated code search is too restricted to use.</p>}
        <div className="mt-3 flex gap-2">
          <input className="input" placeholder="e.g. AKIA org:some-org" value={codeQuery} onChange={(e) => setCodeQuery(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && void runCode()} />
          <button className="btn-primary" onClick={() => void runCode()} disabled={codeBusy || !codeQuery.trim()}>
            {codeBusy ? 'Searching…' : 'Search'}
          </button>
        </div>
        {codeResult &&
          (codeResult.available ? (
            <ul className="mt-3 space-y-1 text-xs">
              {codeResult.data.map((h) => (
                <li key={h.url} className="flex items-center gap-2 rounded border border-ink-800 p-2">
                  <span className="text-slate-300">{h.repo}</span>
                  <span className="truncate text-slate-600">{h.path}</span>
                  <a href={h.url} target="_blank" rel="noreferrer" className="ml-auto text-accent hover:underline">
                    open ↗
                  </a>
                </li>
              ))}
              {codeResult.data.length === 0 && <p className="text-slate-600">No matches.</p>}
            </ul>
          ) : (
            <div className="mt-2">
              <GapNotice reason={codeResult.reason} />
            </div>
          ))}
      </div>

      <div className="card p-4">
        <h3 className="text-sm font-semibold text-slate-200">Reverse image search launcher</h3>
        <p className="mt-1 text-xs text-slate-500">Needs a publicly reachable image URL. Opens each engine&apos;s own search-by-image — nothing is matched by this platform.</p>
        <div className="mt-3 flex gap-2">
          <input className="input" placeholder="https://…/photo.jpg" value={imageUrl} onChange={(e) => setImageUrl(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && runReverseImage()} />
          <button className="btn-primary" onClick={runReverseImage} disabled={imgBusy || !imageUrl.trim()}>
            {imgBusy ? 'Building…' : 'Build links'}
          </button>
        </div>
        {imgResult && (
          <div className="mt-3 space-y-2">
            <LinkList links={imgResult.links} />
            <p className="text-[11px] text-slate-600">
              PimEyes requires manually uploading the image in their own UI — no URL-based search exists.{' '}
              <a href={imgResult.pimEyes.url} target="_blank" rel="noreferrer" className="text-accent hover:underline">
                Open PimEyes ↗
              </a>
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
