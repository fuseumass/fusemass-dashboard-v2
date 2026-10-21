"use strict";

var calendar = require("../utils/calendar");
var publicSchedule = require("../utils/publicSchedule");

// Endpoints anyone can call without logging in (mounted at /api/public), for
// the hackathon's own website. Nothing personal belongs here: each response is
// limited to what an admin chose to publish, and is cacheable by browsers and
// CDNs for a minute.

// Browsers and CDNs may keep a copy for a minute, and serve a stale one for
// up to five more while they fetch a fresh one.
var CACHE_CONTROL = "public, max-age=60, stale-while-revalidate=300";

/**
 * GET /api/public/schedule
 * The published schedule: `{ org: { name, website }, timeZone, events: [{ id,
 * title, startsAt, endsAt, location, description }] }`, soonest first, times
 * as ISO 8601 (UTC). `timeZone` is the event's own zone, for display.
 * @param {object} _req - Express request.
 * @param {object} res - Express response.
 * @returns {Promise<void>}
 */
function getSchedule(_req, res) {
  return publicSchedule
    .getEvents()
    .then(function afterLoad(events) {
      res.set("Cache-Control", CACHE_CONTROL);
      res.status(200).json({
        org: {
          name: process.env.ORG_NAME || "Hackathon",
          website: process.env.ORG_WEBSITE_URL || "",
        },
        timeZone: calendar.eventTimeZone(),
        events: events,
      });
    })
    .catch(function onError(err) {
      console.error("getSchedule failed:", err);
      res.status(500).json({ error: "Could not load the schedule." });
    });
}

/**
 * GET /api/public/schedule.ics
 * The same published schedule as an iCalendar file, for "add to calendar" and
 * calendar subscriptions.
 * @param {object} _req - Express request.
 * @param {object} res - Express response.
 * @returns {Promise<void>}
 */
function getScheduleIcs(_req, res) {
  return publicSchedule
    .getIcs()
    .then(function afterBuild(ics) {
      res.set({
        "Cache-Control": CACHE_CONTROL,
        "Content-Type": "text/calendar; charset=utf-8",
        "Content-Disposition": 'inline; filename="schedule.ics"',
      });
      res.status(200).send(ics);
    })
    .catch(function onError(err) {
      console.error("getScheduleIcs failed:", err);
      res.status(500).json({ error: "Could not load the schedule." });
    });
}

module.exports = {
  getSchedule: getSchedule,
  getScheduleIcs: getScheduleIcs,
};
