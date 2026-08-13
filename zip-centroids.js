'use strict';

/**
 * us-zip-centroids — offline US ZIP -> latitude/longitude, with no geocoder.
 *
 * Maps a 5-digit ZIP to its centroid using a bundled reference table, so the
 * lookup costs no network call, no API key, and no per-request fee — and the
 * address being resolved never leaves your infrastructure. That last property
 * is often the reason to reach for this: sending user addresses to a
 * third-party geocoder is a data-sharing decision, not just a technical one.
 *
 * Centroid precision is ample for bounding-box filtering and haversine
 * distance ranking (about 11 m of imprecision at four decimal places). It is
 * NOT a substitute for street-level geocoding — a ZIP centroid is the middle
 * of an area, not a building.
 *
 * Data: the committed `data/zip_centroids.csv` is the full US Census ZCTA
 * Gazetteer — roughly 33,000 ZCTAs covering the states, DC, and the
 * territories. It is generated from the authoritative Census file, never
 * hand-authored, and is public domain. Set ZIP_CENTROIDS_PATH to pin a fresher
 * vintage or a custom table at deploy time without a code change.
 *
 * Fails loud, never guesses. That phrase is doing real work here, and it is
 * mostly about parsing rather than lookup: any string with five digits
 * somewhere in it can be read as a ZIP, so "2024-01-15" and "Suite 200, 123
 * Main St" will happily resolve to points in Washington DC if you let them.
 * A wrong coordinate is worse than no coordinate, because downstream it is
 * indistinguishable from a real one — so input that is not recognisably a ZIP
 * resolves to null. See normalizeZip for exactly what counts.
 *
 * US-only: a non-US postal code is a coverage gap, not an answer.
 */

const fs = require('fs');
const path = require('path');

const ZIP_RE = /^\d{5}$/;

/** The whole input is a ZIP, or a ZIP+4 with or without a separator. */
const WHOLE_ZIP_RE = /^(\d{5})(?:[-\s]?\d{4})?$/;

/** Digits and the separators dictation and phone keypads produce. */
const DIGITS_AND_SEPARATORS_RE = /^[\d\s.\-()]+$/;

/** A 5-digit run inside prose, not butted against more digits. */
const EMBEDDED_ZIP_RE = /(?<!\d)(\d{5})(?:-\d{4})?(?!\d)/;

/** ISO-3166 alpha-2, alpha-3 and numeric for the United States. */
const US_COUNTRY_CODES = new Set(['US', 'USA', '840']);

const LAT_BOUND = 90;
const LNG_BOUND = 180;

/**
 * Below this, the table is almost certainly truncated rather than merely
 * pruned. The real Gazetteer carries roughly 33,000 rows; a deliberately
 * small custom table is a supported use, so this only warns.
 */
const SUSPICIOUSLY_SMALL = 100;

// Parsed table, memoized so we read the CSV once per process. Node's require
// cache + single-threaded module init make a load lock unnecessary here.
let centroids = null;
let loadError = null;
// Where the memoized table actually came from. datasetInfo() reports this
// rather than re-reading the env var, so a healthcheck can never describe a
// path the in-memory table was not loaded from.
let loadedFrom = null;

/**
 * CSV path — env override (a pinned/custom Gazetteer at deploy) first, then the
 * bundled national dataset next to this module.
 *
 * Read on first lookup, not at require time, so the variable can be set
 * programmatically before the first call. Call `clearCache()` to pick up a
 * change after that.
 *
 * @returns {{path: string, isOverride: boolean}}
 */
function dataPath() {
  const override = process.env.ZIP_CENTROIDS_PATH;
  if (override) return { path: override, isOverride: true };
  return { path: path.join(__dirname, 'data', 'zip_centroids.csv'), isOverride: false };
}

/** Report a dataset problem. Zero-dep package, so stderr is the only channel. */
function warn(message) {
  console.error(`us-zip-centroids: ${message}`);
}

/**
 * Parse one CSV row into `[zip, lat, lng]`, or null if it is unusable.
 *
 * Coordinates are bounds-checked because ZIP_CENTROIDS_PATH lets anyone supply
 * the table: a finite-but-impossible latitude would otherwise load happily and
 * put a recipient somewhere off the planet.
 */
