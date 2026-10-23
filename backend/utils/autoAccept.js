"use strict";

var validator = require("validator");
var Application = require("../schemas/application");
var OrgSettings = require("../schemas/orgSettings");
var User = require("../schemas/user");
var decisions = require("./decisions");
var mailer = require("./mailer");
var outbox = require("./outbox");

// Domain auto-accept, switched on in Settings (OrgSettings.autoAccept): every
// minute, accept a few of the oldest pending applications from the listed
// email domains. Pacing matters more than speed. A free Gmail account can send
// about 500 emails per rolling 24 hours and every acceptance sends at least
// one email, so the admin sets how many acceptances (emails) per day, and the
// worker spreads them evenly over the day: never more than that number in any
// 24 hours, never more than a 24th of it in any hour, and nothing while the
// outbox's own 24-hour limit (EMAIL_DAILY_LIMIT) is used up.

var HOUR_MS = 60 * 60 * 1000;
var DAY_MS = 24 * HOUR_MS;
var DEFAULT_INTERVAL_MS = 60 * 1000;
var SAMPLE_SIZE = 10;
var MAX_DOMAINS = 20;
var MAX_PER_DAY = 10000;

var timer = null;
var running = null;
// What the last run did, for the Settings page: { at, state, note, accepted }.
var lastRun = null;

/**
 * @returns {number} How often the worker runs (AUTO_ACCEPT_INTERVAL_MS, default 1 minute).
 */
function intervalMs() {
  var value = Number(process.env.AUTO_ACCEPT_INTERVAL_MS);
  return value > 0 ? value : DEFAULT_INTERVAL_MS;
}

/**
 * Clean up what an admin typed as a domain: "@UMass.edu", "umass.edu " and
 * "someone@umass.edu" all become "umass.edu".
 * @param {*} input - Raw value.
 * @returns {string|null} The domain, or null if it isn't one.
 */
function normalizeDomain(input) {
  if (typeof input !== "string") {
    return null;
  }
  var domain = input.trim().toLowerCase();
  var at = domain.lastIndexOf("@");
  if (at !== -1) {
    domain = domain.slice(at + 1);
  }
  if (!validator.isFQDN(domain, { require_tld: true, allow_underscores: false })) {
    return null;
  }
  return domain;
}

/**
 * Check a PATCH /api/admin/settings `autoAccept` object.
 * @param {*} input - { enabled?, domains?, includeSubdomains?, emailsPerDay? }.
 * @returns {{errors: string[], update: object}} `update` uses dotted paths.
 */
function validateSettingsPatch(input) {
  var errors = [];
  var update = {};
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { errors: ["autoAccept must be an object."], update: update };
  }
  Object.keys(input).forEach(function check(key) {
    if (["enabled", "domains", "includeSubdomains", "emailsPerDay"].indexOf(key) === -1) {
      errors.push("Unknown auto-accept setting: " + key + ".");
    }
  });
  ["enabled", "includeSubdomains"].forEach(function checkBool(key) {
    if (input[key] === undefined) {
      return;
    }
    if (typeof input[key] !== "boolean") {
      errors.push(key + " must be true or false.");
    } else {
      update["autoAccept." + key] = input[key];
    }
  });
  if (input.domains !== undefined) {
    var raw = typeof input.domains === "string" ? input.domains.split(/[\s,]+/) : input.domains;
    if (!Array.isArray(raw)) {
      errors.push("domains must be a list, like [\"umass.edu\"].");
    } else {
      var domains = [];
      raw.forEach(function each(item) {
        if (typeof item === "string" && item.trim() === "") {
          return;
        }
        var domain = normalizeDomain(item);
        if (!domain) {
          errors.push(JSON.stringify(String(item)) + " isn't an email domain.");
        } else if (domains.indexOf(domain) === -1) {
          domains.push(domain);
        }
      });
      if (domains.length > MAX_DOMAINS) {
        errors.push("At most " + MAX_DOMAINS + " domains.");
      }
      update["autoAccept.domains"] = domains;
    }
  }
  if (input.emailsPerDay !== undefined) {
    var perDay = Number(input.emailsPerDay);
    if (!Number.isInteger(perDay) || perDay < 1 || perDay > MAX_PER_DAY) {
      errors.push("Emails per day must be a whole number from 1 to " + MAX_PER_DAY + ".");
    } else {
      update["autoAccept.emailsPerDay"] = perDay;
    }
  }
  return { errors: errors, update: update };
}

/**
 * Escape a string for use inside a RegExp.
 * @param {string} text - Raw text.
 * @returns {string}
 */
