"use strict";

var EmailLog = require("../schemas/emailLog");
var User = require("../schemas/user");

/**
 * The email outbox: a log row per email, plus retries.
 *
 * How a send works
 *   1. A row is written (`queued`, one attempt already claimed by this call).
 *   2. The send is tried right away. The caller's promise settles with that
 *      first attempt, exactly like before the outbox existed, so callers that
 *      await it (and tell staff) and callers that fire-and-forget both keep
 *      working.
 *   3. If it failed for a reason that might pass (SMTP blip, daily Gmail
 *      limit) the row stays `queued` with a `nextAttemptAt`, and the retry
 *      worker (an in-process interval, see startWorker) tries again with
 *      backoff. After `maxAttempts` it becomes `failed` and waits for an admin.
 *
 * No double sends: every attempt first *claims* the row with one atomic
 * update that only matches an unclaimed `queued` row, so the worker, a second
 * server instance and a double-clicked "resend" can never all send it. A claim
 * is a lease (`lockedUntil`). If a process dies mid-send the lease runs out and
 * the row is marked `failed` ("may have been delivered") rather than retried
 * automatically, because we can't know whether the message left.
 */

var DEFAULT_MAX_ATTEMPTS = 6;
// Wait after the 1st, 2nd, ... failed attempt. The last value repeats. A
// "daily limit exceeded" from Gmail needs hours, a network blip a minute.
var BACKOFF_MS = [60 * 1000, 5 * 60 * 1000, 30 * 60 * 1000, 2 * 60 * 60 * 1000, 6 * 60 * 60 * 1000];
// The transport gives up after about a minute (see mailer.buildTransport), so
// a healthy attempt is well inside this.
var LEASE_MS = 5 * 60 * 1000;
var DAY_MS = 24 * 60 * 60 * 1000;
var DEFAULT_RETENTION_DAYS = 90;
var DEFAULT_DAILY_LIMIT = 500; // a personal Gmail account
var DEFAULT_WORKER_INTERVAL_MS = 30 * 1000;
var RESEND_GUARD_MS = 30 * 1000;
var MAX_ERROR_LENGTH = 500;
// After this many transient failures in a row the worker pauses instead of
// burning one attempt of every queued email during an outage.
var BREAKER_THRESHOLD = 3;
var BREAKER_PAUSE_MS = 5 * 60 * 1000;
var MAX_PER_RUN = 2000;

// Anything that looks like a single-use link. Rows holding one are redacted.
var SECRET_PATTERN = /[?&]token=|\/reset-password/i;
var SENSITIVE_TEMPLATE_KEYS = ["account_setup", "password_reset"];
// A 5xx reply is normally permanent, but these mean "try later" or "fix the
// configuration", so retrying (or an admin's resend) can still help.
var QUOTA_PATTERN = /quota|limit|exceed|too many|rate|try again|temporar/i;
var AUTH_CODES = [530, 534, 535, 538];

var timer = null;
var draining = null;
var consecutiveFailures = 0;
var pausedUntil = 0;

/**
 * @returns {number} How long finished rows are kept, in milliseconds.
 */
function retentionMs() {
  var days = Number(process.env.EMAIL_LOG_RETENTION_DAYS);
  return (days > 0 ? days : DEFAULT_RETENTION_DAYS) * DAY_MS;
}

/**
 * @returns {Date} When a row touched now should be deleted by the TTL index.
 */
function expiry() {
  return new Date(Date.now() + retentionMs());
}

/**
 * Whether a value (a string or a plain object of placeholder values) holds a
 * single-use link such as a password-reset or account-setup URL.
 * @param {*} value - Anything.
 * @returns {boolean}
 */
function containsSecret(value) {
  if (value === undefined || value === null) {
    return false;
  }
  var text;
  try {
    text = typeof value === "string" ? value : JSON.stringify(value);
  } catch (err) {
    return true; // can't inspect it, so don't store it
  }
  return SECRET_PATTERN.test(text);
}

/**
 * Whether an email must not have its content stored.
 * @param {object} entry - `{ templateKey, values, sensitive }`.
 * @returns {boolean}
 */
