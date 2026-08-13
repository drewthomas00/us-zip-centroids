'use strict';

/**
 * Pins the parsing contract — which is where "fails loud, never guesses" is
 * actually won or lost — plus the bundled dataset's coverage, the
 * ZIP_CENTROIDS_PATH override, and every way the table can fail to load.
 */

const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const geo = require('..');

/** Write a CSV to a temp dir and point the loader at it. */
function useTable(csv) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zip-centroids-'));
  const file = path.join(dir, 'table.csv');
  fs.writeFileSync(file, csv);
  process.env.ZIP_CENTROIDS_PATH = file;
  geo.clearCache();
  return file;
}

/** Capture stderr for the duration of `fn`. */
function captureStderr(fn) {
  const lines = [];
  const real = console.error;
  console.error = (...args) => lines.push(args.join(' '));
  try {
    fn();
  } finally {
    console.error = real;
  }
  return lines;
}

afterEach(() => {
  delete process.env.ZIP_CENTROIDS_PATH;
  geo.clearCache();
});


// ── parsing ──────────────────────────────────────────────────────

describe('normalizeZip — what counts as a ZIP', () => {
  it('accepts a bare ZIP and a ZIP+4', () => {
    assert.equal(geo.normalizeZip('30305'), '30305');
    assert.equal(geo.normalizeZip('30305-1234'), '30305');
    assert.equal(geo.normalizeZip('30305 1234'), '30305');
    assert.equal(geo.normalizeZip('303051234'), '30305');
    assert.equal(geo.normalizeZip('  30305  '), '30305');
  });

  it('accepts dictated digits', () => {
    // A caller reading their ZIP aloud is why this shape is supported at all.
    assert.equal(geo.normalizeZip('3 0 3 0 5'), '30305');
    assert.equal(geo.normalizeZip('3-0-3-0-5'), '30305');
  });

  it('finds a delimited ZIP inside prose', () => {
    assert.equal(geo.normalizeZip('Atlanta, GA 30305'), '30305');
    assert.equal(geo.normalizeZip("it's 30305 thanks"), '30305');
  });

  it('refuses to manufacture a ZIP out of unrelated digits', () => {
    // Every one of these used to resolve, and two of them landed on real
    // coordinates in Washington DC. A confidently wrong point is worse than
    // no point: downstream it is indistinguishable from a real lookup.
    assert.equal(geo.normalizeZip('2024-01-15'), null);
    assert.equal(geo.normalizeZip('Suite 200, 123 Main St'), null);
    assert.equal(geo.normalizeZip('PO Box 12 Apt 345'), null);
    assert.equal(geo.normalizeZip('order #98 qty 7654'), null);
    assert.equal(geo.normalizeZip('+1 404 555 1234'), null);
    assert.equal(geo.normalizeZip('404-555-1234'), null);
  });

  it('pads a NUMBER, because a number cannot carry a leading zero', () => {
    assert.equal(geo.normalizeZip(1001), '01001');
    assert.equal(geo.normalizeZip(1001.0), '01001');
    assert.equal(geo.normalizeZip(30305), '30305');
    assert.equal(geo.normalizeZip(601), '00601');
  });

  it('does not pad a STRING, which is as likely a typo as a mangled ZIP', () => {
    assert.equal(geo.normalizeZip('1001'), null);
    assert.equal(geo.normalizeZip('123'), null);
  });

  it('rejects an array, however convincingly it stringifies', () => {
    // String([30305]) is '30305'. A column that arrived as an array is a
    // schema bug upstream, and answering it with coordinates buries that.
    assert.equal(geo.normalizeZip([30305]), null);
    assert.equal(geo.normalizeZip(['30305']), null);
    assert.equal(geo.zipToCoords([30305]), null);
  });

  it('rejects empty, absent and out-of-range input', () => {
    for (const bad of ['', '   ', null, undefined, 'abc', -1, 1.5, 100000, NaN]) {
      assert.equal(geo.normalizeZip(bad), null, `${JSON.stringify(bad)} should not be a ZIP`);
    }
  });
});

describe('isValidZip', () => {
  it('separates "not a ZIP" from "a ZIP we may not cover"', () => {
    assert.equal(geo.isValidZip('30305'), true);
    assert.equal(geo.isValidZip('30305-1234'), true);
    assert.equal(geo.isValidZip('99999'), true, 'well-formed, even if uncovered');
    assert.equal(geo.isValidZip('abc'), false);
    assert.equal(geo.isValidZip('30'), false);
    assert.equal(geo.isValidZip('2024-01-15'), false);
  });
});