function parseRow(line) {
  const parts = line.split(',');
  if (parts.length < 3) return null;

  let zip = (parts[0] || '').trim();
  // Restore a leading zero a spreadsheet may have dropped ("2108" -> "02108").
  if (/^\d+$/.test(zip) && zip.length < 5) zip = zip.padStart(5, '0');
  if (!ZIP_RE.test(zip)) return null;

  const latStr = (parts[1] || '').trim();
  const lngStr = (parts[2] || '').trim();
  if (latStr === '' || lngStr === '') return null;

  const lat = Number(latStr);
  const lng = Number(lngStr);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (Math.abs(lat) > LAT_BOUND || Math.abs(lng) > LNG_BOUND) return null;

  return [zip, lat, lng];
}

/**
 * Parse + memoize the centroid table.
 *
 * An unreadable file degrades to an empty table rather than throwing: every ZIP
 * resolves to null — an honest "no coverage" — instead of taking the consuming
 * process down at startup. Every failure is reported on stderr, and
 * `datasetInfo()` exposes the same state so a healthcheck can fail the deploy
 * instead of discovering it one silent null at a time.
 *
 * @returns {Map<string, [number, number]>}
 */
function load() {
  if (centroids !== null) return centroids;

  const table = new Map();
  const { path: file, isOverride } = dataPath();
  const source = isOverride ? 'ZIP_CENTROIDS_PATH' : 'bundled dataset';
  loadedFrom = { path: file, isOverride };
  loadError = null;

  let content;
  try {
    content = fs.readFileSync(file, 'utf8');
  } catch (err) {
    // Any read error, not just ENOENT: a path pointing at a directory or a
    // file the process cannot read is the same class of ops fault, and
    // crashing on one while degrading on the other is the worst of both.
    loadError = `${err.code || 'READ_ERROR'}: ${err.message}`;
    warn(`could not read the centroid file (${source} = ${file}) — `
      + `every lookup will return null. ${loadError}`);
    centroids = table;
    return centroids;
  }

  const lines = content.split('\n');
  // The dataset is plain numeric CSV — no quoting or escaping — so split(',')
  // is sufficient and fast over ~33k rows. The header line is not special-
  // cased: 'zip,lat,lng' simply fails to parse as a row, which also means a
  // headerless custom table does not silently lose its first entry.
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i].trim();
    if (!line) continue;
    const row = parseRow(line);
    if (row) table.set(row[0], [row[1], row[2]]);
  }

  // A file that parsed to nothing is the failure mode nobody notices: a CSV
  // truncated by a bad build looks exactly like a working install from the
  // outside, and every lookup silently returns null forever.
  if (table.size === 0) {
    loadError = 'parsed 0 rows';
    warn(`the centroid file parsed to 0 rows (${source} = ${file}) — `
      + 'every lookup will return null.');
  } else if (table.size < SUSPICIOUSLY_SMALL && !isOverride) {
    loadError = `parsed only ${table.size} rows`;
    warn(`the bundled centroid file parsed to only ${table.size} rows — expected ~33,000. `
      + 'It is probably truncated.');
  }

  centroids = table;
  return centroids;
}

/**
 * Extract a 5-digit ZIP from input, or null when the input is not recognisably
 * one.
 *
 * Three accepted shapes, narrowest first:
 *
 *   1. The whole value is a ZIP or ZIP+4 — '30305', '30305-1234', '303051234'.
 *   2. The value is only digits and separators, as dictation and keypads
 *      produce — '3 0 3 0 5'. Accepted at exactly 5 or 9 digits, so a phone
 *      number ('404-555-1234', 10) and a date ('2024-01-15', 8) are rejected
 *      rather than truncated into a plausible-looking ZIP.
 *   3. The value is prose containing a delimited 5-digit run —
 *      'Atlanta, GA 30305'. 'Suite 200, 123 Main St' has no such run, so it is
 *      null rather than '20012'.
 *
 * A JS number is padded to five digits, because a number cannot carry a
 * leading zero: `1001` unambiguously means '01001' and recovering it is
 * lossless. A *string* '1001' is not padded — it is as likely to be a typo as a
 * mangled ZIP, and guessing is what this function exists not to do.
 *
 * @param {?string|number} raw
 * @returns {?string}
 */