function isSensitive(entry) {
  return (
    Boolean(entry.sensitive) ||
    SENSITIVE_TEMPLATE_KEYS.indexOf(entry.templateKey) !== -1 ||
    containsSecret(entry.values)
  );
}

/**
 * A short, token-free description of a send error, for the admin list.
 * @param {*} err - The error thrown by the transport.
 * @returns {string}
 */
function describeError(err) {
  var text = err && err.message ? String(err.message) : String(err || "Unknown error");
  text = text.replace(/(token=)[A-Za-z0-9_-]+/gi, "$1<redacted>");
  return text.length > MAX_ERROR_LENGTH ? text.slice(0, MAX_ERROR_LENGTH) + "…" : text;
}

/**
 * Whether retrying can never help: the server refused the address or the
 * message for good. Rate and quota replies, and authentication problems
 * (which an admin can fix in the configuration), are not permanent.
 * @param {*} err - The error thrown by the transport.
 * @returns {boolean}
 */
function isPermanentError(err) {
  if (!err) {
    return false;
  }
  if (err.code === "EENVELOPE") {
    return true; // invalid recipient or sender address
  }
  var code = Number(err.responseCode);
  if (code >= 500 && code < 600) {
    if (AUTH_CODES.indexOf(code) !== -1) {
      return false;
    }
    return !QUOTA_PATTERN.test(String(err.response || err.message || ""));
  }
  return false;
}

/**
 * @param {number} attempts - Attempts made so far (1 after the first).
 * @returns {number} Milliseconds to wait before the next attempt.
 */
function backoffMs(attempts) {
  return BACKOFF_MS[Math.min(Math.max(attempts, 1), BACKOFF_MS.length) - 1];
}

/**
 * A subject that is safe to store: omitted when it somehow contains a link.
 * @param {string} subject - Rendered subject.
 * @param {boolean} redacted - Whether the row is redacted.
 * @returns {string}
 */
function storableSubject(subject, redacted) {
  var text = String(subject || "");
  return redacted && containsSecret(text) ? "(hidden: contains a single-use link)" : text;
}

/**
 * Find the account an email address belongs to, without ever throwing.
 * @param {string} email - Recipient address.
 * @returns {Promise<*>} The user's _id, or null.
 */
function lookupUserId(email) {
  return User.findOne({ email: String(email || "").trim().toLowerCase() })
    .select("_id")
    .lean()
    .then(
      function afterFind(user) {
        return user ? user._id : null;
      },
      function onError() {
        return null;
      }
    );
}

/**
 * Build the stored fields shared by every new row.
 * @param {object} entry - See send().
 * @param {boolean} redacted - Whether to withhold content.
 * @returns {object}
 */
function baseDoc(entry, redacted) {
  var doc = {
    to: entry.to,
    templateKey: entry.templateKey,
    category: entry.category || "transactional",
    redacted: redacted,
    expiresAt: expiry(),
  };
  if (entry.requestedBy) {
    doc.requestedBy = entry.requestedBy;
  }
  if (entry.resendOf) {
    doc.resendOf = entry.resendOf;
  }
  if (entry.batchId) {
    doc.batchId = entry.batchId;
  }
  if (entry.segment) {
    doc.segment = entry.segment;
  }
  if (!redacted) {
    if (entry.values) {
      doc.values = entry.values;
    }
    if (entry.options && entry.options.icalEvent) {
      doc.options = { icalEvent: entry.options.icalEvent };
    }
  }
  return doc;
}