function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * The email pattern for some domains: "@umass.edu" at the end, and with
 * subdomains also "@cs.umass.edu". Never matches "@notumass.edu".
 * @param {string[]} domains - Normalized domains.
 * @param {boolean} includeSubdomains - Match subdomains too.
 * @returns {RegExp}
 */
function emailPattern(domains, includeSubdomains) {
  var prefix = includeSubdomains ? "@(?:[a-z0-9-]+\\.)*" : "@";
  return new RegExp(prefix + "(?:" + domains.map(escapeRegExp).join("|") + ")$", "i");
}

/**
 * The Application filter for candidates: pending, not flagged, from an
 * account at one of the domains.
 * @param {object} config - { domains, includeSubdomains }.
 * @returns {Promise<object|null>} A MongoDB filter, or null with no domains.
 */
function candidateFilter(config) {
  if (!config.domains || config.domains.length === 0) {
    return Promise.resolve(null);
  }
  return User.find({ email: emailPattern(config.domains, config.includeSubdomains !== false) })
    .distinct("_id")
    .then(function afterUsers(userIds) {
      return { status: "pending", flagged: { $ne: true }, applicant: { $in: userIds } };
    });
}

/**
 * What auto-accept would do, without changing anything: how many pending
 * applications match, how many matching ones are flagged (skipped), and the
 * first few in the order they'd be accepted (oldest first).
 * @param {object} config - { domains, includeSubdomains }.
 * @returns {Promise<{pending: number, flaggedSkipped: number, sample: object[]}>}
 */
function preview(config) {
  return candidateFilter(config).then(function afterFilter(filter) {
    if (!filter) {
      return { pending: 0, flaggedSkipped: 0, sample: [] };
    }
    return Promise.all([
      Application.countDocuments(filter),
      Application.countDocuments(Object.assign({}, filter, { flagged: true })),
      Application.find(filter)
        .sort({ createdAt: 1 })
        .limit(SAMPLE_SIZE)
        .select("name applicant round createdAt")
        .populate("applicant", "email")
        .populate("round", "name")
        .lean(),
    ]).then(function afterCounts(results) {
      return {
        pending: results[0],
        flaggedSkipped: results[1],
        sample: results[2].map(function toRow(app) {
          return {
            name: app.name,
            email: app.applicant ? app.applicant.email : "",
            round: app.round ? app.round.name : "",
            submittedAt: app.createdAt,
          };
        }),
      };
    });
  });
}

/**
 * Most acceptances one run may make, so `perDay` is spread over the day:
 * 240 a day is 10 an hour, one every 6 minutes, never a burst of 240.
 * @param {number} perDay - The daily number.
 * @returns {{perHour: number, perRun: number}}
 */
function pacing(perDay) {
  var perHour = Math.max(1, Math.ceil(perDay / 24));
  var perRun = Math.max(1, Math.ceil((perHour * intervalMs()) / HOUR_MS));
  return { perHour: perHour, perRun: perRun };
}

/**
 * Acceptances auto-accept made since `since`.
 * @param {Date} since - Window start.
 * @returns {Promise<number>}
 */
function acceptedSince(since) {
  return Application.countDocuments({ autoAccepted: true, reviewedAt: { $gte: since } });
}

/**
 * Remember what this run did (shown on the Settings page).
 * @param {string} state - "off" | "waiting" | "accepting".
 * @param {string} note - Plain-words reason, "" when all is well.
 * @param {number} accepted - Acceptances in this run.
 * @returns {object} The record.
 */
function record(state, note, accepted) {
  lastRun = { at: new Date(), state: state, note: note, accepted: accepted || 0 };
  return lastRun;
}

/**
 * Accept the next few applications, within every limit.
 * @param {Date} [now] - Current time (tests pass one).
 * @returns {Promise<object>} { state, note, accepted }.
 */
