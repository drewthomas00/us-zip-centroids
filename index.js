'use strict';

const {
  normalizeZip,
  isValidZip,
  zipToCoords,
  geocodePostalCode,
  datasetInfo,
  clearCache,
} = require('./zip-centroids');

// Written out literally rather than spread: Node's cjs-module-lexer only
// detects named exports from a literal `module.exports = { name, ... }`, so a
// spread here would silently downgrade ESM consumers to default-import only.
module.exports = {
  normalizeZip,
  isValidZip,
  zipToCoords,
  geocodePostalCode,
  datasetInfo,
  clearCache,
};
