"use strict";

var ScheduleEvent = require("../schemas/scheduleEvent");
var calendar = require("./calendar");

// The schedule shown on the hackathon's public website (GET /api/public/schedule
// and schedule.ics). Anyone on the internet can call those, so the answer is
// kept in memory for a short while: a busy website costs one database read
// every CACHE_TTL_MS, not one per visitor. Admin edits to the run of show call
// invalidate() so a change shows up straight away on this server.
//
// Only items an admin marked `published` are public, and only the fields a
// visitor needs. When workshops (B18) land, their published items are added in
// load() below and the website gets them with no change.

var CACHE_TTL_MS = 30 * 1000;

var cached = null; // { loadedAt, events, ics }
var loading = null; // in-flight load shared by concurrent requests
var generation = 0; // bumped by invalidate() so an older load can't repopulate the cache

/**
 * @param {object} event - A ScheduleEvent (lean).
 * @returns {{id: string, title: string, startsAt: Date, endsAt: Date, location: string, description: string}}
 */
function toPublicEvent(event) {
  return {
    id: String(event._id),
    title: event.title,
    startsAt: event.startsAt,
    endsAt: event.endsAt,
    location: event.location || "",
    description: event.description || "",
  };
}

/**
 * @returns {Promise<Array<object>>} The published items, soonest first.
 */
function load() {
  return ScheduleEvent.find({ published: true })
    .select("title startsAt endsAt location description")
    .sort({ startsAt: 1, createdAt: 1 })
    .lean()
    .then(function toPublic(events) {
      return events.map(toPublicEvent);
    });
}

/**
 * The cache entry, loading it when it is missing or older than the TTL.
 * @returns {Promise<{loadedAt: number, events: Array<object>, ics: string|null}>}
 */
function getEntry() {
  if (cached && Date.now() - cached.loadedAt < CACHE_TTL_MS) {
    return Promise.resolve(cached);
  }
  if (loading) {
    return loading;
  }

  var startedIn = generation;
  var pending = Promise.resolve().then(load).then(
    function afterLoad(events) {
      var entry = { loadedAt: Date.now(), events: events, ics: null };
      if (startedIn === generation) {
        cached = entry;
        loading = null;
      }
      return entry;
    },
    function afterError(err) {
      if (startedIn === generation) {
        loading = null;
      }
      throw err;
    }
  );
  loading = pending;
  return pending;
}

/**
 * @returns {Promise<Array<object>>} The public schedule items (see toPublicEvent).
 */
function getEvents() {
  return getEntry().then(function pick(entry) {
    return entry.events;
  });
}

/**
 * The public schedule as an iCalendar file. Built once per cache fill, so its
 * content (and ETag) stays the same until the schedule changes.
 * @returns {Promise<string>}
 */
function getIcs() {
  return getEntry().then(function build(entry) {
    if (entry.ics === null) {
      entry.ics = calendar.buildRunOfShowIcs(
        entry.events.map(function toIcsEvent(event) {
          return Object.assign({ _id: event.id }, event);
        }),
        {
          orgName: process.env.ORG_NAME || "Hackathon",
          websiteUrl: process.env.ORG_WEBSITE_URL || "",
        }
      );
    }
    return entry.ics;
  });
}

/**
 * Forget the cached schedule; the next request reads the database again.
 * Call after any change to the run of show.
 * @returns {void}
 */
function invalidate() {
  generation += 1;
  cached = null;
  loading = null;
}

module.exports = {
  CACHE_TTL_MS: CACHE_TTL_MS,
  getEvents: getEvents,
  getIcs: getIcs,
  invalidate: invalidate,
};
