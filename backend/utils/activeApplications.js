"use strict";

/**
 * The one rule for "an application that counts". Staff can mark an application
 * as removed (a duplicate, a test entry) without deleting it: `removedAt` is
 * set and the document stays. Everything that counts, lists or acts on
 * applications (stats, exports, audiences, eligibility, auto-accept, teams)
 * merges this filter into its query so a removed application never counts.
 *
 * `{ removedAt: null }` matches both a missing field and an explicit null, so
 * applications created before this existed are active.
 */
var ACTIVE = { removedAt: null };

/**
 * A copy of a query filter that only matches active (not removed) applications.
 * Works in find(), countDocuments(), distinct(), exists() and aggregate $match.
 *
 * @param {object} [filter] - Existing filter conditions.
 * @returns {object} A new filter with the removal condition added.
 */
function active(filter) {
  return Object.assign({}, filter || {}, ACTIVE);
}

/**
 * Whether an application document has been marked as removed.
 *
 * @param {object} application - Application document or plain object.
 * @returns {boolean}
 */
function isRemoved(application) {
  return Boolean(application && application.removedAt);
}

module.exports = {
  ACTIVE: ACTIVE,
  active: active,
  isRemoved: isRemoved,
};
