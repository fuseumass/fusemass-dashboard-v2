"use strict";

var fs = require("fs");
var path = require("path");
var csvParse = require("csv-parse/sync");
var googleStatus = require("../utils/googleStatus");

var DATA_DIR = path.join(__dirname, "..", "data");

// In-memory caches so we parse each file only once.
var collegesCache = null;
var programmingSkillsCache = null;
var hardwareSkillsCache = null;

/**
 * Load and cache the list of colleges from data/colleges.csv. The CSV is
 * expected to have a header row with a "name" column (extra columns ignored).
 * Returns an empty list if the file is missing (the organizer adds it later).
 * @returns {string[]}
 */
function loadColleges() {
  if (collegesCache) {
    return collegesCache;
  }
  var file = path.join(DATA_DIR, "colleges.csv");
  if (!fs.existsSync(file)) {
    collegesCache = [];
    return collegesCache;
  }
  var raw = fs.readFileSync(file, "utf8");
  var rows = csvParse.parse(raw, { columns: true, skip_empty_lines: true, trim: true });
  collegesCache = rows
    .map(function pick(row) {
      return row.name || row.Name || row.college || row.institution || "";
    })
    .filter(Boolean);
  return collegesCache;
}

/**
 * Load and cache a JSON array of skill names from data/<file>.
 * @param {string} fileName
 * @returns {string[]}
 */
function loadSkills(fileName) {
  var file = path.join(DATA_DIR, fileName);
  if (!fs.existsSync(file)) {
    return [];
  }
  try {
    var parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    return Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    console.error("Failed to load", fileName, err);
    return [];
  }
}

/**
 * Case-insensitive prefix+substring search, capped to a sane number of results.
 * @param {string[]} list
 * @param {string} query
 * @param {number} limit
 * @returns {string[]}
 */
function search(list, query, limit) {
  var q = String(query || "").trim().toLowerCase();
  if (!q) {
    return list.slice(0, limit);
  }
  var matches = list.filter(function match(item) {
    return item.toLowerCase().indexOf(q) !== -1;
  });
  // Prefer items that start with the query.
  matches.sort(function rank(a, b) {
    var aStarts = a.toLowerCase().indexOf(q) === 0 ? 0 : 1;
    var bStarts = b.toLowerCase().indexOf(q) === 0 ? 0 : 1;
    return aStarts - bStarts;
  });
  return matches.slice(0, limit);
}

/**
 * GET /api/meta/colleges?q=...  — autocomplete for the university field.
 * @param {object} req
 * @param {object} res
 * @returns {void}
 */
function colleges(req, res) {
  var results = search(loadColleges(), req.query && req.query.q, 20);
  res.status(200).json({ results: results });
}

/**
 * GET /api/meta/skills/programming?q=...
 * @param {object} req
 * @param {object} res
 * @returns {void}
 */
function programmingSkills(req, res) {
  if (!programmingSkillsCache) {
    programmingSkillsCache = loadSkills("programming-skills.json");
  }
  var results = search(programmingSkillsCache, req.query && req.query.q, 20);
  res.status(200).json({ results: results });
}

/**
 * GET /api/meta/skills/hardware?q=...
 * @param {object} req
 * @param {object} res
 * @returns {void}
 */
function hardwareSkills(req, res) {
  if (!hardwareSkillsCache) {
    hardwareSkillsCache = loadSkills("hardware-skills.json");
  }
  var results = search(hardwareSkillsCache, req.query && req.query.q, 20);
  res.status(200).json({ results: results });
}

/**
 * GET /api/meta/config — public info the frontend needs before login: the
 * hackathon name and whether Google sign-in is currently available (so the
 * login/signup pages can show or hide the Google button).
 * @param {object} _req
 * @param {object} res
 * @returns {Promise<void>}
 */
function config(_req, res) {
  return googleStatus
    .isGoogleEnabled()
    .then(function afterCheck(googleEnabled) {
      res.status(200).json({
        orgName: process.env.ORG_NAME || "Hackathon",
        googleAuthEnabled: googleEnabled,
      });
    })
    .catch(function onError() {
      // Never block the login page on this; default Google to off.
      res.status(200).json({
        orgName: process.env.ORG_NAME || "Hackathon",
        googleAuthEnabled: false,
      });
    });
}

module.exports = {
  colleges: colleges,
  programmingSkills: programmingSkills,
  hardwareSkills: hardwareSkills,
  config: config,
};
