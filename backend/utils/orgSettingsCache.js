"use strict";

var OrgSettings = require("../schemas/orgSettings");

/**
 * A short-lived in-process copy of the org settings document, for the
 * read-mostly, hot paths: requireFeature (runs on every request to a module)
 * and the public GET /api/meta/branding. Without it each of those requests
 * would be a database query, and the database is Azure Cosmos DB vCore, where
 * round trips are slower and metered.
 *
 *  - Reads use a plain findOne (never getSingleton, which upserts, i.e. writes).
 *  - Concurrent misses share one query (no stampede when the entry expires).
 *  - If a refresh fails, the previous copy is served rather than an error.
 *  - Admin writes call clear(), so the instance that handled the write sees it
 *    immediately. Other instances catch up within the TTL.
 *
 * TTL: SETTINGS_CACHE_TTL_MS (default 10000; 0 turns caching off). It is read
 * on every call so tests can change it.
 */

var DEFAULT_TTL_MS = 10 * 1000;

var snapshot = null;
var loadedAt = 0;
var inflight = null;
// Bumped by clear() so a query that started before a write can't store its
// (now stale) result after the write.
var generation = 0;

/**
 * @returns {number} Cache lifetime in milliseconds.
 */
function ttlMs() {
  var raw = process.env.SETTINGS_CACHE_TTL_MS;
  if (raw === undefined || raw === "") {
    return DEFAULT_TTL_MS;
  }
  var value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : DEFAULT_TTL_MS;
}

/**
 * Start (or join) a database read of the settings document.
 * @returns {Promise<object>} The plain settings object ({} when none is stored yet).
 */
function load() {
  if (inflight) {
    return inflight;
  }
  var startedIn = generation;
  var promise = OrgSettings.findOne({ key: "default" })
    .lean()
    .then(
      function afterLoad(doc) {
        var value = doc || {};
        if (startedIn === generation) {
          snapshot = value;
          loadedAt = Date.now();
        }
        return value;
      },
      function onError(err) {
        if (snapshot) {
          return snapshot;
        }
        throw err;
      }
    );
  inflight = promise;
  function release() {
    if (inflight === promise) {
      inflight = null;
    }
  }
  promise.then(release, release);
  return promise;
}

/**
 * The org settings as a plain object. Missing keys mean "default": use
 * utils/features and utils/branding to read it, never the raw fields.
 * @returns {Promise<object>} Settings snapshot, at most SETTINGS_CACHE_TTL_MS old.
 */
function get() {
  var ttl = ttlMs();
  if (ttl > 0 && snapshot && Date.now() - loadedAt < ttl) {
    return Promise.resolve(snapshot);
  }
  return load();
}

/**
 * Forget the cached copy. Call after every write to the settings document.
 * @returns {void}
 */
function clear() {
  snapshot = null;
  loadedAt = 0;
  inflight = null;
  generation += 1;
}

module.exports = {
  get: get,
  clear: clear,
};
