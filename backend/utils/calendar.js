"use strict";

// Run-of-show rendering for emails: an iCalendar (.ics) invite, plus a plain
// text version of the same schedule for the email body.

var DEFAULT_TIMEZONE = "America/New_York";

/**
 * The IANA time zone schedule times are written in (EVENT_TIMEZONE), falling
 * back to the default when it is unset or not a real zone.
 * @returns {string}
 */
function eventTimeZone() {
  var zone = process.env.EVENT_TIMEZONE || DEFAULT_TIMEZONE;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
    return zone;
  } catch (_err) {
    console.warn("EVENT_TIMEZONE is not a valid time zone; using " + DEFAULT_TIMEZONE + ":", zone);
    return DEFAULT_TIMEZONE;
  }
}

/**
 * @param {Date} date
 * @returns {string} The date as an iCalendar UTC timestamp, e.g. 20261024T140000Z.
 */
function toIcsDate(date) {
  return new Date(date).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
}

/**
 * Escape a value for an iCalendar TEXT property (RFC 5545 §3.3.11).
 * @param {*} value
 * @returns {string}
 */
function escapeText(value) {
  return String(value == null ? "" : value)
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\r?\n/g, "\\n");
}

/**
 * Fold a content line to at most 75 octets per line (RFC 5545 §3.1), without
 * splitting a multi-byte character.
 * @param {string} line
 * @returns {string}
 */
function foldLine(line) {
  var out = "";
  var current = "";
  var currentBytes = 0;
  var limit = 75;
  Array.from(line).forEach(function addChar(char) {
    var bytes = Buffer.byteLength(char);
    if (currentBytes + bytes > limit) {
      out += current + "\r\n ";
      current = "";
      currentBytes = 0;
      limit = 74; // continuation lines start with a space
    }
    current += char;
    currentBytes += bytes;
  });
  return out + current;
}

/**
 * Build an iCalendar file holding the whole run of show, one event per item.
 *
 * @param {Array<object>} events - ScheduleEvent documents, any order.
 * @param {object} options
 * @param {string} options.orgName - Hackathon name, for the calendar name.
 * @param {string} [options.websiteUrl] - Attached to every event as its URL.
 * @returns {string} The .ics content (CRLF line endings).
 */
function buildRunOfShowIcs(events, options) {
  var orgName = options.orgName;
  var websiteUrl = options.websiteUrl || "";
  var stamp = toIcsDate(new Date());
  var uidDomain = "hackathon-dashboard";
  try {
    uidDomain = websiteUrl ? new URL(websiteUrl).hostname : uidDomain;
  } catch (_err) {
    // Not a URL; keep the generic domain.
  }

  var lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//" + escapeText(orgName) + "//Run of Show//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    "X-WR-CALNAME:" + escapeText(orgName + " run of show"),
  ];

  sortByStart(events).forEach(function addEvent(event) {
    lines.push(
      "BEGIN:VEVENT",
      "UID:" + String(event._id) + "@" + uidDomain,
      "DTSTAMP:" + stamp,
      "DTSTART:" + toIcsDate(event.startsAt),
      "DTEND:" + toIcsDate(event.endsAt),
      "SUMMARY:" + escapeText(event.title)
    );
    if (event.location) lines.push("LOCATION:" + escapeText(event.location));
    if (event.description) lines.push("DESCRIPTION:" + escapeText(event.description));
    if (websiteUrl) lines.push("URL:" + websiteUrl);
    lines.push("END:VEVENT");
  });

  lines.push("END:VCALENDAR");
  return lines.map(foldLine).join("\r\n") + "\r\n";
}

/**
 * @param {Array<object>} events
 * @returns {Array<object>} A copy sorted by start time.
 */
function sortByStart(events) {
  return events.slice().sort(function byStart(a, b) {
    return new Date(a.startsAt).getTime() - new Date(b.startsAt).getTime();
  });
}

/**
 * The run of show as plain text for an email body, with its own heading, in
 * the event's time zone. Empty when there is no schedule, so a template's
 * {{runOfShow}} line simply disappears.
 *
 * @param {Array<object>} events - ScheduleEvent documents, any order.
 * @returns {string}
 */
function formatRunOfShow(events) {
  if (!events || !events.length) {
    return "";
  }
  var timeZone = eventTimeZone();
  var day = new Intl.DateTimeFormat("en-US", { timeZone: timeZone, weekday: "short", month: "short", day: "numeric" });
  var time = new Intl.DateTimeFormat("en-US", { timeZone: timeZone, hour: "numeric", minute: "2-digit" });

  var rows = sortByStart(events).map(function formatEvent(event) {
    var start = new Date(event.startsAt);
    var row =
      day.format(start) + ", " + time.format(start) + " – " + time.format(new Date(event.endsAt)) + ": " + event.title;
    return event.location ? row + " (" + event.location + ")" : row;
  });

  return "Run of show (also attached as a calendar invite):\n" + rows.join("\n");
}

module.exports = {
  buildRunOfShowIcs: buildRunOfShowIcs,
  formatRunOfShow: formatRunOfShow,
};
