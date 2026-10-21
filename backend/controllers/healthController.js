"use strict";

var mongoose = require("mongoose");

// How long to wait for the database before calling it down. Short, so an
// uptime monitor gets a quick 503 instead of a hanging request.
var PING_TIMEOUT_MS = 3000;

/**
 * GET /api/health/db
 * Readiness check: pings the database and reports whether it answered.
 * GET /api/health stays a pure liveness check that never touches the database,
 * so monitors can tell "the process is up" apart from "the database is reachable".
 *
 * Responds 200 `{ ok: true, db: "up", latencyMs }` or 503 `{ ok: false, db: "down" }`.
 * It is public, so it says nothing about which database or server version.
 *
 * @param {object} _req - Express request.
 * @param {object} res - Express response.
 * @returns {Promise<void>}
 */
function databaseHealth(_req, res) {
  res.set("Cache-Control", "no-store");

  var connection = mongoose.connection;
  if (connection.readyState !== 1 || !connection.db) {
    res.status(503).json({ ok: false, db: "down" });
    return Promise.resolve();
  }

  var started = Date.now();
  var timer;
  var timeout = new Promise(function rejectAfterTimeout(_resolve, reject) {
    timer = setTimeout(function onTimeout() {
      reject(new Error("Database ping timed out after " + PING_TIMEOUT_MS + "ms."));
    }, PING_TIMEOUT_MS);
  });

  return Promise.race([connection.db.admin().command({ ping: 1 }), timeout])
    .then(function afterPing() {
      res.status(200).json({ ok: true, db: "up", latencyMs: Date.now() - started });
    })
    .catch(function onError(err) {
      console.error("Database health check failed:", err.message);
      res.status(503).json({ ok: false, db: "down" });
    })
    .finally(function clearPingTimeout() {
      clearTimeout(timer);
    });
}

module.exports = {
  databaseHealth: databaseHealth,
};