function normalizeZip(raw) {
  if (raw === null || raw === undefined) return null;

  // An array is not a postal code, however convincingly it stringifies:
  // String([30305]) is '30305', and String(['303','05']) is '303,05'. A column
  // that arrived as an array is a schema bug upstream, and answering it with
  // coordinates buries that.
  if (Array.isArray(raw)) return null;

  if (typeof raw === 'number') {
    if (!Number.isInteger(raw) || raw < 0 || raw > 99999) return null;
    return String(raw).padStart(5, '0');
  }

  const text = String(raw).trim();
  if (!text) return null;

  const whole = WHOLE_ZIP_RE.exec(text);
  if (whole) return whole[1];

  if (DIGITS_AND_SEPARATORS_RE.test(text)) {
    const digits = text.replace(/\D/g, '');
    return (digits.length === 5 || digits.length === 9) ? digits.slice(0, 5) : null;
  }

  const embedded = EMBEDDED_ZIP_RE.exec(text);
  return embedded ? embedded[1] : null;
}

/**
 * True when `raw` contains a well-formed 5-digit ZIP (regardless of whether we
 * have a centroid for it) — lets a caller distinguish "that wasn't a ZIP" from
 * "we don't cover that ZIP yet".
 * @param {?string|number} raw
 * @returns {boolean}
 */
function isValidZip(raw) {
  return normalizeZip(raw) !== null;
}

/**
 * Resolve ZIP input to `[lat, lng]`, or null if it isn't a valid ZIP or we have
 * no centroid for it (unknown -> fail loud upstream).
 *
 * Returns a fresh array each call. Handing out the table's own entry lets one
 * caller normalising coordinates in place corrupt that ZIP for every other
 * consumer in the process, permanently and silently.
 *
 * @param {?string|number} raw
 * @returns {?[number, number]}
 */
function zipToCoords(raw) {
  const zipCode = normalizeZip(raw);
  if (zipCode === null) return null;
  const found = load().get(zipCode);
  return found ? [found[0], found[1]] : null;
}

/**
 * Geocode a postal code to `{ latitude, longitude, source }`, or null when we
 * can't cover it.
 *
 * US-only: the bundled dataset is the US Census ZCTA Gazetteer, so an
 * EXPLICITLY non-US country resolves to null — a fail-loud coverage gap rather
 * than a wrong-but-plausible guess borrowed from a colliding US ZCTA. A
 * null/absent/empty country means "unknown, try US".
 *
 * `country` accepts ISO-3166 alpha-2, alpha-3 and numeric ('US', 'USA', 840),
 * because records in the wild carry all three and silently geocoding nothing
 * for a database full of 'USA' is a miserable thing to debug.
 *
 * @param {?string|number} postalCode - a US ZIP (ZIP+4 tolerated)
 * @param {{ country?: ?string|number }} [opts]
 * @returns {?{ latitude: number, longitude: number, source: 'zip_centroid' }}
 */
function geocodePostalCode(postalCode, opts = {}) {
  const country = opts && opts.country;
  if (country !== null && country !== undefined) {
    const code = String(country).trim().toUpperCase();
    if (code !== '' && !US_COUNTRY_CODES.has(code)) return null;
  }
  const coords = zipToCoords(postalCode);
  if (!coords) return null;
  return { latitude: coords[0], longitude: coords[1], source: 'zip_centroid' };
}

/**
 * What the process actually loaded — for a startup assertion or a healthcheck.
 *
 * Without this, a dataset that failed to load is only observable as an endless
 * run of nulls, which reads exactly like "we don't cover those ZIPs".
 *
 *   const { entries, error } = datasetInfo();
 *   if (error) throw new Error(`ZIP centroids unusable: ${error}`);
 *
 * @returns {{path: string, isOverride: boolean, entries: number, error: ?string}}
 */
function datasetInfo() {
  const table = load();
  // loadedFrom, not dataPath(): after load() the env var may have changed, and
  // this must describe the table that is actually in memory.
  const { path: file, isOverride } = loadedFrom;
  return { path: file, isOverride, entries: table.size, error: loadError };
}

/**
 * Drop the memoized table so the next lookup re-reads the file.
 *
 * Public because ZIP_CENTROIDS_PATH is read on first load: without this there
 * is no way to point at a different table after the first lookup, in a test or
 * anywhere else.
 */
function clearCache() {
  centroids = null;
  loadError = null;
  loadedFrom = null;
}

module.exports = {
  normalizeZip,
  isValidZip,
  zipToCoords,
  geocodePostalCode,
  datasetInfo,
  clearCache,
};
