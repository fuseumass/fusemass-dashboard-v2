"use strict";

/**
 * Application review statuses.
 *
 * Two deliberately different lists:
 *
 *   APPLICATION_STATUSES - every value the `status` field may hold, including
 *                          "draft" (an application still being filled out).
 *   DECISION_STATUSES    - the subset a reviewer may *move* an application to.
 *                          "draft" is excluded on purpose: a reviewer decision
 *                          can never send an application back to draft.
 *
 */
var APPLICATION_STATUSES = ["draft", "pending", "accepted", "rejected", "waitlisted"];

var DECISION_STATUSES = ["accepted", "rejected", "waitlisted", "pending"];

/**
 * Pick the application that tells an applicant where they stand, across all
 * of their rounds: an accepted application wins (that is the one that matters
 * on event day, whichever round it was in), otherwise the most recently
 * created one. Drafts are skipped: an unsubmitted draft in a closed round
 * isn't a status worth showing.
 *
 * @param {Array<object>} applications - Objects with `status` and `createdAt`.
 * @returns {object|null} The chosen application, or null when none was submitted.
 */
function pickLatest(applications) {
  var best = null;
  (applications || []).forEach(function consider(application) {
    if (!application || application.status === "draft") {
      return;
    }
    if (!best) {
      best = application;
      return;
    }
    var accepted = application.status === "accepted";
    var bestAccepted = best.status === "accepted";
    if (accepted !== bestAccepted) {
      if (accepted) {
        best = application;
      }
      return;
    }
    if (new Date(application.createdAt).getTime() >= new Date(best.createdAt).getTime()) {
      best = application;
    }
  });
  return best;
}

module.exports = {
  APPLICATION_STATUSES: APPLICATION_STATUSES,
  DECISION_STATUSES: DECISION_STATUSES,
  pickLatest: pickLatest,
};
