"use strict";

var Application = require("../schemas/application");
var User = require("../schemas/user");

/**
 * The audiences an admin can send a bulk email to. Each segment resolves to a
 * list of recipients: `{ userId, email, name, consent }`, one per distinct
 * email address. `consent` is the person's announcement opt-in; the caller
 * decides whether it matters (announcements) or not (transactional).
 *
 * Adding a segment is one entry in SEGMENTS. Ones that depend on features that
 * don't exist yet are listed as unavailable, so the admin UI can show them
 * greyed out with the reason instead of leaving them out silently.
 */

/**
 * @param {Array<object>} users - User documents (lean).
 * @param {object} [namesByUser] - Application name by user id, when known.
 * @returns {Array<object>} Recipients, deduplicated by email.
 */
function toRecipients(users, namesByUser) {
  var seen = {};
  var out = [];
  users.forEach(function each(user) {
    var email = String(user.email || "").trim().toLowerCase();
    if (!email || seen[email]) {
      return;
    }
    seen[email] = true;
    var applicationName = namesByUser && namesByUser[String(user._id)];
    out.push({
      userId: user._id,
      email: email,
      name: applicationName || user.name || "",
      consent: Boolean(user.marketingEmailConsent),
    });
  });
  return out;
}

/**
 * Each applicant's latest application (by creation time), optionally limited
 * to one round.
 * @param {*} [round] - ApplicationRound _id to limit to.
 * @returns {Promise<Array<object>>} `{ applicant, status, name }` per applicant.
 */
function latestApplications(round) {
  var filter = round ? { round: round } : {};
  return Application.find(filter)
    .select("applicant status name createdAt")
    .lean()
    .then(function afterFind(applications) {
      var latest = {};
      applications.forEach(function each(application) {
        var key = String(application.applicant);
        var current = latest[key];
        if (!current || new Date(application.createdAt) > new Date(current.createdAt)) {
          latest[key] = application;
        }
      });
      return Object.keys(latest).map(function toList(key) {
        return latest[key];
      });
    });
}

/**
 * @param {string} status - Application status.
 * @returns {function} A resolver for people whose latest application has it.
 */
function byApplicationStatus(status) {
  return function resolve(ctx) {
    return latestApplications(ctx.round).then(function afterApplications(applications) {
      var matching = applications.filter(function isStatus(application) {
        return application.status === status;
      });
      var names = {};
      matching.forEach(function remember(application) {
        names[String(application.applicant)] = application.name;
      });
      return User.find({
        _id: {
          $in: matching.map(function pickId(application) {
            return application.applicant;
          }),
        },
      })
        .select("name email marketingEmailConsent")
        .lean()
        .then(function afterUsers(users) {
          return toRecipients(users, names);
        });
    });
  };
}

/**
 * Applicants (not staff) who have no application at all.
 * @param {object} ctx - `{ round }`.
 * @returns {Promise<Array<object>>}
 */
function notApplied(ctx) {
  return Promise.all([
    latestApplications(ctx.round),
    User.find({ role: "applicant" }).select("name email marketingEmailConsent").lean(),
  ]).then(function afterLoad(results) {
    var applied = {};
    results[0].forEach(function mark(application) {
      applied[String(application.applicant)] = true;
    });
    return toRecipients(
      results[1].filter(function hasNot(user) {
        return !applied[String(user._id)];
      })
    );
  });
}

/**
 * People checked in at the event.
 * @returns {Promise<Array<object>>}
 */
function checkedIn() {
  return User.find({ checkedIn: true })
    .select("name email marketingEmailConsent")
    .lean()
    .then(toRecipients);
}

/**
 * Just the admin asking, to see the email before sending it to everyone.
 * @param {object} ctx - `{ adminId }`.
 * @returns {Promise<Array<object>>}
 */
function testToMe(ctx) {
  return User.find({ _id: ctx.adminId })
    .select("name email marketingEmailConsent")
    .lean()
    .then(toRecipients);
}

var SEGMENTS = [
  { key: "not_applied", label: "Signed up, haven't applied", resolve: notApplied },
  { key: "draft", label: "Started an application, haven't submitted", resolve: byApplicationStatus("draft") },
  { key: "pending", label: "Applied, no decision yet", resolve: byApplicationStatus("pending") },
  { key: "accepted", label: "Accepted", resolve: byApplicationStatus("accepted") },
  { key: "waitlisted", label: "Waitlisted", resolve: byApplicationStatus("waitlisted") },
  { key: "rejected", label: "Rejected", resolve: byApplicationStatus("rejected") },
  { key: "checked_in", label: "Checked in", resolve: checkedIn },
  {
    key: "workshop_signups",
    label: "Workshop sign-ups",
    available: false,
    reason: "Workshops aren't built yet (B18); this segment turns on with them.",
  },
  {
    key: "hardware_holders",
    label: "People still holding hardware",
    available: false,
    reason: "Hardware checkout isn't built yet; this segment turns on with it.",
  },
  { key: "test_to_me", label: "Test: just me", test: true, resolve: testToMe },
];

/**
 * @param {string} key - Segment key.
 * @returns {object|null} The segment definition.
 */
function find(key) {
  return (
    SEGMENTS.find(function byKey(segment) {
      return segment.key === key;
    }) || null
  );
}

/**
 * The segments for the admin UI.
 * @returns {Array<{key: string, label: string, available: boolean, reason: (string|undefined), test: boolean}>}
 */
function list() {
  return SEGMENTS.map(function describe(segment) {
    return {
      key: segment.key,
      label: segment.label,
      available: segment.available !== false,
      reason: segment.reason,
      test: Boolean(segment.test),
    };
  });
}

/**
 * Work out who is in a segment.
 * @param {object} segment - A definition from find().
 * @param {object} ctx
 * @param {*} [ctx.round] - Only consider this application round.
 * @param {*} [ctx.adminId] - The admin asking (for "test to me").
 * @returns {Promise<Array<{userId: *, email: string, name: string, consent: boolean}>>}
 */
function resolve(segment, ctx) {
  return segment.resolve(ctx || {});
}

module.exports = {
  find: find,
  list: list,
  resolve: resolve,
};