// ── the bundled dataset ──────────────────────────────────────────

describe('the bundled national dataset', () => {
  it('resolves a known ZIP to plausible coordinates', () => {
    const coords = geo.zipToCoords('30305');
    assert.notEqual(coords, null);
    const [lat, lng] = coords;
    assert.ok(lat > 33.0 && lat < 34.5, `latitude ${lat} is not in metro Atlanta`);
    assert.ok(lng > -85.0 && lng < -84.0, `longitude ${lng} is not in metro Atlanta`);
  });

  it('covers the lower 48, Alaska, Hawaii and the territories', () => {
    const places = {
      30305: 'Atlanta GA', 10001: 'New York NY', 98101: 'Seattle WA',
      99801: 'Juneau AK', 96813: 'Honolulu HI', '00901': 'San Juan PR',
      '00802': 'St Thomas VI', 96910: 'Hagatna GU', '01001': 'Agawam MA',
    };
    for (const [zip, place] of Object.entries(places)) {
      assert.notEqual(geo.zipToCoords(zip), null, `${zip} (${place}) should resolve`);
    }
  });

  it('ships the whole Gazetteer, not a truncated copy', () => {
    // A CSV truncated by a bad build looks exactly like a working install
    // from the outside — every lookup just returns null.
    const { entries, error } = geo.datasetInfo();
    assert.equal(error, null);
    assert.ok(entries > 30000, `expected ~33,000 ZCTAs, loaded ${entries}`);
  });

  it('returns null for an unknown or malformed ZIP', () => {
    assert.equal(geo.zipToCoords('00000'), null);
    assert.equal(geo.zipToCoords('nope'), null);
    assert.equal(geo.zipToCoords(null), null);
  });

  it('hands back a fresh array, not the table entry', () => {
    // One caller normalising coordinates in place would otherwise corrupt
    // that ZIP for every other consumer in the process, permanently.
    const first = geo.zipToCoords('30305');
    first[0] = 0;
    first[1] = 0;
    assert.deepEqual(geo.zipToCoords('30305'), [33.8341, -84.3921]);
  });
});


// ── geocodePostalCode ────────────────────────────────────────────

describe('geocodePostalCode', () => {
  it('resolves a US postal code to {latitude, longitude, source}', () => {
    const out = geo.geocodePostalCode('30305', { country: 'US' });
    assert.equal(out.source, 'zip_centroid');
    assert.deepEqual([out.latitude, out.longitude], geo.zipToCoords('30305'));
  });

  it('accepts alpha-2, alpha-3 and numeric country codes', () => {
    // Records in the wild carry all three, and silently geocoding nothing for
    // a database full of 'USA' is a miserable thing to debug.
    for (const country of ['US', 'us', ' us ', 'USA', 'usa', 840, '840']) {
      assert.notEqual(geo.geocodePostalCode('30305', { country }), null,
        `country ${JSON.stringify(country)} should resolve`);
    }
  });

  it('treats a null, absent or empty country as "unknown, try US"', () => {
    assert.notEqual(geo.geocodePostalCode('30305'), null);
    assert.notEqual(geo.geocodePostalCode('30305', {}), null);
    assert.notEqual(geo.geocodePostalCode('30305', { country: null }), null);
    assert.notEqual(geo.geocodePostalCode('30305', { country: '' }), null);
  });

  it('treats an explicitly non-US country as a coverage gap', () => {
    // 30305 IS a valid US ZCTA — a CA or DE record must not borrow its centroid.
    assert.equal(geo.geocodePostalCode('30305', { country: 'CA' }), null);
    assert.equal(geo.geocodePostalCode('10115', { country: 'DE' }), null);
    assert.equal(geo.geocodePostalCode('30305', { country: 'GBR' }), null);
  });

  it('returns null for an unknown, absent or malformed postal code', () => {
    assert.equal(geo.geocodePostalCode('00000', { country: 'US' }), null);
    assert.equal(geo.geocodePostalCode(null, { country: 'US' }), null);
    assert.equal(geo.geocodePostalCode(undefined), null);
    assert.equal(geo.geocodePostalCode('not-a-zip', { country: 'US' }), null);
  });
});


// ── loading the table ────────────────────────────────────────────

