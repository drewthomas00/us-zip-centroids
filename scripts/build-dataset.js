'use strict';

/**
 * Rebuild data/zip_centroids.csv from a Census ZCTA Gazetteer file.
 *
 *   curl -LO https://www2.census.gov/geo/docs/maps-data/data/gazetteer/2025_Gazetteer/2025_Gaz_zcta_national.zip
 *   unzip 2025_Gaz_zcta_national.zip
 *   node scripts/build-dataset.js 2025_Gaz_zcta_national.txt > data/zip_centroids.csv
 *
 * Keeps three columns — GEOID (the ZCTA), INTPTLAT and INTPTLONG (its internal
 * point) — rounded to four decimal places, sorted by ZCTA. Columns are found by
 * header name, so a vintage that reorders them still builds correctly; one that
 * renames them fails rather than writing the wrong numbers.
 */

const fs = require('fs');

const file = process.argv[2];
if (!file) {
  console.error('usage: node scripts/build-dataset.js <Gaz_zcta_national.txt> > data/zip_centroids.csv');
  process.exit(2);
}

const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/).filter((line) => line.trim());
const header = lines[0].split(/[|\t]/).map((name) => name.trim());
const column = (name) => {
  const index = header.indexOf(name);
  if (index === -1) throw new Error(`no ${name} column in ${file} (header: ${header.join(', ')})`);
  return index;
};
const [zipAt, latAt, lngAt] = [column('GEOID'), column('INTPTLAT'), column('INTPTLONG')];

/**
 * Four decimal places, rounded half-to-even on the exact binary value and
 * printed as the shortest decimal that round-trips, with a '.0' kept on whole
 * numbers — the formatting the committed table was generated with, so a
 * rebuild from the same vintage is byte-identical.
 */
const round = (value) => {
  const n = Number(value);
  if (!Number.isFinite(n)) throw new Error(`not a coordinate: '${value}'`);
  const exact = Math.abs(n).toFixed(60);          // a double's full decimal expansion
  const [whole, frac] = exact.split('.');
  let scaled = BigInt(whole + frac.slice(0, 4));
  const rest = frac.slice(4);
  const tie = /^50*$/.test(rest);
  if ((tie && scaled % 2n === 1n) || (!tie && rest[0] >= '5')) scaled += 1n;
  const rounded = Number(scaled) / 10000 * Math.sign(n || 1);
  const text = String(rounded === 0 ? 0 : rounded);
  return Number.isInteger(rounded) ? `${text}.0` : text;
};

const rows = lines.slice(1).map((line) => {
  const cells = line.split(/[|\t]/).map((cell) => cell.trim());
  const zip = cells[zipAt];
  if (!/^\d{5}$/.test(zip)) throw new Error(`not a ZCTA: '${zip}'`);
  return `${zip},${round(cells[latAt])},${round(cells[lngAt])}`;
});
rows.sort();

process.stdout.write(`zip,lat,lng\n${rows.join('\n')}\n`);
