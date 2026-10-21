"use strict";

var util = require("util");
var primaryClientOrigin = require("./clientOrigin").primaryClientOrigin;

/**
 * Discord webhook notifications, both optional (unset env var = off):
 *   DISCORD_ERROR_WEBHOOK_URL         every server error (see installErrorReporting)
 *   DISCORD_APPLICATIONS_WEBHOOK_URL  every submitted application
 *
 * Posting never throws and never delays a response: a Discord outage must
 * not break the dashboard. Webhook URLs are secrets (anyone holding one can
 * post to the channel), so they live only in the environment.
 */

// Discord allows 2000 characters per message; leave room for the wrapper.
var MAX_DETAIL = 1800;
// Error posts allowed per minute. A failure loop can't flood the channel or
// hit Discord's own webhook rate limit; the rest are counted and summarized.
var ERROR_BURST = 10;
var WINDOW_MS = 60 * 1000;
var POST_TIMEOUT_MS = 5000;

// The real console.error, kept so this module's own failures are never
// reported back to Discord (which could loop).
var originalConsoleError = console.error;
var throttle = { windowStart: 0, sent: 0, suppressed: 0 };

/**
 * Remove things that must not leave the server: email addresses (e.g. in
 * duplicate-key errors), credentials in connection strings, bearer tokens /
 * JWTs, and account keys or passwords in key=value form.
 *
 * @param {string} text - Raw text.
 * @returns {string} The text with sensitive values replaced.
 */
function scrub(text) {
  return String(text)
    .replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+:[^\s/@]+@/gi, "$1<credentials>@")
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "<email>")
    .replace(/Bearer\s+[A-Za-z0-9._~+/-]+=*/gi, "Bearer <token>")
    .replace(/eyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]+/g, "<jwt>")
    .replace(/((?:AccountKey|password|pass|secret|token)\s*[=:]\s*)[^\s;&"',]+/gi, "$1<redacted>");
}

/**
 * POST a message to a webhook. Resolves either way; failures are logged
 * locally only.
 *
 * @param {string} url - Webhook URL.
 * @param {string} content - Message text.
 * @returns {Promise<void>}
 */
function post(url, content) {
  return Promise.resolve()
    .then(function send() {
      return fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // Never ping anyone, whatever an applicant typed as their name.
        body: JSON.stringify({ content: content, allowed_mentions: { parse: [] } }),
        signal: AbortSignal.timeout(POST_TIMEOUT_MS),
      });
    })
    .then(function afterSend(res) {
      if (res && !res.ok) {
        originalConsoleError("Discord webhook answered " + res.status + ".");
      }
    })
    .catch(function onError(err) {
      originalConsoleError("Discord webhook failed:", err && err.message);
    });
}

/**
 * Report a server error to the errors webhook (rate limited, scrubbed).
 *
 * @param {string} context - Where it happened, e.g. "GET /api/admin/rounds".
 * @param {*} [err] - The error (or any value) to describe.
 * @returns {Promise<void>}
 */
function reportError(context, err) {
  var url = process.env.DISCORD_ERROR_WEBHOOK_URL;
  if (!url) {
    return Promise.resolve();
  }

  var now = Date.now();
  var note = "";
  if (now - throttle.windowStart >= WINDOW_MS) {
    if (throttle.suppressed) {
      note = "\n(" + throttle.suppressed + " more errors were not posted in the previous minute.)";
    }
    throttle = { windowStart: now, sent: 0, suppressed: 0 };
  }
  if (throttle.sent >= ERROR_BURST) {
    throttle.suppressed += 1;
    return Promise.resolve();
  }
  throttle.sent += 1;

  var detail = err === undefined ? "" : err instanceof Error ? err.stack || err.message : util.inspect(err, { depth: 3 });
  var body = scrub(context + (detail ? "\n" + detail : ""));
  if (body.length > MAX_DETAIL) {
    body = body.slice(0, MAX_DETAIL) + "\n…";
  }
  var env = process.env.NODE_ENV || "development";
  return post(url, "🚨 **Server error** (" + env + ")\n```\n" + body.replace(/```/g, "'''") + "\n```" + note);
}

/**
 * Route every server error to the errors webhook:
 *   - console.error, which the controllers use for every failure they catch;
 *   - unhandled promise rejections;
 *   - uncaught exceptions (reported, then the process exits so systemd
 *     restarts it, as it would without this handler).
 * Safe to call more than once. A no-op for Discord while the env var is unset.
 *
 * @returns {void}
 */
function installErrorReporting() {
  if (console.error.isDiscordReporter) {
    return;
  }
  var reporting = function consoleErrorToDiscord() {
    originalConsoleError.apply(console, arguments);
    reportError(util.format.apply(util, arguments));
  };
  reporting.isDiscordReporter = true;
  console.error = reporting;

  process.on("unhandledRejection", function onUnhandledRejection(reason) {
    console.error("Unhandled promise rejection:", reason);
  });
  process.on("uncaughtException", function onUncaughtException(err) {
    originalConsoleError("Uncaught exception:", err);
    reportError("Uncaught exception (the server is restarting)", err).finally(function exit() {
      process.exit(1);
    });
  });
}

/**
 * Post a newly submitted application to the applications webhook. Names the
 * applicant and their school (no contact details) and links to the review
 * page.
 *
 * @param {object} application - The Application document.
 * @param {object} info
 * @param {string} [info.roundName] - The round it was submitted to.
 * @param {boolean} [info.withoutAccount] - Submitted without logging in.
 * @param {number} [info.totalInRound] - Submitted applications in the round so far.
 * @returns {Promise<void>}
 */
function notifyApplication(application, info) {
  var url = process.env.DISCORD_APPLICATIONS_WEBHOOK_URL;
  if (!url) {
    return Promise.resolve();
  }
  var opts = info || {};
  var clientOrigin = primaryClientOrigin();
  var lines = [
    "📝 **New application:** " + (application.name || "(no name)") + (application.university ? " — " + application.university : ""),
    [
      opts.roundName ? "Round: " + opts.roundName : null,
      opts.withoutAccount ? "applied without an account" : "applied from their account",
      opts.totalInRound ? "#" + opts.totalInRound + " in this round" : null,
    ]
      .filter(Boolean)
      .join(" · "),
    "Review: " + clientOrigin + "/dashboard/admin",
  ];
  return post(url, lines.join("\n").slice(0, 1990));
}

/**
 * Forget the error rate-limit window (tests only).
 * @returns {void}
 */
function resetThrottleForTests() {
  throttle = { windowStart: 0, sent: 0, suppressed: 0 };
}

module.exports = {
  ERROR_BURST: ERROR_BURST,
  scrub: scrub,
  reportError: reportError,
  installErrorReporting: installErrorReporting,
  notifyApplication: notifyApplication,
  resetThrottleForTests: resetThrottleForTests,
};
