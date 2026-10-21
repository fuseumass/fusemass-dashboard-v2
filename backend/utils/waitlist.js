"use strict";

/**
 * Waitlist mode. A round may set `waitlistAfterAccepted`: once that many
 * applications in the round are accepted, applications submitted from then on
 * are waitlisted automatically (and the applicant is told so). It never blocks
 * a reviewer from accepting more people, and it doesn't touch applications
 * that were already submitted.
 *
 * `null` (the default) means no limit. The smallest limit is 1: 0 would read
 * as "off" to anyone used to falsy numbers in this codebase, so a round that
 * should waitlist everyone is decided by hand instead.
 */

/**
 * Whether a limit value from the database means "a limit is set".
 * @param {*} limit - `round.waitlistAfterAccepted`.
 * @returns {boolean}
 */
function hasLimit(limit) {
  return typeof limit === "number" && Number.isInteger(limit) && limit >= 1;
}

/**
 * Whether a new submission should be waitlisted.
 * @param {*} limit - `round.waitlistAfterAccepted`.
 * @param {number} acceptedCount - Applications already accepted in the round.
 * @returns {boolean}
 */
function shouldWaitlist(limit, acceptedCount) {
  return hasLimit(limit) && acceptedCount >= limit;
}

/**
 * Validate a limit coming from an admin request. Missing, blank, null or
 * `false` mean no limit; anything else must be a whole number of at least 1.
 *
 * @param {*} value - Raw value from the request body.
 * @returns {{value: (number|null), error: (string|undefined)}} The value to
 *   store, or an error message.
 */
function parseLimit(value) {
  if (value === undefined || value === null || value === false || (typeof value === "string" && value.trim() === "")) {
    return { value: null };
  }
  var number = typeof value === "string" ? Number(value.trim()) : value;
  if (typeof number !== "number" || !Number.isInteger(number) || number < 1) {
    return { error: "waitlistAfterAccepted must be a whole number of at least 1, or empty for no limit." };
  }
  return { value: number };
}

module.exports = {
  hasLimit: hasLimit,
  shouldWaitlist: shouldWaitlist,
  parseLimit: parseLimit,
};