function runOnce(now) {
  var at = now || new Date();
  return OrgSettings.getSingleton().then(function afterSettings(settings) {
    var config = (settings && settings.autoAccept) || {};
    if (!config.enabled) {
      return record("off", "", 0);
    }
    if (!config.domains || config.domains.length === 0) {
      return record("waiting", "Add at least one email domain.", 0);
    }
    if (!mailer.isMailConfigured()) {
      return record(
        "waiting",
        "Email isn't set up on the server, so nobody is accepted (they wouldn't get their acceptance email).",
        0
      );
    }

    var pace = pacing(config.emailsPerDay);
    return Promise.all([
      acceptedSince(new Date(at.getTime() - DAY_MS)),
      acceptedSince(new Date(at.getTime() - HOUR_MS)),
      outbox.committedInLastDay(),
    ]).then(function afterCounts(counts) {
      var lastDay = counts[0];
      var lastHour = counts[1];
      if (lastDay >= config.emailsPerDay) {
        return record(
          "waiting",
          "Accepted " + lastDay + " in the last 24 hours, the daily number. More go out as that window moves.",
          0
        );
      }
      var budget = Math.min(pace.perRun, pace.perHour - lastHour, config.emailsPerDay - lastDay);
      if (budget <= 0) {
        return record("waiting", "Accepted " + lastHour + " in the last hour. The next ones go out shortly.", 0);
      }
      var outboxLimit = outbox.dailyLimit();
      if (outboxLimit > 0) {
        // Keep one email of headroom: an acceptance can also send an
        // account setup link.
        var room = outboxLimit - counts[2] - 1;
        if (room <= 0) {
          return record(
            "waiting",
            "The server's email limit (" +
              outboxLimit +
              " in 24 hours) is used up by all emails together. Accepting continues as older emails age out.",
            0
          );
        }
        budget = Math.min(budget, room);
      }

      return candidateFilter(config).then(function afterFilter(filter) {
        return Application.find(filter)
          .sort({ createdAt: 1 })
          .limit(budget)
          .select("_id")
          .lean()
          .then(function afterFind(candidates) {
            if (candidates.length === 0) {
              return record("waiting", "No pending applications from these domains right now.", 0);
            }
            return acceptAll(settings, candidates).then(function afterAccept(accepted) {
              return record("accepting", "", accepted);
            });
          });
      });
    });
  });
}

/**
 * Accept candidates one after another through the same path as the review
 * screen (status change, acceptance email with QR, account setup link). An
 * application that changed in the meantime (reviewed, flagged) is skipped.
 * @param {object} settings - OrgSettings document (for updatedBy).
 * @param {object[]} candidates - [{ _id }].
 * @returns {Promise<number>} How many were accepted.
 */
function acceptAll(settings, candidates) {
  var accepted = 0;
  return candidates
    .reduce(function chain(previous, candidate) {
      return previous.then(function next() {
        return decisions
          .decide(candidate._id, "accepted", null, {
            where: { status: "pending", flagged: { $ne: true } },
            set: { autoAccepted: true },
          })
          .then(function afterDecide(application) {
            if (application) {
              accepted += 1;
            }
          });
      });
    }, Promise.resolve())
    .then(function done() {
      return accepted;
    });
}

/**
 * Run once; overlapping calls share one run. Errors are logged.
 * @param {Date} [now] - Current time (tests pass one).
 * @returns {Promise<object|null>}
 */
function runDue(now) {
  if (running) {
    return running;
  }
  running = runOnce(now)
    .catch(function onError(err) {
      console.error("Auto-accept run failed:", err);
      return record("waiting", "The last run failed; it tries again in a minute.", 0);
    })
    .finally(function clear() {
      running = null;
    });
  return running;
}

/**
 * Where auto-accept stands, for the Settings page.
 * @returns {Promise<object>}
 */
function status() {
  return OrgSettings.getSingleton().then(function afterSettings(settings) {
    var config = (settings && settings.autoAccept) || {};
    var now = Date.now();
    return Promise.all([
      preview(config),
      acceptedSince(new Date(now - DAY_MS)),
      Application.countDocuments({ autoAccepted: true }),
      outbox.committedInLastDay(),
    ]).then(function afterCounts(results) {
      var pace = pacing(config.emailsPerDay || 1);
      return {
        enabled: Boolean(config.enabled),
        domains: config.domains || [],
        includeSubdomains: config.includeSubdomains !== false,
        emailsPerDay: config.emailsPerDay,
        perHour: pace.perHour,
        pending: results[0].pending,
        flaggedSkipped: results[0].flaggedSkipped,
        sample: results[0].sample,
        acceptedLast24h: results[1],
        acceptedTotal: results[2],
        hoursToFinish: results[0].pending ? Math.ceil(results[0].pending / pace.perHour) : 0,
        emailConfigured: mailer.isMailConfigured(),
        serverEmailLimit: outbox.dailyLimit(),
        serverEmailsLast24h: results[3],
        lastRun: lastRun,
      };
    });
  });
}

/**
 * Start the once-a-minute worker (server.js only, never in tests).
 * @returns {void}
 */
function startWorker() {
  if (timer) {
    return;
  }
  timer = setInterval(runDue, intervalMs());
  if (timer.unref) {
    timer.unref();
  }
}

/**
 * Stop the worker.
 * @returns {void}
 */
function stopWorker() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

module.exports = {
  normalizeDomain: normalizeDomain,
  validateSettingsPatch: validateSettingsPatch,
  emailPattern: emailPattern,
  preview: preview,
  pacing: pacing,
  runOnce: runOnce,
  runDue: runDue,
  status: status,
  startWorker: startWorker,
  stopWorker: stopWorker,
};
