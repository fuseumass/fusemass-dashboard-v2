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

module.exports = {
  APPLICATION_STATUSES: APPLICATION_STATUSES,
  DECISION_STATUSES: DECISION_STATUSES,
};
