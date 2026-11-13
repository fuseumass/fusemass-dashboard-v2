"use strict";

var User = require("../schemas/user");
var passwordToken = require("./passwordToken");
var primaryClientOrigin = require("./clientOrigin").primaryClientOrigin;

// Emails that carry a single-use link are stored without their content (the
// link works like a password), so a retry can't send the same email again.
// For these templates a retry builds a fresh link instead: issuing it
// replaces the old one, so the email that arrives always has a working link.
// Password resets and email verification stay one attempt: the person asked
// for them and can simply ask again.

var REISSUABLE_KEYS = ["account_setup", "account_setup_reminder", "judge_invite"];

/**
 * @param {string} templateKey - EmailLog / template key.
 * @returns {boolean} Whether a failed send can be retried with a fresh link.
 */
function canReissue(templateKey) {
  return REISSUABLE_KEYS.indexOf(templateKey) !== -1;
}

/**
 * Placeholder values with a fresh link for a retry, or why the email isn't
 * needed any more (the person set a password, or stopped being a judge).
 * @param {object} row - EmailLog row (`to`, `user`, `templateKey`).
 * @returns {Promise<{values: (object|undefined), skip: (string|undefined)}>}
 */
async function freshValues(row) {
  var user = row.user ? await User.findById(row.user) : await User.findOne({ email: row.to });
  if (!user) {
    return { skip: "There's no account for this address any more, so the retry was skipped." };
  }
  if (row.templateKey === "judge_invite") {
    if (user.role !== "judge" || !user.judgeInvitePending) {
      return { skip: "They've accepted the invite or aren't a judge any more, so the retry was skipped." };
    }
    var inviteToken = await passwordToken.issuePasswordToken(user, passwordToken.SETUP_TTL_MS);
    return { values: { name: user.name, inviteUrl: primaryClientOrigin() + "/judge/accept?token=" + inviteToken } };
  }
  if (!passwordToken.needsPasswordSetup(user)) {
    return { skip: "They've set a password since, so the retry was skipped." };
  }
  var setupToken = await passwordToken.issuePasswordToken(user, passwordToken.SETUP_TTL_MS);
  return { values: { name: user.name, setupUrl: passwordToken.passwordLink(setupToken, { setup: true }) } };
}

module.exports = {
  REISSUABLE_KEYS: REISSUABLE_KEYS,
  canReissue: canReissue,
  freshValues: freshValues,
};
