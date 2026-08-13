# us-zip-centroids

[![npm](https://img.shields.io/npm/v/us-zip-centroids)](https://www.npmjs.com/package/us-zip-centroids)
[![CI](https://github.com/drewthomas00/us-zip-centroids/actions/workflows/ci.yml/badge.svg)](https://github.com/drewthomas00/us-zip-centroids/actions/workflows/ci.yml)
[![dependencies](https://img.shields.io/badge/dependencies-none-brightgreen)](https://www.npmjs.com/package/us-zip-centroids?activeTab=dependencies)
[![node](https://img.shields.io/node/v/us-zip-centroids)](https://www.npmjs.com/package/us-zip-centroids)
[![license](https://img.shields.io/npm/l/us-zip-centroids)](LICENSE)

Offline US ZIP code → latitude/longitude. No geocoder, no API key, no network call.

```sh
npm install us-zip-centroids
```

```js
const { zipToCoords, geocodePostalCode } = require('us-zip-centroids');

zipToCoords('30305');                                  // → [33.8341, -84.3921]
zipToCoords('abcde');                                  // → null
zipToCoords('2024-01-15');                             // → null, not a point in DC

geocodePostalCode('30305-1234', { country: 'USA' });
// → { latitude: 33.8341, longitude: -84.3921, source: 'zip_centroid' }
```

TypeScript types included. Zero dependencies.

## Why not just call a geocoding API

Three reasons, and the third is usually the real one.

**Cost.** Commercial geocoders bill per request. Ranking search results by distance means resolving a coordinate on a hot path, and that adds up fast for something that never changes — a ZIP's centroid is the same today as it was last year.

**Latency and failure.** A network call in the middle of a query is a dependency that can be slow, rate-limited, or down. This is a memoized in-process lookup after the first read.

**Privacy.** Sending user addresses to a third party is a data-sharing decision, not just a technical one. Depending on what you're building, it may be one you have to disclose or justify. This resolves entirely inside your own infrastructure.

## What you get, and what you don't

A **ZIP centroid is the middle of an area, not a building.** Precision is about 11 m at four decimal places, which is ample for:

- bounding-box filtering and haversine distance ranking
- "within N miles of me" search
- coarse regional grouping and analytics
- resolving a spoken or typed ZIP to a search center

It is **not** a substitute for street-level geocoding. If you need to put a pin on a specific address, use a real geocoder.

## API

**`zipToCoords(zip)`** → `[lat, lng]` or `null`. A fresh array each call, so mutating it can't corrupt the shared table.

**`geocodePostalCode(code, opts)`** → `{ latitude, longitude, source }` or `null`. `opts.country` accepts ISO-3166 alpha-2, alpha-3 and numeric (`'US'`, `'USA'`, `840`), case- and whitespace-insensitive; anything else returns `null` rather than a guess.

**`normalizeZip(zip)`** → canonical 5-digit string or `null`. See below for exactly what it accepts.

**`isValidZip(zip)`** → boolean. True for a well-formed ZIP whether or not it's covered, so you can tell "that wasn't a ZIP" from "we don't have that one".

**`datasetInfo()`** → `{ path, isOverride, entries, error }`. Assert this at startup — a dataset that failed to load is otherwise only observable as an endless run of `null`s, which reads exactly like "we don't cover those ZIPs":

```js
const { entries, error } = datasetInfo();
if (error) throw new Error(`ZIP centroids unusable: ${error}`);
```

**`clearCache()`** → re-reads the file on the next lookup. `ZIP_CENTROIDS_PATH` is read once, on first use.

## Behaviour worth knowing

**It fails loud, never guesses — and that's mostly about parsing.** Any string with five digits in it *could* be read as a ZIP, and a naive reading turns `'2024-01-15'` into `20240` and `'Suite 200, 123 Main St'` into `20012` — both real coordinates in Washington DC. A wrong point is worse than no point, because downstream it's indistinguishable from a real one.

So `normalizeZip` accepts exactly three shapes:

| Input | Result | |
|---|---|---|
| `'30305'`, `'30305-1234'`, `'303051234'` | `'30305'` | the whole value is a ZIP |
| `'3 0 3 0 5'` | `'30305'` | digits and separators only, at 5 or 9 digits |
| `'Atlanta, GA 30305'` | `'30305'` | a delimited 5-digit run in prose |
| `'2024-01-15'`, `'404-555-1234'` | `null` | 8 and 10 digits — not truncated to fit |
| `'Suite 200, 123 Main St'` | `null` | no 5-digit run |

**US-only, deliberately.** A non-US postal code is a coverage gap, not an answer, and returns `null`.

**Leading zeros are restored on numbers.** `1001` and `1001.0` normalise to `'01001'`, because a number cannot carry a leading zero — recovering it is lossless, not a guess. A *string* `'1001'` is `null`: it's as likely to be a typo as a mangled ZIP. Northeastern ZIPs lose their zero the moment anything treats them as a number, and this is the single most common source of "why does Massachusetts geocode to nowhere".

**An unreadable data file degrades to empty rather than throwing** — every lookup returns `null`, the failure is reported on stderr with its error code, and `datasetInfo().error` carries it for a healthcheck. That covers a missing file, a path pointing at a directory, and a permissions problem alike. A geocoding table that vanished should not take your process down, but it also shouldn't be invisible.

**A CSV that parses to zero rows warns too.** A file truncated by a bad build looks exactly like a working install from the outside.

**Coordinates are bounds-checked.** Since `ZIP_CENTROIDS_PATH` lets you supply the table, a row with an impossible latitude is dropped rather than trusted.

## The data

`data/zip_centroids.csv` is the full **US Census ZCTA Gazetteer** — roughly 33,000 ZCTAs with national coverage including Alaska, Hawaii and Puerto Rico. It is generated from the authoritative Census file, never hand-authored, and is a US Government work in the **public domain**.

Point `ZIP_CENTROIDS_PATH` at another CSV (`zip,lat,lng`) to pin a fresher vintage or a custom table at deploy time without a code change.

The table is parsed once per process and memoized.

## Testing

```sh
npm test
```

Node's built-in test runner. No dependencies.

CI also packs the tarball, installs it into a clean project, and geocodes from
it. The data file *is* the product here, so a `files` entry that stopped
matching `data/` would publish a package whose every lookup returns `null` —
and every test would still pass, because they run against the source tree.

## Related packages

Small, dependency-light pieces pulled out of production systems I've built:

- **[tcpa-quiet-hours](https://github.com/drewthomas00/tcpa-quiet-hours)** — is it legal to send this marketing message right now?
- **[twilio-signature-verify](https://github.com/drewthomas00/twilio-signature-verify)** — verify `X-Twilio-Signature`, including behind a reverse proxy
- **[pg-cron-lease](https://github.com/drewthomas00/pg-cron-lease)** — make an in-process cron job a singleton across replicas, using Postgres

## License

MIT © [Drew Thomas](https://drewthomasbuilds.com) for the code.
The bundled Census data is a US Government work in the public domain.
