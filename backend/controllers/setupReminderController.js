"use strict";

var mailer = require("../utils/mailer");
var setupReminders = require("../utils/setupReminders");

// Account setup reminders (admin only, /api/admin/setup-reminders). See
// utils/setupReminders.js for who is included and how the emails are paced.

/**
 * GET /api/admin/setup-reminders
 * How many accepted people still haven't set up their account, and how many
 * a reminder would go to now.
 * @param {object} _req - Express request.
 * @param {object} res - Express response.
 * @returns {Promise<void>}
 */
async function getSummary(_req, res) {
  try {
    var found = await setupReminders.findCandidates();
    var quota = await setupReminders.quota();
    res.status(200).json({
      needSetup: found.total,
      eligible: found.eligible.length,
      skippedRecent: found.recent,
      dailyLimit: quota.limit,
      committedLast24h: quota.committed,
      remainingToday: Number.isFinite(quota.remaining) ? quota.remaining : null,
      emailConfigured: mailer.isMailConfigured(),
    });
  } catch (err) {
    console.error("setup reminder summary failed:", err);
    res.status(500).json({ error: "Could not count the accounts to remind." });
  }
}

/**
 * POST /api/admin/setup-reminders   Body: { allowOverLimit? }
 * Issue a fresh setup link to each accepted person who still can't sign in
 * and send it with the account_setup_reminder email. Nobody is reminded
 * twice within 24 hours. Only as many as fit under the daily sending limit
 * go out (the rest are reported and can be sent later) unless
 * `allowOverLimit` is true. The emails are sent one at a time in the
 * background; the outbox shows them as they go.
 * @param {object} req - Express request.
 * @param {object} res - Express response.
 * @returns {Promise<void>}
 */
async function sendReminders(req, res) {
  try {
    if (!mailer.isMailConfigured()) {
      res.status(503).json({ error: "Email isn't configured on the server (SMTP_HOST / SMTP_USER)." });
      return;
    }
    var body = req.body || {};
    var found = await setupReminders.findCandidates();
    var quota = await setupReminders.quota();
    var room = body.allowOverLimit === true ? found.eligible.length : Math.min(found.eligible.length, quota.remaining);
    var toSend = found.eligible.slice(0, room);
    if (toSend.length) {
      setupReminders.sendInBackground(toSend, req.user.id);
    }
    res.status(200).json({
      queued: toSend.length,
      skippedRecent: found.recent,
      deferredByLimit: found.eligible.length - toSend.length,
      needSetup: found.total,
      dailyLimit: quota.limit,
      committedLast24h: quota.committed,
    });
  } catch (err) {
    console.error("sendReminders failed:", err);
    res.status(500).json({ error: "Could not send the reminders." });
  }
}

module.exports = {
  getSummary: getSummary,
  sendReminders: sendReminders,
};