/**
 * Log an email and send it now. The returned promise settles with this first
 * attempt: it resolves when the message was accepted and rejects with the
 * transport's error when not, but the row is already queued for a retry by
 * then (unless `retry` is false, the email is sensitive, or the error is
 * permanent). If the log can't be written the email is still sent.
 *
 * @param {object} entry
 * @param {string} entry.to - Recipient address.
 * @param {string} entry.templateKey - Template key, or a label such as "password_reset".
 * @param {object} [entry.values] - Template placeholder values (stored so a retry renders the same email).
 * @param {object} [entry.options] - `{ icalEvent }` kept for retries.
 * @param {string} [entry.category] - "transactional" (default) | "announcement" | "test".
 * @param {*} [entry.user] - Recipient's user id; looked up by email when omitted.
 * @param {boolean} [entry.retry] - false: one attempt only (use when the caller reports the failure itself).
 * @param {boolean} [entry.sensitive] - Carries a single-use link: store no content, never retry.
 * @param {*} [entry.requestedBy] - Admin who triggered it.
 * @param {*} [entry.resendOf] - Row this re-sends.
 * @param {function} deliver - `(row) => Promise<{messageId, subject}>`; does the actual sending. May close over secrets.
 * @returns {Promise<void>}
 */
function send(entry, deliver) {
  var redacted = isSensitive(entry);
  var doc = baseDoc(entry, redacted);
  var now = Date.now();
  doc.status = "queued";
  doc.attempts = 1;
  doc.maxAttempts = redacted || entry.retry === false ? 1 : DEFAULT_MAX_ATTEMPTS;
  doc.lastAttemptAt = new Date(now);
  // Claimed from the start, so the retry worker can't pick it up while this
  // first attempt is still running.
  doc.lockedUntil = new Date(now + LEASE_MS);

  // Finding the recipient's account is only needed before the send when the
  // category depends on it (announcements check their consent and carry an
  // unsubscribe link built from the id). For everything else it happens
  // alongside the send, so the log adds as little delay as possible.
  var userPromise = entry.user ? Promise.resolve(entry.user) : lookupUserId(entry.to);
  var userFirst = (entry.category || "transactional") !== "transactional";

  return (userFirst ? userPromise : Promise.resolve(entry.user))
    .then(function afterUser(userId) {
      if (userId) {
        doc.user = userId;
      }
      return EmailLog.create(doc);
    })
    .then(
      function afterCreate(row) {
        return row;
      },
      function onLogError(err) {
        console.error("Could not write the email log (sending anyway):", err);
        return null;
      }
    )
    .then(function afterLog(row) {
      if (!row) {
        return Promise.resolve(deliver(null)).then(function noValue() {
          return undefined;
        });
      }
      var linked = row.user
        ? Promise.resolve()
        : userPromise
            .then(function link(userId) {
              return userId ? EmailLog.updateOne({ _id: row._id }, { $set: { user: userId } }) : undefined;
            })
            .catch(function ignore() {});
      return runDelivery(row, deliver).then(
        function sent() {
          return linked;
        },
        function failed(err) {
          return linked.then(function rethrow() {
            throw err;
          });
        }
      );
    });
}

/**
 * Record an email that could not even be attempted (email isn't configured),
 * so it shows up in the outbox and can be resent once it is. Never rejects.
 *
 * @param {object} entry - See send().
 * @param {string} message - Why nothing was sent.
 * @returns {Promise<void>}
 */
function recordUnsent(entry, message) {
  var redacted = isSensitive(entry);
  var doc = baseDoc(entry, redacted);
  doc.status = "failed";
  doc.attempts = 0;
  doc.maxAttempts = redacted || entry.retry === false ? 1 : DEFAULT_MAX_ATTEMPTS;
  doc.lastError = message;

  return (entry.user ? Promise.resolve(entry.user) : lookupUserId(entry.to))
    .then(function afterUser(userId) {
      if (userId) {
        doc.user = userId;
      }
      return EmailLog.create(doc);
    })
    .then(
      function done() {
        return undefined;
      },
      function onError(err) {
        console.error("Could not write the email log:", err);
        return undefined;
      }
    );
}

/**
 * Whether an announcement may still go to its recipient. Other categories
 * always may. Checked at send time, not only when queued, so someone who
 * unsubscribes while a blast is draining stops getting it.
 * @param {object} row - EmailLog document.
 * @returns {Promise<boolean>}
 */
