/**
 * us-zip-centroids — offline US ZIP → latitude/longitude, no geocoder.
 */

/** `[latitude, longitude]`. A fresh array on every call. */
export type Coordinates = [number, number];

export interface GeocodeResult {
  latitude: number;
  longitude: number;
  source: 'zip_centroid';
}

export interface GeocodeOptions {
  /**
   * ISO-3166 alpha-2, alpha-3 or numeric, or the English name — for the US or
   * a covered territory (PR, VI, GU, MP, AS). Null/absent means "try US".
   */
  country?: string | number | null;
}

export interface DatasetInfo {
  /** The file the table was read from. */
  path: string;
  /** True when ZIP_CENTROIDS_PATH supplied it. */
  isOverride: boolean;
  /** ZCTAs loaded. The bundled dataset carries roughly 33,000. */
  entries: number;
  /** Null when the table loaded cleanly. */
  error: string | null;
}

/**
 * Extract a 5-digit ZIP, or null when the input is not recognisably one.
 *
 * Accepts a bare ZIP or ZIP+4, dictated digits ('3 0 3 0 5'), and a delimited
 * 5-digit run inside prose (the last one, where an address keeps its ZIP). Rejects anything else — a date, a phone number and
 * a street address do NOT become ZIPs. A number is padded (1001 → '01001');
 * a string '1001' is not.
 */
export declare function normalizeZip(raw: string | number | null | undefined): string | null;

/** True when `raw` is a well-formed ZIP, covered or not. */
export declare function isValidZip(raw: string | number | null | undefined): boolean;

/** `[lat, lng]`, or null for an invalid or uncovered ZIP. */
export declare function zipToCoords(raw: string | number | null | undefined): Coordinates | null;

/** Geocode a US postal code, or null when it can't be covered. */
export declare function geocodePostalCode(
  postalCode: string | number | null | undefined,
  opts?: GeocodeOptions,
): GeocodeResult | null;

/**
 * What the process actually loaded — for a startup assertion or healthcheck.
 * Without it, a dataset that failed to load is only observable as an endless
 * run of nulls, which reads exactly like "we don't cover those ZIPs".
 */
export declare function datasetInfo(): DatasetInfo;

/** Drop the memoized table so the next lookup re-reads ZIP_CENTROIDS_PATH. */
export declare function clearCache(): void;
