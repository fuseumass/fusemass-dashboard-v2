"use strict";

var Application = require("../schemas/application");
var User = require("../schemas/user");
var mailer = require("./mailer");
var passwordToken = require("./passwordToken");

var DECISION_TEMPLATE_KEYS = {
  accepted: "application_accepted",
  rejected: "application_rejected",
  waitlisted: "application_waitlisted",
};

/**
 * Move an application to a review status and send the matching email. Used by
 * the review screen (PATCH /api/admin/applications/:id) and by domain
 * auto-accept (utils/autoAccept), so both behave the same.
 *
 * The status change is its own guard: the filter only matches an application
 * that is not already at `decision` (plus any extra conditions in `where`), so
 * of two concurrent calls exactly one performs the transition and therefore
 * exactly one sends the email.
 *
 * @param {string|object} applicationId - Application _id.
 * @param {string} decision - "accepted" | "rejected" | "waitlisted" | "pending".
 * @param {string|object} reviewerId - User _id of whoever decided.
 * @param {object} [options]
 * @param {object} [options.where] - Extra filter conditions, e.g. { status: "pending" }.
 * @param {object} [options.set] - Extra fields to set with the decision.
 * @returns {Promise<object|null>} The updated application (applicant
 *   populated), or null when nothing changed.
 */
function decide(applicationId, decision, reviewerId, options) {
  var opts = options || {};
  var filter = Object.assign({ _id: applicationId }, opts.where || {});
  if (filter.status === undefined) {
    filter.status = { $ne: decision };
  }
  var update = Object.assign({ status: decision, reviewedBy: reviewerId, reviewedAt: new Date() }, opts.set || {});

  return Application.findOneAndUpdate(filter, update, { new: true })
    .populate("applicant", "name email role")
    .then(function afterUpdate(application) {
      if (application) {
        sendDecisionEmails(application, decision);
      }
      return application;
    });
}

/**
 * Fire the decision email (and, on acceptance, the account setup link for
 * people who applied without an account). Errors are logged, not thrown: the
 * outbox records and retries failed sends.
 * @param {object} application - Updated Application, applicant populated.
 * @param {string} decision - The new status.
 * @returns {void}
 */
function sendDecisionEmails(application, decision) {
  var templateKey = DECISION_TEMPLATE_KEYS[decision];
  var recipient = application.applicant && application.applicant.email;
  if (templateKey && recipient) {
    // If the template contains {{qrcode}} (the accepted one does by default),
    // the mailer issues the applicant's check-in code and embeds it as a QR.
    mailer
      .sendTemplateEmail(recipient, templateKey, {
        name: application.name,
        status: application.status,
      })
      .catch(function onMailError(err) {
        console.error("Failed to send decision email:", err);
      });
  }
  if (decision === "accepted" && application.applicant) {
    sendAccountSetupIfNeeded(application).catch(function onSetupError(err) {
      console.error("Failed to send account setup email:", err);
    });
  }
}

/**
 * When an accepted applicant applied without an account (so has no password
 * and no Google link), email them a 7-day link to set a password, so they can
 * sign in to see their status and check-in QR code.
 *
 * @param {object} application - The accepted Application, applicant populated.
 * @returns {Promise<void>}
 */
function sendAccountSetupIfNeeded(application) {
  return User.findById(application.applicant._id).then(function afterFind(user) {
    if (!passwordToken.needsPasswordSetup(user)) {
      return undefined;
    }
    return passwordToken.issuePasswordToken(user, passwordToken.SETUP_TTL_MS).then(function afterIssue(rawToken) {
      return mailer.sendTemplateEmail(user.email, "account_setup", {
        name: application.name || user.name,
        setupUrl: passwordToken.passwordLink(rawToken, { setup: true }),
      });
    });
  });
}

module.exports = {
  DECISION_TEMPLATE_KEYS: DECISION_TEMPLATE_KEYS,
  decide: decide,
  sendAccountSetupIfNeeded: sendAccountSetupIfNeeded,
};