describe('ZIP_CENTROIDS_PATH', () => {
  it('replaces the bundled dataset entirely', () => {
    useTable('zip,lat,lng\n00001,10.5,20.5\n');

    assert.deepEqual(geo.zipToCoords('00001'), [10.5, 20.5]);
    assert.equal(geo.zipToCoords('30305'), null, 'the override replaces, not merges');
    assert.equal(geo.datasetInfo().isOverride, true);
  });

  it('restores dropped leading zeros and skips malformed rows', () => {
    useTable('zip,lat,lng\n2108,42.35,-71.06\n99998,abc,def\n99997,\n');

    assert.deepEqual(geo.zipToCoords('02108'), [42.35, -71.06]);
    assert.equal(geo.zipToCoords('99998'), null);
    assert.equal(geo.zipToCoords('99997'), null);
  });

  it('loads a headerless table without losing its first row', () => {
    // The header is recognised by failing to parse, not by position, so a
    // custom table with no header keeps row 0.
    useTable('00001,10.5,20.5\n00002,11.5,21.5\n');

    assert.deepEqual(geo.zipToCoords('00001'), [10.5, 20.5]);
    assert.equal(geo.datasetInfo().entries, 2);
  });

  it('drops rows whose coordinates are off the planet', () => {
    // The table is caller-supplied, so a finite-but-impossible latitude has to
    // be rejected rather than trusted.
    useTable('zip,lat,lng\n30305,999,-9999\n30306,33.7,-84.3\n');

    assert.equal(geo.zipToCoords('30305'), null);
    assert.deepEqual(geo.zipToCoords('30306'), [33.7, -84.3]);
  });
});

describe('a dataset that will not load', () => {
  it('degrades to empty and says so, rather than throwing', () => {
    process.env.ZIP_CENTROIDS_PATH = path.join(os.tmpdir(), 'does-not-exist-zip.csv');
    geo.clearCache();

    const lines = captureStderr(() => {
      assert.equal(geo.zipToCoords('30305'), null);
      assert.equal(geo.geocodePostalCode('30305', { country: 'US' }), null);
    });
    assert.ok(lines.length > 0);
    assert.match(lines[0], /ENOENT/);
    assert.match(lines[0], /ZIP_CENTROIDS_PATH/);
  });

  it('degrades on a read error that is not ENOENT, too', () => {
    // Pointing at a directory used to throw EISDIR and take the process down,
    // while a missing file degraded — the worst of both policies.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zip-centroids-dir-'));
    process.env.ZIP_CENTROIDS_PATH = dir;
    geo.clearCache();

    const lines = captureStderr(() => {
      assert.doesNotThrow(() => geo.zipToCoords('30305'));
      assert.equal(geo.zipToCoords('30305'), null);
    });
    assert.ok(lines.length > 0);
  });

  it('complains about a file that parsed to zero rows', () => {
    // A CSV truncated to its header is the failure nobody notices: it looks
    // exactly like a working install and returns null forever.
    const lines = captureStderr(() => {
      useTable('zip,lat,lng\n');
      geo.zipToCoords('30305');
    });
    assert.ok(lines.some((l) => /0 rows/.test(l)));
    assert.equal(geo.datasetInfo().error, 'parsed 0 rows');
  });

  it('exposes the failure through datasetInfo, so a healthcheck can catch it', () => {
    captureStderr(() => {
      process.env.ZIP_CENTROIDS_PATH = path.join(os.tmpdir(), 'nope-zip.csv');
      geo.clearCache();
      geo.zipToCoords('30305');
    });

    const info = geo.datasetInfo();
    assert.equal(info.entries, 0);
    assert.match(info.error, /ENOENT/);
  });
});

describe('clearCache', () => {
  it('lets a later lookup see a changed ZIP_CENTROIDS_PATH', () => {
    useTable('zip,lat,lng\n00001,1,1\n');
    assert.deepEqual(geo.zipToCoords('00001'), [1, 1]);

    useTable('zip,lat,lng\n00001,2,2\n');
    assert.deepEqual(geo.zipToCoords('00001'), [2, 2]);
  });
});

describe('datasetInfo', () => {
  it('describes the table in memory, not the env var of the moment', () => {
    // Changing ZIP_CENTROIDS_PATH without clearCache() must not make a
    // healthcheck report a path the loaded table never came from.
    const file = useTable('zip,lat,lng\n00001,1,1\n');
    geo.zipToCoords('00001');

    process.env.ZIP_CENTROIDS_PATH = '/somewhere/else.csv';
    assert.equal(geo.datasetInfo().path, file);
    assert.equal(geo.datasetInfo().entries, 1);
  });
});
