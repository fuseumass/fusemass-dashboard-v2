"use strict";

var Application = require("../schemas/application");
var EmailLog = require("../schemas/emailLog");
var User = require("../schemas/user");
var mailer = require("./mailer");
var outbox = require("./outbox");
var passwordToken = require("./passwordToken");

// "Remind accepted people to set up their account" (admin User groups page).
// Accepted applicants who applied without an account (or were imported) have
// no password and no Google link; the setup link from their acceptance email
// may have expired or been missed. Each reminder issues a fresh 7-day link
// (replacing the old one) and sends the account_setup_reminder template.
//
// Links are single-use, so these can't sit in the bulk outbox queue (which
// stores placeholder values). Instead they go one at a time in the
// background through mailer.sendTemplateEmail, which logs each to the outbox
// (redacted) and paces sends (EMAIL_MIN_INTERVAL_MS). Each person is claimed
// with an atomic setupReminderSentAt update right before their link is
// issued, so a double click or a second admin can't remind anyone twice.

var TEMPLATE_KEY = "account_setup_reminder";
var DEDUPE_MS = 24 * 60 * 60 * 1000;

var running = Promise.resolve();

/**
 * Filter for accounts with no way to sign in (see passwordToken.needsPasswordSetup).
 * @returns {object} MongoDB filter fragment.
 */
function noSignInFilter() {
  return { passwordHash: { $in: [null, ""] }, googleId: { $in: [null, ""] } };
}

/**
 * Who would get a reminder now, and who is left out because they got a setup
 * email or reminder in the last 24 hours.
 * @returns {Promise<{total: number, eligible: Array<object>, recent: number}>}
 *   total: accepted people who still need to set up their account.
 */
async function findCandidates() {
  var applicantIds = await Application.distinct("applicant", { status: "accepted" });
  var users = await User.find(
    Object.assign({ _id: { $in: applicantIds }, role: { $ne: "judge" } }, noSignInFilter())
  )
    .select("name email passwordHash googleId setupReminderSentAt")
    .sort({ _id: 1 })
    .lean();
  users = users.filter(passwordToken.needsPasswordSetup);
  var cutoff = new Date(Date.now() - DEDUPE_MS);
  var recentlyEmailed = await EmailLog.distinct("to", {
    templateKey: { $in: ["account_setup", TEMPLATE_KEY] },
    status: { $in: ["queued", "sent"] },
    createdAt: { $gte: cutoff },
    to: {
      $in: users.map(function email(u) {
        return u.email;
      }),
    },
  });
  var skip = {};
  recentlyEmailed.forEach(function mark(address) {
    skip[address] = true;
  });
  var eligible = users.filter(function due(u) {
    return !skip[u.email] && !(u.setupReminderSentAt && u.setupReminderSentAt >= cutoff);
  });
  return { total: users.length, eligible: eligible, recent: users.length - eligible.length };
}

/**
 * How many more emails fit under the daily limit right now.
 * @returns {Promise<{limit: number, committed: number, remaining: number}>}
 *   remaining is Infinity when there is no limit.
 */
async function quota() {
  var limit = outbox.dailyLimit();
  var committed = await outbox.committedInLastDay();
  return { limit: limit, committed: committed, remaining: limit > 0 ? Math.max(0, limit - committed) : Infinity };
}

/**
 * Remind one person: claim them (no reminder in 24 h, still no way to sign
 * in), issue a fresh link and send it.
 * @param {*} userId - User _id.
 * @param {*} adminId - Admin who asked.
 * @returns {Promise<boolean>} Whether a reminder was sent (false when the
 *   person was already reminded, set up their account, or the send failed).
 */
async function remindOne(userId, adminId) {
  var now = new Date();
  var cutoff = new Date(now.getTime() - DEDUPE_MS);
  var user = await User.findOneAndUpdate(
    Object.assign(
      { _id: userId, $or: [{ setupReminderSentAt: null }, { setupReminderSentAt: { $lt: cutoff } }] },
      noSignInFilter()
    ),
    { $set: { setupReminderSentAt: now } },
    { new: true }
  );
  if (!user) {
    return false;
  }
  var rawToken = await passwordToken.issuePasswordToken(user, passwordToken.SETUP_TTL_MS);
  return mailer
    .sendTemplateEmail(
      user.email,
      TEMPLATE_KEY,
      { name: user.name, setupUrl: passwordToken.passwordLink(rawToken, { setup: true }) },
      { userId: user._id, requestedBy: adminId }
    )
    .then(
      function sent() {
        return true;
      },
      function onMailError(err) {
        // Logged as failed in the outbox. Release the claim so the next run
        // can try this person again instead of waiting a day.
        console.error("Account setup reminder failed:", err && err.message);
        return User.updateOne({ _id: user._id, setupReminderSentAt: now }, { $unset: { setupReminderSentAt: 1 } }).then(
          function released() {
            return false;
          }
        );
      }
    );
}

/**
 * Send reminders one after another in the background.
 * @param {Array<object>} users - From findCandidates().eligible.
 * @param {*} adminId - Admin who asked.
 * @returns {Promise<number>} Resolves (after the last send) with how many went out.
 */
function sendInBackground(users, adminId) {
  var sent = 0;
  var run = running.then(async function work() {
    for (var i = 0; i < users.length; i++) {
      try {
        if (await remindOne(users[i]._id, adminId)) {
          sent += 1;
        }
      } catch (err) {
        console.error("Account setup reminder failed:", err);
      }
    }
    return sent;
  });
  running = run.catch(function ignore() {});
  return run;
}

/**
 * Resolves when every reminder started so far has been handed to the mailer
 * (tests).
 * @returns {Promise<void>}
 */
function idle() {
  return running.then(function done() {
    return undefined;
  });
}

module.exports = {
  TEMPLATE_KEY: TEMPLATE_KEY,
  DEDUPE_MS: DEDUPE_MS,
  findCandidates: findCandidates,
  quota: quota,
  remindOne: remindOne,
  sendInBackground: sendInBackground,
  idle: idle,
};
