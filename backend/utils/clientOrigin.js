"use strict";

var DEFAULT_ORIGIN = "http://localhost:3000";

/**
 * Every frontend address allowed to call the API (CORS). CLIENT_ORIGIN holds
 * one address, or several separated by commas, e.g.
 *   CLIENT_ORIGIN=https://dashboard.example.com,https://www.dashboard.example.com
 * Read on every call, so a changed env takes effect without code changes.
 *
 * @returns {Array<string>} Origins without trailing slashes, primary first.
 */
function clientOrigins() {
  var list = String(process.env.CLIENT_ORIGIN || DEFAULT_ORIGIN)
    .split(",")
    .map(function clean(origin) {
      return origin.trim().replace(/\/+$/, "");
    })
    .filter(Boolean);
  return list.length ? list : [DEFAULT_ORIGIN];
}

/**
 * The canonical frontend address (the first one listed), used for links the
 * backend sends people to: emails, OAuth redirects, Discord posts.
 *
 * @returns {string}
 */
function primaryClientOrigin() {
  return clientOrigins()[0];
}

/**
 * `origin` option for the cors middleware: allow exactly the listed origins
 * (the matching one is echoed back), and requests without an Origin header
 * (curl, server-to-server), which CORS doesn't apply to.
 *
 * @param {string|undefined} origin - The request's Origin header.
 * @param {function} callback - cors callback (err, allow).
 * @returns {void}
 */
function corsOrigin(origin, callback) {
  callback(null, !origin || clientOrigins().indexOf(origin) !== -1);
}

module.exports = {
  clientOrigins: clientOrigins,
  primaryClientOrigin: primaryClientOrigin,
  corsOrigin: corsOrigin,
};
