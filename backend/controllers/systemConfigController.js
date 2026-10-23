"use strict";

var systemConfig = require("../utils/systemConfig");

/**
 * GET /api/admin/system-config (admin only): every server setting with where
 * its value comes from. Secret values are never included.
 * @param {object} _req - Express request.
 * @param {object} res - Express response.
 * @param {function} next - Express next callback.
 * @returns {Promise<void>}
 */
function getSystemConfig(_req, res, next) {
  res.set("Cache-Control", "no-store");
  return systemConfig
    .describeAll()
    .then(function send(model) {
      res.status(200).json(model);
    })
    .catch(function failed() {
      // Driver errors can contain stored values. Do not forward them to logging.
      res.status(500).json({ error: "Could not access technical settings. Check the server configuration and database." });
    });
}

/**
 * PATCH /api/admin/system-config (admin only): body { values: { KEY: "value" | null } }.
 * Validates everything first; on any error nothing is saved. null removes the
 * dashboard value so the .env value applies again.
 * @param {object} req - Express request.
 * @param {object} res - Express response.
 * @param {function} next - Express next callback.
 * @returns {Promise<void>|void}
 */
function updateSystemConfig(req, res, next) {
  var values = req.body && req.body.values;
  if (!values || typeof values !== "object" || Array.isArray(values) || !Object.keys(values).length) {
    res.status(400).json({ error: "Send { values: { KEY: value } } with at least one setting." });
    return undefined;
  }

  res.set("Cache-Control", "no-store");
  return systemConfig
    .applyChanges(values, req.user && req.user.id, { requestOrigin: req.get("origin") })
    .then(function respond(result) {
      if (result.errors) {
        res.status(400).json({ error: "Some values are not valid. Nothing was saved.", errors: result.errors });
        return undefined;
      }
      return systemConfig.describeAll().then(function send(model) {
        res.status(200).json({
          changed: result.changed,
          restartRequired: result.restartRequired,
          selfRestart: model.selfRestart,
          settings: model.settings,
        });
      });
    })
    .catch(function failed() {
      // Driver errors can contain stored values. Do not forward them to logging.
      res.status(500).json({ error: "Could not access technical settings. Check the server configuration and database." });
    });
}

/**
 * POST /api/admin/system-config/restart (admin only): stop the server shortly
 * so the service manager starts it again. Only when ALLOW_SELF_RESTART=true.
 * @param {object} _req - Express request.
 * @param {object} res - Express response.
 * @returns {void}
 */
function restartServer(_req, res) {
  if (!systemConfig.selfRestartAllowed()) {
    res.status(409).json({
      error: "Restarting from the dashboard is not enabled on this server. Your changes are saved. Restart the service by hand to apply them.",
      restarting: false,
    });
    return;
  }
  res.status(202).json({ restarting: true });
  console.log("Technical settings: restart requested from the dashboard.");
  systemConfig.scheduleRestart();
}

module.exports = {
  getSystemConfig: getSystemConfig,
  updateSystemConfig: updateSystemConfig,
  restartServer: restartServer,
};
