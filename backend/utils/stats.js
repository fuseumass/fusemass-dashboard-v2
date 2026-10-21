"use strict";

// Pure helpers for the admin statistics (controllers/statsController): shaping
// grouped counts into chart-ready lists. No database access in here.

var NOT_PROVIDED = "Not provided";

// Longest gap, in days, that fillDays will pad with zero rows.
var MAX_FILLED_DAYS = 400;

// Matches a "graduation year" question however the organizers named it
// ("Graduation Year", gradYear, "Class of", ...). Graduation year isn't a
// built-in application field; it's one of the round's custom questions.
var GRADUATION_PATTERN = /graduat(?:ion|ing)|grad[\s_-]?(?:year|yr|date)|class[\s_-]?of/i;

/**
 * Turn grouped counts into a ranked list for a chart: the biggest `top`
 * groups, plus one "other" total for the long tail (so a hundred schools
 * with one attendee each don't swamp the page).
 *
 * @param {Array<{label: *, count: number}>} rows - One row per distinct value.
 * @param {number} top - How many groups to keep.
 * @returns {{total: number, distinct: number, buckets: Array<{label: string, count: number}>, other: {distinct: number, count: number}}}
 */
function bucketize(rows, top) {
  var merged = Object.create(null);
  rows.forEach(function add(row) {
    var label = String(row.label === null || row.label === undefined ? "" : row.label).trim() || NOT_PROVIDED;
    merged[label] = (merged[label] || 0) + row.count;
  });

  var list = Object.keys(merged)
    .map(function toRow(label) {
      return { label: label, count: merged[label] };
    })
    .sort(function byCount(a, b) {
      return b.count - a.count || a.label.toLowerCase().localeCompare(b.label.toLowerCase());
    });

  var kept = list.slice(0, top);
  var rest = list.slice(top);
  return {
    total: list.reduce(function sum(total, row) {
      return total + row.count;
    }, 0),
    distinct: list.length,
    buckets: kept,
    other: {
      distinct: rest.length,
      count: rest.reduce(function sum(total, row) {
        return total + row.count;
      }, 0),
    },
  };
}

/**
 * Whether a custom question asks for the graduation year.
 * @param {object} field - A formConfig field ({ key, label, ... }).
 * @returns {boolean}
 */
function isGraduationField(field) {
  return Boolean(field) && (GRADUATION_PATTERN.test(String(field.label || "")) || GRADUATION_PATTERN.test(String(field.key || "")));
}

/**
 * How an application answer is shown in a chart, or null for "no answer".
 * Checkbox answers read Yes / No.
 * @param {*} value - A stored answer (or one choice of a multiselect).
 * @returns {string|null}
 */
function answerLabel(value) {
  if (value === true) return "Yes";
  if (value === false) return "No";
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "string" && value.trim()) return value.trim();
  return null;
}

/**
 * Pad a per-day series with zero rows for the days nobody submitted, so a
 * chart's x axis has no gaps. Left alone when the span is absurdly long.
 *
 * @param {Array<{date: string}>} days - Rows with a "YYYY-MM-DD" `date`, any order.
 * @param {function(string): object} emptyRow - Builds a zero row for a date.
 * @returns {Array<object>} Rows in date order.
 */
function fillDays(days, emptyRow) {
  var sorted = days.slice().sort(function byDate(a, b) {
    return a.date < b.date ? -1 : a.date > b.date ? 1 : 0;
  });
  if (sorted.length < 2) {
    return sorted;
  }

  var byDate = Object.create(null);
  sorted.forEach(function index(row) {
    byDate[row.date] = row;
  });

  var cursor = new Date(sorted[0].date + "T00:00:00Z");
  var last = new Date(sorted[sorted.length - 1].date + "T00:00:00Z");
  if (Number.isNaN(cursor.getTime()) || Number.isNaN(last.getTime())) {
    return sorted;
  }
  if ((last.getTime() - cursor.getTime()) / 86400000 > MAX_FILLED_DAYS) {
    return sorted;
  }

  var filled = [];
  while (cursor.getTime() <= last.getTime()) {
    var date = cursor.toISOString().slice(0, 10);
    filled.push(byDate[date] || emptyRow(date));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return filled;
}

module.exports = {
  NOT_PROVIDED: NOT_PROVIDED,
  bucketize: bucketize,
  isGraduationField: isGraduationField,
  answerLabel: answerLabel,
  fillDays: fillDays,
};