function consentAllows(row) {
  if (row.category !== "announcement") {
    return Promise.resolve(true);
  }
  if (!row.user) {
    return Promise.resolve(false);
  }
  return User.findById(row.user)
    .select("marketingEmailConsent")
    .lean()
    .then(function afterFind(user) {
      return Boolean(user && user.marketingEmailConsent);
    });
}

/**
 * Run one claimed attempt and record the outcome. Resolves when the message
 * was sent or deliberately cancelled; rejects with the transport's error when
 * the attempt failed (after the failure is recorded).
 *
 * @param {object} row - An EmailLog document this call has claimed.
 * @param {function} deliver - `(row) => Promise<{messageId, subject}>`.
 * @returns {Promise<void>}
 */
function runDelivery(row, deliver) {
  return consentAllows(row).then(function afterConsent(allowed) {
    if (!allowed) {
      return finish(row, {
        status: "cancelled",
        lastError: "Not sent: the recipient hasn't opted in to announcements (or unsubscribed).",
        lockedUntil: null,
        nextAttemptAt: null,
      });
    }

    return Promise.resolve()
      .then(function attempt() {
        return deliver(row);
      })
      .then(
        function onSent(info) {
          consecutiveFailures = 0;
          return markSent(row, info);
        },
        function onFailed(err) {
          return markFailed(row, err).then(function rethrow() {
            throw err;
          });
        }
      );
  });
}

/**
 * Apply a status update to a row, logging (never throwing) database errors:
 * by now the email is already sent or already failed, and the caller must
 * hear about that rather than about a logging problem.
 * @param {object} row - EmailLog document.
 * @param {object} fields - Fields to set.
 * @returns {Promise<void>}
 */
function finish(row, fields) {
  var set = Object.assign({ expiresAt: expiry() }, fields);
  return EmailLog.updateOne({ _id: row._id }, { $set: set }).then(
    function done() {
      return undefined;
    },
    function onError(err) {
      console.error("Could not update the email log:", err);
      return undefined;
    }
  );
}

/**
 * @param {object} row - EmailLog document.
 * @param {object} info - `{ messageId, subject }` from deliver().
 * @returns {Promise<void>}
 */
function markSent(row, info) {
  var result = info || {};
  var fields = {
    status: "sent",
    sentAt: new Date(),
    subject: storableSubject(result.subject, row.redacted),
    lastError: "",
    permanent: false,
    interrupted: false,
    lockedUntil: null,
    nextAttemptAt: null,
  };
  if (result.messageId) {
    fields.messageId = String(result.messageId);
  }
  return finish(row, fields);
}

/**
 * Record a failed attempt: schedule the next one, or give up.
 * @param {object} row - EmailLog document (attempts already counts this one).
 * @param {*} err - What the transport threw.
 * @returns {Promise<void>}
 */
function markFailed(row, err) {
  var permanent = isPermanentError(err);
  var giveUp = permanent || Boolean(err && err.noRetry) || row.attempts >= row.maxAttempts;

  if (!permanent) {
    noteTransientFailure();
  }

  return finish(row, {
    status: giveUp ? "failed" : "queued",
    lastError: describeError(err),
    permanent: permanent,
    interrupted: false,
    lockedUntil: null,
    nextAttemptAt: giveUp ? null : new Date(Date.now() + backoffMs(row.attempts)),
  });
}

/**
 * Count a failure that isn't the recipient's fault; enough in a row pauses
 * the worker (the SMTP server is probably down or over its limit).
 * @returns {void}
 */
function noteTransientFailure() {
  consecutiveFailures += 1;
  if (consecutiveFailures >= BREAKER_THRESHOLD) {
    pausedUntil = Date.now() + BREAKER_PAUSE_MS;
    consecutiveFailures = 0;
  }
}

/**
 * Claim a queued, unclaimed row for one attempt. Atomic: of any number of
 * simultaneous callers exactly one gets the row, the rest get null.
 * @param {*} id - EmailLog _id.
 * @returns {Promise<object|null>} The row with `attempts` already counting this attempt.
 */
