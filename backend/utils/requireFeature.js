"use strict";

var features = require("./features");
var orgSettingsCache = require("./orgSettingsCache");

/**
 * Route guard factory (B25): answers 404 to EVERYONE, admins included, while a
 * module is switched off, so a disabled module can't be half-used. Turn it back
 * on from the admin settings.
 *
 *   router.use("/meals", requireFeature("meals"));        // gate a whole path prefix
 *   router.get("/hardware", requireFeature("hardware"), isAdmin, list);
 *
 * Mount it BEFORE the auth guards: a disabled module should look the same to
 * everyone, signed in or not. EVERY router of a feature-flagged module must
 * mount it (see the list in backend/README.md); a module without it keeps
 * answering while "off".
 *
 * A missing flag counts as ON, so an old settings document or a module added
 * later is never locked out. An unknown feature name throws when the router is
 * built (at startup), not on the first request.
 *
 * @param {string} name - A key from utils/features FEATURE_KEYS.
 * @returns {function} Express middleware (req, res, next).
 */
function requireFeature(name) {
  if (features.FEATURE_KEYS.indexOf(name) === -1) {
    throw new Error("requireFeature: unknown feature \"" + name + "\".");
  }

  return function featureGate(_req, res, next) {
    return orgSettingsCache
      .get()
      .then(function afterLoad(settings) {
        if (!features.isEnabled(settings, name)) {
          res.status(404).json({ error: "This feature is not enabled." });
          return;
        }
        next();
      })
      .catch(next);
  };
}

module.exports = requireFeature;
