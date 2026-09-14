import { loadEnv } from '../env.js';
import { safeFetch } from '../lib/safeFetch.js';
import { logger } from '../logger.js';
import type { LookupAvailability } from '../lib/lookupTypes.js';

/**
 * Geospatial OSINT (§31 Phase 11).
 *
 *  - Nominatim (OpenStreetMap): free, public, keyless — but its usage policy
 *    (operations.osmfoundation.org/policies/nominatim) actively blocks many
 *    datacenter/cloud IP ranges and requires a real identifying User-Agent
 *    (already sent via safeFetch). A block from there is reported as exactly
 *    that, not silently swallowed or faked around.
 *  - WiGLE: free account, but a real API name+token is required for any
 *    lookup at all.
 *  - OpenSky: works fully anonymously (rate-limited); an optional free
 *    account (OPENSKY_USERNAME/PASSWORD) raises the limit.
 */

export interface GeocodeResult {
  displayName: string;
  lat: number;
  lon: number;
  type: string | null;
  osmUrl: string;
}

export async function geocode(query: string): Promise<LookupAvailability<GeocodeResult[]>> {
  try {
    const res = await safeFetch(`https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(query)}&format=jsonv2&limit=5`, { timeoutMs: 10_000 });
    const text = await res.text();
    if (!res.ok) return { available: false, reason: `Nominatim HTTP ${res.status}: ${text.slice(0, 200)}` };
    let rows: Array<{ display_name: string; lat: string; lon: string; type?: string; osm_type?: string; osm_id?: number }>;
    try {
      rows = JSON.parse(text);
    } catch {
      // Nominatim's usage-policy bot/rate-limit block returns an HTML page
      // with HTTP 200, not JSON — treat unparsable "success" as a real gap.
      return { available: false, reason: `Nominatim did not return JSON (likely rate-limited/blocked): ${text.slice(0, 200)}` };
    }
    return {
      available: true,
      data: rows.map((r) => ({
        displayName: r.display_name,
        lat: Number(r.lat),
        lon: Number(r.lon),
        type: r.type ?? null,
        osmUrl: r.osm_type && r.osm_id ? `https://www.openstreetmap.org/${r.osm_type}/${r.osm_id}` : `https://www.openstreetmap.org/search?query=${encodeURIComponent(query)}`,
      })),
    };
  } catch (err) {
    logger.warn({ err }, 'Nominatim geocode failed');
    return { available: false, reason: (err as Error).message };
  }
}

export async function reverseGeocode(lat: number, lon: number): Promise<LookupAvailability<GeocodeResult>> {
  try {
    const res = await safeFetch(`https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lon}&format=jsonv2`, { timeoutMs: 10_000 });
    const text = await res.text();
    if (!res.ok) return { available: false, reason: `Nominatim HTTP ${res.status}: ${text.slice(0, 200)}` };
    let row: { display_name: string; lat: string; lon: string; type?: string; osm_type?: string; osm_id?: number; error?: string };
    try {
      row = JSON.parse(text);
    } catch {
      return { available: false, reason: `Nominatim did not return JSON (likely rate-limited/blocked): ${text.slice(0, 200)}` };
    }
    if (row.error) return { available: false, reason: row.error };
    return {
      available: true,
      data: {
        displayName: row.display_name,
        lat: Number(row.lat),
        lon: Number(row.lon),
        type: row.type ?? null,
        osmUrl: row.osm_type && row.osm_id ? `https://www.openstreetmap.org/${row.osm_type}/${row.osm_id}` : `https://www.openstreetmap.org/#map=17/${lat}/${lon}`,
      },
    };
  } catch (err) {
    logger.warn({ err }, 'Nominatim reverse geocode failed');
    return { available: false, reason: (err as Error).message };
  }
}

export interface WifiNetworkHit {
  ssid: string | null;
  netid: string;
  lat: number;
  lon: number;
  lastUpdate: string | null;
}

export async function wigleLookup(ssidOrBssid: string): Promise<LookupAvailability<WifiNetworkHit[]>> {
  const env = loadEnv();
  if (!env.WIGLE_API_NAME || !env.WIGLE_API_TOKEN) {
    return { available: false, reason: 'WIGLE_API_NAME/WIGLE_API_TOKEN not configured — free account at wigle.net/account.' };
  }
  const isBssid = /^([0-9a-f]{2}:){5}[0-9a-f]{2}$/i.test(ssidOrBssid);
  const param = isBssid ? `netid=${encodeURIComponent(ssidOrBssid)}` : `ssid=${encodeURIComponent(ssidOrBssid)}`;
  try {
    const res = await safeFetch(`https://api.wigle.net/api/v2/network/search?${param}&resultsPerPage=20`, {
      timeoutMs: 12_000,
      headers: { authorization: `Basic ${Buffer.from(`${env.WIGLE_API_NAME}:${env.WIGLE_API_TOKEN}`).toString('base64')}` },
    });
    const body = (await res.json()) as { success?: boolean; message?: string; results?: Array<{ ssid: string | null; netid: string; trilat: number; trilong: number; lastupdt: string | null }> };
    if (!res.ok || body.success === false) return { available: false, reason: body.message ?? `WiGLE HTTP ${res.status}` };
    return {
      available: true,
      data: (body.results ?? []).map((r) => ({ ssid: r.ssid, netid: r.netid, lat: r.trilat, lon: r.trilong, lastUpdate: r.lastupdt })),
    };
  } catch (err) {
    logger.warn({ err }, 'WiGLE lookup failed');
    return { available: false, reason: (err as Error).message };
  }
}

export interface FlightState {
  icao24: string;
  callsign: string | null;
  originCountry: string;
  lat: number | null;
  lon: number | null;
  altitudeM: number | null;
  velocityMs: number | null;
  onGround: boolean;
}

export async function openSkyLookup(icao24: string): Promise<LookupAvailability<FlightState | null>> {
  const env = loadEnv();
  const auth = env.OPENSKY_USERNAME && env.OPENSKY_PASSWORD ? `${env.OPENSKY_USERNAME}:${env.OPENSKY_PASSWORD}@` : '';
  try {
    const res = await safeFetch(`https://${auth}opensky-network.org/api/states/all?icao24=${encodeURIComponent(icao24.toLowerCase())}`, { timeoutMs: 12_000 });
    if (!res.ok) return { available: false, reason: `OpenSky HTTP ${res.status}` };
    // OpenSky's documented state-vector field order: [icao24, callsign,
    // origin_country, time_position, last_contact, longitude, latitude,
    // baro_altitude, on_ground, velocity, ...].
    type StateVector = [string, string | null, string, number | null, number | null, number | null, number | null, number | null, boolean, number | null, ...unknown[]];
    const body = (await res.json()) as { states: StateVector[] | null };
    const row = body.states?.[0];
    if (!row) return { available: true, data: null };
    return {
      available: true,
      data: {
        icao24: row[0],
        callsign: row[1]?.trim() || null,
        originCountry: row[2],
        lon: row[5],
        lat: row[6],
        altitudeM: row[7],
        velocityMs: row[9],
        onGround: row[8],
      },
    };
  } catch (err) {
    logger.warn({ err }, 'OpenSky lookup failed');
    return { available: false, reason: (err as Error).message };
  }
}