function claim(id) {
  var now = Date.now();
  return EmailLog.findOneAndUpdate(
    { _id: id, status: "queued", lockedUntil: null },
    {
      $set: { lockedUntil: new Date(now + LEASE_MS), lastAttemptAt: new Date(now) },
      $inc: { attempts: 1 },
    },
    { new: true }
  );
}

/**
 * Deliver a stored row (a retry): re-renders it from its template and values.
 * @param {object} row - EmailLog document.
 * @returns {Promise<{messageId: string, subject: string}>}
 */
function deliverStored(row) {
  // Required here, not at the top: mailer requires this module.
  return require("./mailer").deliverStored(row);
}

/**
 * Try one queued row now (claim, send, record). Never rejects: failures are
 * recorded on the row.
 * @param {*} id - EmailLog _id.
 * @returns {Promise<object|null>} The claimed row, or null when it wasn't claimable.
 */
function attemptStored(id) {
  return claim(id).then(function afterClaim(row) {
    if (!row) {
      return null;
    }
    return runDelivery(row, deliverStored).then(
      function ok() {
        return row;
      },
      function failed() {
        return row;
      }
    );
  });
}

/**
 * Rows whose lease ran out never reported back: the server stopped (or hung)
 * in the middle of the send. The message may or may not have gone, so these
 * are marked failed for an admin to look at instead of being sent again.
 * @returns {Promise<number>} How many rows were marked.
 */
function recoverInterrupted() {
  return EmailLog.updateMany(
    { status: "queued", lockedUntil: { $lt: new Date() } },
    {
      $set: {
        status: "failed",
        interrupted: true,
        lockedUntil: null,
        nextAttemptAt: null,
        lastError:
          "Interrupted while sending (the server restarted or the connection hung). It may have been delivered, so check before resending.",
        expiresAt: expiry(),
      },
    }
  ).then(function afterUpdate(result) {
    return result.modifiedCount || 0;
  });
}

/**
 * Send everything that is due, one email at a time. Only one run happens at a
 * time per process; a call made during a run joins it.
 *
 * @param {object} [options]
 * @param {boolean} [options.force] - Ignore the pause after repeated failures.
 * @returns {Promise<number>} How many emails were attempted.
 */
function processDue(options) {
  if (draining) {
    return draining;
  }
  var force = Boolean(options && options.force);

  draining = Promise.resolve()
    .then(function start() {
      // Required here for the same reason as deliverStored.
      if (!require("./mailer").isMailConfigured()) {
        return 0;
      }
      if (!force && Date.now() < pausedUntil) {
        return 0;
      }
      return recoverInterrupted().then(function afterRecover() {
        return drainLoop(force);
      });
    })
    .then(
      function done(count) {
        draining = null;
        return count;
      },
      function onError(err) {
        draining = null;
        console.error("Email outbox run failed:", err);
        return 0;
      }
    );
  return draining;
}

/**
 * @param {boolean} force - Ignore the failure pause.
 * @returns {Promise<number>} How many emails were attempted.
 */
function drainLoop(force) {
  var attempted = 0;

  function nextBatch() {
    if (attempted >= MAX_PER_RUN || (!force && Date.now() < pausedUntil)) {
      return Promise.resolve(attempted);
    }
    return EmailLog.find({ status: "queued", nextAttemptAt: { $lte: new Date() }, lockedUntil: null })
      .sort({ nextAttemptAt: 1 })
      .limit(25)
      .select("_id")
      .lean()
      .then(function afterFind(rows) {
        if (!rows.length) {
          return attempted;
        }
        var chain = Promise.resolve();
        rows.forEach(function each(row) {
          chain = chain.then(function one() {
            if (!force && Date.now() < pausedUntil) {
              return undefined;
            }
            return attemptStored(row._id).then(function counted(claimed) {
              if (claimed) {
                attempted += 1;
              }
            });
          });
        });
        return chain.then(nextBatch);
      });
  }

  return nextBatch();
}

/**
 * Run the due emails soon without making the caller wait (bulk sends).
 * @returns {void}
 */
function kick() {
  setImmediate(function run() {
    processDue().catch(function ignore() {});
  });
}

