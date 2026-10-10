// Live sanctuary conditions, read from Open-Meteo's keyless public APIs.
//
// Ported from src/lib/openMeteo.ts. The only change is the transport: the
// browser module uses window.setTimeout to bound a hung request, and there is no
// window here, so AbortSignal.timeout does the same job.
//
// Two endpoints, both keyless and CORS-free server-side:
//
//   - air quality: ambient carbon dioxide in ppm and the European AQI
//   - forecast:    relative humidity and air temperature at 2 m
//
// Honesty (house rule, AMAZON-MCP-PLAN.md 1.1): these are modelled fields for
// the sanctuary's coordinates, not a sensor standing in the wetland, and the
// tool description says so. The carbon dioxide field is a coarse global model,
// so a null is handled rather than assumed away. Open-Meteo's free tier is
// non-commercial; a paid key has to be added before the Forest Keeper Pass is
// sold commercially.

/** A hung request must not pin an Alexa+ turn. */
const TIMEOUT_MS = 10000;

const AIR_QUALITY_URL = 'https://air-quality-api.open-meteo.com/v1/air-quality';
const FORECAST_URL = 'https://api.open-meteo.com/v1/forecast';

/**
 * The Ancestral Creek, site 2 in the catalogue (the catalog seed) and
 * the first parseable gps_coords in src/data/mockData.ts - the same coordinate
 * src/lib/openMeteo.ts resolves at runtime. Hardcoded here because this service
 * has no access to the app's frontend data module; keep the two in step.
 */
export const SANCTUARY_COORDINATE = { latitude: 16.482, longitude: 102.819 } as const;

export interface SanctuaryConditions {
  /** Ambient carbon dioxide in ppm, or null when the model has no value here. */
  carbonDioxidePpm: number | null;
  /** European AQI. Lower is better; 20 is the "good" ceiling. */
  europeanAqi: number | null;
  /** Relative humidity at 2 m, percent. */
  humidityPct: number | null;
  /** Air temperature at 2 m, degrees Celsius. */
  temperatureC: number | null;
  /** The hour the models describe, as the API reports it. */
  observedAt: string | null;
}

interface AirQualityResponse {
  current?: {
    time?: string;
    carbon_dioxide?: number | null;
    european_aqi?: number | null;
  };
}

interface ForecastResponse {
  current?: {
    time?: string;
    relative_humidity_2m?: number | null;
    temperature_2m?: number | null;
  };
}

async function getJson<T>(url: string): Promise<T | null> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!response.ok) return null;
    return (await response.json()) as T;
  } catch {
    // Offline, blocked or timed out: the caller reports what it could not read.
    return null;
  }
}

/** A missing or non-numeric field becomes null rather than a made-up zero. */
const numberOf = (value: number | null | undefined): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;

/**
 * The sanctuary's current conditions, or null when nothing could be read. The
 * two endpoints are read independently, so a failing forecast still leaves the
 * air quality figures reported.
 */
export async function fetchSanctuaryConditions(): Promise<SanctuaryConditions | null> {
  const coords = `latitude=${SANCTUARY_COORDINATE.latitude}&longitude=${SANCTUARY_COORDINATE.longitude}`;

  const [air, forecast] = await Promise.all([
    getJson<AirQualityResponse>(`${AIR_QUALITY_URL}?${coords}&current=carbon_dioxide,european_aqi`),
    getJson<ForecastResponse>(`${FORECAST_URL}?${coords}&current=relative_humidity_2m,temperature_2m`),
  ]);

  if (!air?.current && !forecast?.current) return null;

  return {
    carbonDioxidePpm: numberOf(air?.current?.carbon_dioxide),
    europeanAqi: numberOf(air?.current?.european_aqi),
    humidityPct: numberOf(forecast?.current?.relative_humidity_2m),
    temperatureC: numberOf(forecast?.current?.temperature_2m),
    observedAt: air?.current?.time ?? forecast?.current?.time ?? null,
  };
}

/** The European AQI band, so a voice answer can say "good" instead of "17". */
export function describeAqi(value: number): string {
  if (value <= 20) return 'Good';
  if (value <= 40) return 'Fair';
  if (value <= 60) return 'Moderate';
  return 'Poor';
}
