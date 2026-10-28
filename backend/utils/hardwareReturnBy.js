"use strict";

/** @param {object} settings - Organization settings. @returns {string} Event-zone deadline. */
function hardwareReturnBy(settings) {
  if (!settings || !settings.hardwareReturnBy) return "the last day of the event";
  var date = new Date(settings.hardwareReturnBy);
  var zone = process.env.EVENT_TIMEZONE || "America/New_York";
  return new Intl.DateTimeFormat("en-US", { weekday: "long", month: "short", day: "numeric", timeZone: zone }).format(date) + " at " + new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit", timeZone: zone }).format(date);
}
module.exports = hardwareReturnBy;