/**
 * Start the retry worker: an in-process interval (EMAIL_RETRY_INTERVAL_MS,
 * 30 s by default). It doesn't keep the process alive by itself.
 * @returns {void}
 */
function startWorker() {
  if (timer) {
    return;
  }
  var every = Number(process.env.EMAIL_RETRY_INTERVAL_MS) || DEFAULT_WORKER_INTERVAL_MS;
  timer = setInterval(function tick() {
    processDue().catch(function ignore() {});
  }, every);
  if (timer.unref) {
    timer.unref();
  }
  kick();
}

/**
 * Stop the retry worker (tests).
 * @returns {void}
 */
function stopWorker() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

/**
 * Forget recent failures so the worker isn't paused (tests).
 * @returns {void}
 */
function resetBreaker() {
  consecutiveFailures = 0;
  pausedUntil = 0;
}

/**
 * Queue emails for the worker, one row each (bulk sends). Nothing is sent
 * before this returns.
 *
 * @param {Array<object>} entries - Each `{ to, user, templateKey, values, category }`.
 * @param {object} meta
 * @param {string} meta.batchId - Groups the rows.
 * @param {string} [meta.segment] - Audience label.
 * @param {*} [meta.requestedBy] - Admin id.
 * @returns {Promise<number>} How many rows were queued.
 */
function enqueueMany(entries, meta) {
  var now = new Date();
  var docs = entries.map(function toDoc(entry) {
    if (isSensitive(entry)) {
      throw new Error("Emails with single-use links can't be queued in bulk.");
    }
    var doc = baseDoc(Object.assign({}, entry, meta), false);
    doc.user = entry.user;
    doc.status = "queued";
    doc.attempts = 0;
    doc.maxAttempts = DEFAULT_MAX_ATTEMPTS;
    doc.nextAttemptAt = now;
    return doc;
  });
  if (!docs.length) {
    return Promise.resolve(0);
  }
  return EmailLog.insertMany(docs).then(function afterInsert() {
    kick();
    return docs.length;
  });
}

/**
 * Put a failed row back in the queue and try it now. Atomic like every
 * attempt: a second click while the first is sending does nothing.
 *
 * @param {*} id - EmailLog _id of a `failed` or `queued` row.
 * @returns {Promise<object|null>} The row as it is after the attempt, or null
 *   when it couldn't be claimed (already sending, already sent, cancelled).
 */
function sendNow(id) {
  return recoverInterrupted()
    .then(function requeue() {
      return EmailLog.updateOne(
        { _id: id, status: "failed", redacted: { $ne: true } },
        {
          $set: {
            status: "queued",
            attempts: 0,
            maxAttempts: DEFAULT_MAX_ATTEMPTS,
            nextAttemptAt: new Date(),
            permanent: false,
            interrupted: false,
            expiresAt: expiry(),
          },
        }
      );
    })
    .then(function afterRequeue() {
      return attemptStored(id);
    })
    .then(function afterAttempt(claimed) {
      return claimed ? EmailLog.findById(id) : null;
    });
}

/**
 * Failed rows the admin's "retry all failed" may requeue. Rows that were
 * interrupted mid-send (they may already have been delivered), can never
 * succeed, or held a single-use link are left alone.
 *
 * @param {number} limit - Most rows to return.
 * @returns {Promise<Array<*>>} The _ids.
 */
function findRetryableFailed(limit) {
  return EmailLog.find({
    status: "failed",
    redacted: { $ne: true },
    permanent: { $ne: true },
    interrupted: { $ne: true },
  })
    .sort({ createdAt: 1 })
    .limit(limit)
    .select("_id")
    .lean()
    .then(function pickIds(rows) {
      return rows.map(function pick(row) {
        return row._id;
      });
    });
}

/**
 * Requeue the given failed rows with a fresh set of attempts, and start the
 * worker on them.
 * @param {Array<*>} ids - EmailLog _ids (see findRetryableFailed).
 * @returns {Promise<number>} How many were requeued.
 */
function requeueFailed(ids) {
  if (!ids.length) {
    return Promise.resolve(0);
  }
  return EmailLog.updateMany(
    { _id: { $in: ids }, status: "failed", redacted: { $ne: true } },
    {
      $set: {
        status: "queued",
        attempts: 0,
        maxAttempts: DEFAULT_MAX_ATTEMPTS,
        nextAttemptAt: new Date(),
        permanent: false,
        expiresAt: expiry(),
      },
    }
  ).then(function afterUpdate(result) {
    kick();
    return result.modifiedCount || 0;
  });
}

/**
 * Take a "send again" slot on an already-sent row: at most one per
 * RESEND_GUARD_MS, so a double click can't send two copies.
 * @param {*} id - EmailLog _id.
 * @returns {Promise<object|null>} The row, or null when the slot was taken.
 */
function takeResendSlot(id) {
  var now = Date.now();
  return EmailLog.findOneAndUpdate(
    {
      _id: id,
      status: "sent",
      redacted: { $ne: true },
      $or: [{ lastResentAt: null }, { lastResentAt: { $lt: new Date(now - RESEND_GUARD_MS) } }],
    },
    { $set: { lastResentAt: new Date(now) } },
    { new: true }
  );
}

/**
 * Cancel a queued row that isn't being sent right now.
 * @param {*} id - EmailLog _id.
 * @returns {Promise<object|null>} The cancelled row, or null.
 */
function cancelQueued(id) {
  return EmailLog.findOneAndUpdate(
    { _id: id, status: "queued", lockedUntil: null },
    { $set: { status: "cancelled", nextAttemptAt: null, lastError: "Cancelled by an admin.", expiresAt: expiry() } },
    { new: true }
  );
}

/**
 * Cancel every queued row that isn't being sent right now (optionally one batch).
 * @param {string} [batchId] - Only this bulk send.
 * @returns {Promise<number>} How many rows were cancelled.
 */
function cancelAllQueued(batchId) {
  var filter = { status: "queued", lockedUntil: null };
  if (batchId) {
    filter.batchId = String(batchId);
  }
  return EmailLog.updateMany(filter, {
    $set: { status: "cancelled", nextAttemptAt: null, lastError: "Cancelled by an admin.", expiresAt: expiry() },
  }).then(function afterUpdate(result) {
    return result.modifiedCount || 0;
  });
}

/**
 * @returns {number} Emails per rolling 24 hours the sending account allows
 *   (EMAIL_DAILY_LIMIT, default 500 for a personal Gmail account); 0 = no check.
 */
function dailyLimit() {
  var raw = process.env.EMAIL_DAILY_LIMIT;
  if (raw === undefined || raw === "" || Number.isNaN(Number(raw))) {
    return DEFAULT_DAILY_LIMIT;
  }
  return Math.max(0, Number(raw));
}

/**
 * Emails the server sent in the last 24 hours, plus those already queued.
 * @returns {Promise<number>}
 */
function committedInLastDay() {
  return Promise.all([
    EmailLog.countDocuments({ status: "sent", sentAt: { $gte: new Date(Date.now() - DAY_MS) } }),
    EmailLog.countDocuments({ status: "queued" }),
  ]).then(function sum(counts) {
    return counts[0] + counts[1];
  });
}

module.exports = {
  DEFAULT_MAX_ATTEMPTS: DEFAULT_MAX_ATTEMPTS,
  send: send,
  recordUnsent: recordUnsent,
  enqueueMany: enqueueMany,
  processDue: processDue,
  startWorker: startWorker,
  stopWorker: stopWorker,
  resetBreaker: resetBreaker,
  kick: kick,
  sendNow: sendNow,
  findRetryableFailed: findRetryableFailed,
  requeueFailed: requeueFailed,
  takeResendSlot: takeResendSlot,
  cancelQueued: cancelQueued,
  cancelAllQueued: cancelAllQueued,
  dailyLimit: dailyLimit,
  committedInLastDay: committedInLastDay,
  isPermanentError: isPermanentError,
  isSensitive: isSensitive,
  containsSecret: containsSecret,
  describeError: describeError,
};
