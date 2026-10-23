"use strict";

var crypto = require("crypto");
var mongoose = require("mongoose");
var EmailLog = require("../schemas/emailLog");
var EmailTemplate = require("../schemas/emailTemplate");
var User = require("../schemas/user");
var applicationStatus = require("../utils/applicationStatus");
var emailSegments = require("../utils/emailSegments");
var mailer = require("../utils/mailer");
var outbox = require("../utils/outbox");
var passwordToken = require("../utils/passwordToken");

// Most failed rows one "retry all" requeues.
var RETRY_ALL_LIMIT = 500;
// A second identical bulk send within this long is refused (a double click).
var DUPLICATE_BATCH_MS = 2 * 60 * 1000;
// Never bulk-send these: they need per-person values (a single-use link).
var NOT_BULK_SENDABLE = ["account_setup", "verify_email"];

/**
 * Escape a string for use inside a RegExp.
 * @param {string} text - Raw text.
 * @returns {string}
 */
function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * What the admin can do with a row: the label of the action behind the
 * "Resend" button, and what it needs.
 *
 *   retry     failed: put it back in the queue and send now
 *   send_now  queued (waiting for its next try): send now
 *   again     sent: send another copy (the admin must confirm)
 *   reissue   account setup: issue a fresh link, never the old one
 *   none      nothing to do (see `resendNote`)
 *
 * @param {object} row - EmailLog document.
 * @returns {{mode: string, note: (string|undefined)}}
 */
function resendMode(row) {
  var isSetupLink = row.templateKey === "account_setup";
  if (row.status === "cancelled") {
    return { mode: "none", note: "Cancelled emails aren't sent. Start a new send instead." };
  }
  if (row.redacted) {
    if (isSetupLink) {
      return { mode: "reissue" };
    }
    if (row.templateKey === "verify_email") {
      return {
        mode: "none",
        note: "Verification links can't be stored. The person can ask for a new one from the banner on their dashboard.",
      };
    }
    return {
      mode: "none",
      note: "Password links expire after an hour and can't be stored. Ask the person to use \"Forgot password\" again, or use Attendee help to send a fresh link.",
    };
  }
  if (row.status === "queued") {
    if (row.lockedUntil && row.lockedUntil > new Date()) {
      return { mode: "none", note: "It's being sent right now." };
    }
    return { mode: "send_now" };
  }
  if (row.status === "failed") {
    return { mode: "retry" };
  }
  return { mode: "again" };
}

/**
 * A row as the admin UI sees it.
 * @param {object} row - EmailLog document.
 * @returns {object}
 */
function serialize(row) {
  var json = row.toJSON();
  var action = resendMode(row);
  json.sending = row.status === "queued" && Boolean(row.lockedUntil) && row.lockedUntil > new Date();
  json.resendMode = action.mode;
  json.resendNote = action.note;
  delete json.lockedUntil;
  return json;
}

/**
 * Check a send against the sending account's daily limit.
 * @param {number} count - Emails about to be queued.
 * @param {object} body - Request body (`allowOverLimit`).
 * @returns {Promise<{limit: number, committed: number, over: boolean, blocked: boolean}>}
 */
function checkDailyLimit(count, body) {
  var limit = outbox.dailyLimit();
  return outbox.committedInLastDay().then(function afterCount(committed) {
    var over = limit > 0 && committed + count > limit;
    return { limit: limit, committed: committed, over: over, blocked: over && !(body && body.allowOverLimit === true) };
  });
}

/**
 * Answer 409 for a send that would pass the daily limit.
 * @param {object} res - Express response.
 * @param {number} count - Emails about to be queued.
 * @param {object} quota - From checkDailyLimit.
 * @returns {void}
 */
function sendOverLimit(res, count, quota) {
  res.status(409).json({
    error:
      "This would put you over the sending limit (" +
      quota.limit +
      " emails per 24 hours): " +
      quota.committed +
      " already sent or waiting plus " +
      count +
      " new. Send fewer, wait, or send anyway; the ones over the limit will fail and be retried later.",
    code: "OVER_DAILY_LIMIT",
    limit: quota.limit,
    committed: quota.committed,
    recipients: count,
  });
}

/**
 * GET /api/admin/outbox?status=&template=&q=&page=&limit=
 * The email log, newest first, with counts per status.
 *
 * `status`: queued | sent | failed | cancelled | retrying (queued and has
 * failed at least once).
 *
 * @param {object} req - Express request.
 * @param {object} res - Express response.
 * @returns {Promise<void>}
 */
function listOutbox(req, res) {
  var query = req.query || {};
  var filter = {};
  if (query.status === "retrying") {
    filter.status = "queued";
    filter.attempts = { $gt: 0 };
  } else if (EmailLog.STATUSES.indexOf(query.status) !== -1) {
    filter.status = query.status;
  }
  if (query.template) {
    filter.templateKey = String(query.template);
  }
  if (query.q && String(query.q).trim()) {
    filter.to = new RegExp(escapeRegExp(String(query.q).trim().toLowerCase()), "i");
  }
  var limit = Math.min(Math.max(parseInt(query.limit, 10) || 50, 1), 200);
  var page = Math.max(parseInt(query.page, 10) || 1, 1);

  return Promise.all([
    EmailLog.find(filter)
      // _id breaks ties between rows queued in the same millisecond, so pages
      // never repeat or skip a row.
      .sort({ createdAt: -1, _id: -1 })
      .skip((page - 1) * limit)
      .limit(limit),
    EmailLog.countDocuments(filter),
    EmailLog.countDocuments({ status: "queued" }),
    EmailLog.countDocuments({ status: "queued", attempts: { $gt: 0 } }),
    EmailLog.countDocuments({ status: "sent" }),
    EmailLog.countDocuments({ status: "failed" }),
    EmailLog.countDocuments({ status: "cancelled" }),
    outbox.committedInLastDay(),
  ])
    .then(function afterLoad(results) {
      res.status(200).json({
        emails: results[0].map(serialize),
        total: results[1],
        page: page,
        limit: limit,
        counts: {
          queued: results[2],
          retrying: results[3],
          sent: results[4],
          failed: results[5],
          cancelled: results[6],
        },
        committedLast24h: results[7],
        dailyLimit: outbox.dailyLimit(),
        smtpConfigured: mailer.isMailConfigured(),
      });
    })
    .catch(function onError(err) {
      console.error("listOutbox failed:", err);
      res.status(500).json({ error: "Could not load the email log." });
    });
}

/**
 * Load the row named by `:id`, or answer 404.
 * @param {object} req - Express request.
 * @param {object} res - Express response.
 * @returns {Promise<object|null>} The row, or null (404 already sent).
 */
function loadRow(req, res) {
  if (!mongoose.isValidObjectId(req.params.id)) {
    res.status(404).json({ error: "Email not found." });
    return Promise.resolve(null);
  }
  return EmailLog.findById(req.params.id).then(function afterFind(row) {
    if (!row) {
      res.status(404).json({ error: "Email not found." });
    }
    return row;
  });
}

/**
 * GET /api/admin/outbox/:id
 * One log row, with the placeholder values it was rendered from (never any
 * single-use link: those rows store none).
 * @param {object} req - Express request.
 * @param {object} res - Express response.
 * @returns {Promise<void>}
 */
function getOutboxEmail(req, res) {
  return loadRow(req, res)
    .then(function afterLoad(row) {
      if (row) {
        res.status(200).json({ email: serialize(row) });
      }
    })
    .catch(function onError(err) {
      console.error("getOutboxEmail failed:", err);
      res.status(500).json({ error: "Could not load the email." });
    });
}

/**
 * Answer a single resend: the row after the attempt, with 502 when it failed.
 * @param {object} res - Express response.
 * @param {object|null} row - The row as it is now.
 * @returns {void}
 */
function sendResendResult(res, row) {
  if (!row) {
    res.status(409).json({ error: "That email is already being sent, or can't be sent any more. Refresh the list." });
    return;
  }
  if (row.status === "sent") {
    res.status(200).json({ email: serialize(row), delivered: true });
    return;
  }
  var willRetry = row.status === "queued" && row.nextAttemptAt;
  res.status(502).json({
    error:
      "Could not send: " +
      (row.lastError || "unknown error") +
      (willRetry ? " It will be retried automatically." : ""),
    email: serialize(row),
    delivered: false,
  });
}

/**
 * Send a stored email to its recipient once more, as a new row (the original
 * stays as the record of the first send).
 * @param {object} row - A sent EmailLog document.
 * @param {object} admin - req.user.
 * @returns {Promise<object|null>} The new row.
 */
function sendCopy(row, admin) {
  var values = row.values && typeof row.values.toObject === "function" ? row.values.toObject() : row.values;
  return mailer
    .sendTemplateEmail(row.to, row.templateKey, Object.assign({}, values), {
      retry: false,
      category: row.category,
      userId: row.user,
      requestedBy: admin.id,
      resendOf: row._id,
      icalEvent: row.options && row.options.icalEvent,
    })
    .catch(function swallow() {
      // The failure is on the new row, which is what the admin is shown.
    })
    .then(function findNew() {
      return EmailLog.findOne({ resendOf: row._id }).sort({ createdAt: -1 });
    });
}

/**
 * Account-setup links are single-use and expire, so "resend" never repeats the
 * old one: it issues a new link (replacing the old) and sends that, but only
 * while the person still has no way to sign in.
 * @param {object} row - The account_setup EmailLog document.
 * @param {object} admin - req.user.
 * @returns {Promise<{row: (object|null), error: (string|undefined)}>}
 */
function reissueSetupLink(row, admin) {
  var userLookup = row.user ? User.findById(row.user) : User.findOne({ email: row.to });
  return userLookup.then(function afterUser(user) {
    if (!user) {
      return { error: "There's no account for that address any more." };
    }
    if (!passwordToken.needsPasswordSetup(user)) {
      return { error: "They've already set a password, so there's nothing to resend." };
    }
    return passwordToken.issuePasswordToken(user, passwordToken.SETUP_TTL_MS).then(function afterIssue(rawToken) {
      return mailer
        .sendTemplateEmail(
          user.email,
          "account_setup",
          { name: user.name, setupUrl: passwordToken.passwordLink(rawToken, { setup: true }) },
          { retry: false, userId: user._id, requestedBy: admin.id, resendOf: row._id }
        )
        .catch(function swallow() {})
        .then(function findNew() {
          return EmailLog.findOne({ resendOf: row._id }).sort({ createdAt: -1 });
        })
        .then(function afterSend(newRow) {
          if (newRow && newRow.status === "sent" && row.status === "failed") {
            // The failed row is dealt with; keep it out of the failures list.
            return EmailLog.updateOne(
              { _id: row._id, status: "failed" },
              { $set: { status: "cancelled", lastError: "Replaced by a newly issued link." } }
            ).then(function done() {
              return { row: newRow };
            });
          }
          return { row: newRow };
        });
    });
  });
}

/**
 * POST /api/admin/outbox/:id/resend   Body: { again?: boolean }
 * Resend one email. A failed or waiting email is retried (the same row, with
 * a fresh set of attempts). One that already went out is only sent again with
 * `again: true`, as a new row. Links to set or reset a password are never
 * repeated: an account-setup link is re-issued, a password reset is refused.
 * @param {object} req - Express request.
 * @param {object} res - Express response.
 * @returns {Promise<void>}
 */
function resendEmail(req, res) {
  if (!mailer.isMailConfigured()) {
    res.status(503).json({ error: "Email isn't configured on the server (SMTP_HOST / SMTP_USER)." });
    return Promise.resolve();
  }

  var again = Boolean(req.body && req.body.again === true);

  return loadRow(req, res)
    .then(function afterLoad(row) {
      if (!row) {
        return undefined;
      }
      var action = resendMode(row);

      if (action.mode === "none") {
        res.status(409).json({ error: action.note });
        return undefined;
      }

      if (action.mode === "retry" || action.mode === "send_now") {
        return outbox.sendNow(row._id).then(function afterSend(updated) {
          sendResendResult(res, updated);
        });
      }

      // The email already went out (status sent): sending another copy needs a
      // yes, because the person will get it twice.
      if (row.status === "sent" && !again) {
        res.status(409).json({
          error:
            "This email was already sent" +
            (row.sentAt ? " on " + row.sentAt.toISOString() : "") +
            ". Send it again only if they didn't get it.",
          code: "ALREADY_SENT",
          sentAt: row.sentAt,
        });
        return undefined;
      }

      if (action.mode === "reissue") {
        return reissueSetupLink(row, req.user).then(function afterReissue(result) {
          if (result.error) {
            res.status(409).json({ error: result.error });
            return;
          }
          sendResendResult(res, result.row);
        });
      }

      return outbox.takeResendSlot(row._id).then(function afterSlot(slot) {
        if (!slot) {
          res.status(409).json({ error: "That email was just sent again. Refresh the list." });
          return undefined;
        }
        return sendCopy(row, req.user).then(function afterCopy(copy) {
          sendResendResult(res, copy);
        });
      });
    })
    .catch(function onError(err) {
      console.error("resendEmail failed:", err);
      if (!res.headersSent) {
        res.status(500).json({ error: "Could not resend the email." });
      }
    });
}

/**
 * Failed account-setup emails worth another go: the error wasn't permanent
 * and the person still can't sign in. Their old link is never resent; each
 * gets a fresh one (reissueSetupLink).
 * @param {number} limit - Most rows to return.
 * @returns {Promise<object[]>} EmailLog documents.
 */
function findReissuableSetupLinks(limit) {
  return EmailLog.find({
    status: "failed",
    templateKey: "account_setup",
    permanent: { $ne: true },
  })
    .sort({ createdAt: 1 })
    .limit(limit);
}

/**
 * Reissue setup links one after another (each send is paced by the mailer).
 * @param {object[]} rows - Failed account_setup rows.
 * @param {object} admin - req.user.
 * @returns {Promise<number>} How many new links went out.
 */
function reissueAll(rows, admin) {
  var sent = 0;
  return rows
    .reduce(function chain(previous, row) {
      return previous.then(function next() {
        return reissueSetupLink(row, admin).then(function afterReissue(result) {
          if (result.row && result.row.status === "sent") {
            sent += 1;
          } else if (result.error) {
            // Already signed in or account gone: nothing to resend, so take
            // it off the failures list.
            return EmailLog.updateOne(
              { _id: row._id, status: "failed" },
              { $set: { status: "cancelled", lastError: result.error } }
            );
          }
          return undefined;
        });
      });
    }, Promise.resolve())
    .then(function done() {
      return sent;
    });
}

/**
 * POST /api/admin/outbox/retry-failed   Body: { dryRun?, allowOverLimit? }
 * Put every failed email that is worth retrying back in the queue (not
 * permanent errors, interrupted sends or single-use links), and send a fresh
 * account-setup link in place of each setup email that failed for a
 * temporary reason.
 * @param {object} req - Express request.
 * @param {object} res - Express response.
 * @returns {Promise<void>}
 */
function retryFailed(req, res) {
  var body = req.body || {};
  if (!mailer.isMailConfigured() && body.dryRun !== true) {
    res.status(503).json({ error: "Email isn't configured on the server (SMTP_HOST / SMTP_USER)." });
    return Promise.resolve();
  }

  return Promise.all([outbox.findRetryableFailed(RETRY_ALL_LIMIT), findReissuableSetupLinks(RETRY_ALL_LIMIT)])
    .then(function afterFind(found) {
      var ids = found[0];
      var setupRows = found[1];
      var total = ids.length + setupRows.length;
      return checkDailyLimit(total, body).then(function afterQuota(quota) {
        if (body.dryRun === true) {
          res.status(200).json({
            dryRun: true,
            requeued: 0,
            wouldRequeue: ids.length,
            wouldReissue: setupRows.length,
            overLimit: quota.over,
          });
          return undefined;
        }
        if (quota.blocked) {
          sendOverLimit(res, total, quota);
          return undefined;
        }
        return outbox.requeueFailed(ids).then(function afterRequeue(count) {
          return reissueAll(setupRows, req.user).then(function afterReissue(reissued) {
            res.status(200).json({ requeued: count, reissued: reissued });
          });
        });
      });
    })
    .catch(function onError(err) {
      console.error("retryFailed failed:", err);
      res.status(500).json({ error: "Could not requeue the failed emails." });
    });
}

/**
 * POST /api/admin/outbox/:id/cancel
 * Stop a queued email (one waiting for a retry, or part of a bulk send).
 * @param {object} req - Express request.
 * @param {object} res - Express response.
 * @returns {Promise<void>}
 */
function cancelEmail(req, res) {
  return loadRow(req, res)
    .then(function afterLoad(row) {
      if (!row) {
        return undefined;
      }
      return outbox.cancelQueued(row._id).then(function afterCancel(cancelled) {
        if (!cancelled) {
          res.status(409).json({ error: "Only an email that is waiting to be sent can be cancelled." });
          return;
        }
        res.status(200).json({ email: serialize(cancelled) });
      });
    })
    .catch(function onError(err) {
      console.error("cancelEmail failed:", err);
      res.status(500).json({ error: "Could not cancel the email." });
    });
}

/**
 * POST /api/admin/outbox/cancel-queued   Body: { batchId? }
 * Stop every email still waiting to be sent, or just one bulk send's (the
 * "oops, wrong template" button).
 * @param {object} req - Express request.
 * @param {object} res - Express response.
 * @returns {Promise<void>}
 */
function cancelQueued(req, res) {
  var batchId = req.body && req.body.batchId ? String(req.body.batchId) : "";
  return outbox
    .cancelAllQueued(batchId)
    .then(function afterCancel(count) {
      res.status(200).json({ cancelled: count });
    })
    .catch(function onError(err) {
      console.error("cancelQueued failed:", err);
      res.status(500).json({ error: "Could not cancel the queued emails." });
    });
}

/**
 * GET /api/admin/outbox/segments
 * Who a bulk email can go to, and the sending limit.
 * @param {object} _req - Express request.
 * @param {object} res - Express response.
 * @returns {Promise<void>}
 */
function listSegments(_req, res) {
  return outbox
    .committedInLastDay()
    .then(function afterCount(committed) {
      res.status(200).json({
        segments: emailSegments.list(),
        committedLast24h: committed,
        dailyLimit: outbox.dailyLimit(),
      });
    })
    .catch(function onError(err) {
      console.error("listSegments failed:", err);
      res.status(500).json({ error: "Could not load the segments." });
    });
}

/**
 * Resolve a segment into the emails to queue, and queue them (or just count).
 *
 * @param {object} req - Express request (admin).
 * @param {object} res - Express response.
 * @param {object} plan
 * @param {string} plan.segmentKey - Audience key.
 * @param {string} plan.templateKey - Template to send.
 * @param {string} plan.category - "announcement" | "transactional".
 * @param {boolean} plan.skipAlreadySent - Leave out people who already got this template.
 * @returns {Promise<void>}
 */
function runBulk(req, res, plan) {
  var body = req.body || {};
  var segment = emailSegments.find(plan.segmentKey);
  if (!segment) {
    res.status(400).json({ error: "Unknown segment." });
    return Promise.resolve();
  }
  if (segment.available === false) {
    res.status(400).json({ error: segment.reason || "That segment isn't available yet." });
    return Promise.resolve();
  }
  if (NOT_BULK_SENDABLE.indexOf(plan.templateKey) !== -1) {
    res.status(400).json({ error: "That template needs a personal link and can't be sent in bulk." });
    return Promise.resolve();
  }
  if (body.round && !mongoose.isValidObjectId(body.round)) {
    res.status(400).json({ error: "Unknown round." });
    return Promise.resolve();
  }
  var dryRun = body.dryRun === true;
  if (!dryRun && !mailer.isMailConfigured()) {
    res.status(503).json({ error: "Email isn't configured on the server (SMTP_HOST / SMTP_USER)." });
    return Promise.resolve();
  }

  // "Test: just me" goes to the admin alone, whatever they've opted into.
  var category = segment.test ? "test" : plan.category;
  var warnings = [];

  return EmailTemplate.findOne({ key: plan.templateKey })
    .then(function afterTemplate(template) {
      if (!template) {
        res.status(404).json({ error: "No email template with that key." });
        return undefined;
      }
      if (plan.templateKey === "application_accepted" && !mailer.usesQrCode(template.body)) {
        warnings.push("The acceptance template no longer contains {{qrcode}}, so these emails won't include the check-in QR code.");
      }
      return emailSegments
        .resolve(segment, { round: body.round || null, adminId: req.user.id })
        .then(function afterResolve(recipients) {
          var eligible = category === "announcement" ? recipients.filter(isOptedIn) : recipients;
          var skippedNoConsent = recipients.length - eligible.length;

          var alreadySentStep = plan.skipAlreadySent
            ? EmailLog.distinct("to", { templateKey: plan.templateKey, status: "sent" })
            : Promise.resolve([]);
          return alreadySentStep.then(function afterSent(alreadySentTo) {
            var sentSet = {};
            alreadySentTo.forEach(function mark(address) {
              sentSet[address] = true;
            });
            var toSend = eligible.filter(function notSent(recipient) {
              return !sentSet[recipient.email];
            });
            var skippedAlreadySent = eligible.length - toSend.length;

            return checkDailyLimit(toSend.length, body).then(function afterQuota(quota) {
              var summary = {
                segment: segment.key,
                templateKey: plan.templateKey,
                category: category,
                inSegment: recipients.length,
                recipients: toSend.length,
                skippedNoConsent: skippedNoConsent,
                skippedAlreadySent: skippedAlreadySent,
                committedLast24h: quota.committed,
                dailyLimit: quota.limit,
                overLimit: quota.over,
                warnings: warnings,
              };
              if (dryRun) {
                res.status(200).json(Object.assign({ dryRun: true, queued: 0 }, summary));
                return undefined;
              }
              if (!toSend.length) {
                res.status(200).json(Object.assign({ queued: 0 }, summary));
                return undefined;
              }
              if (quota.blocked) {
                sendOverLimit(res, toSend.length, quota);
                return undefined;
              }
              return recentDuplicate(segment, plan.templateKey, category).then(function afterDuplicate(duplicate) {
                if (duplicate) {
                  res.status(409).json({
                    error: "That exact send was queued a moment ago. Check the outbox before sending it again.",
                    code: "DUPLICATE_SEND",
                  });
                  return undefined;
                }
                var batchId = crypto.randomBytes(8).toString("hex");
                var entries = toSend.map(function toEntry(recipient) {
                  return {
                    to: recipient.email,
                    user: recipient.userId,
                    templateKey: plan.templateKey,
                    category: category,
                    values: { name: recipient.name, status: statusFor(segment) },
                  };
                });
                return outbox
                  .enqueueMany(entries, { batchId: batchId, segment: segment.key, requestedBy: req.user.id })
                  .then(function afterQueue(queued) {
                    res.status(200).json(Object.assign({ queued: queued, batchId: batchId }, summary));
                  });
              });
            });
          });
        });
    })
    .catch(function onError(err) {
      console.error("bulk email failed:", err);
      if (!res.headersSent) {
        res.status(500).json({ error: "Could not queue the emails." });
      }
    });
}

/**
 * @param {object} recipient - From emailSegments.
 * @returns {boolean} Whether they opted in to announcements.
 */
function isOptedIn(recipient) {
  return recipient.consent === true;
}

/**
 * The value for {{status}}: the application status the segment is about.
 * @param {object} segment - Segment definition.
 * @returns {string}
 */
function statusFor(segment) {
  return applicationStatus.APPLICATION_STATUSES.indexOf(segment.key) !== -1 ? segment.key : "";
}

/**
 * Whether the same send (audience + template) was queued within the last
 * couple of minutes. Test sends to yourself are exempt.
 * @param {object} segment - Segment definition.
 * @param {string} templateKey - Template key.
 * @param {string} category - Email category.
 * @returns {Promise<boolean>}
 */
function recentDuplicate(segment, templateKey, category) {
  if (segment.test) {
    return Promise.resolve(false);
  }
  return EmailLog.exists({
    segment: segment.key,
    templateKey: templateKey,
    category: category,
    createdAt: { $gte: new Date(Date.now() - DUPLICATE_BATCH_MS) },
  }).then(Boolean);
}

/**
 * POST /api/admin/outbox/bulk
 * Body: { segment, templateKey, category?, round?, dryRun?, allowOverLimit?, skipAlreadySent? }
 *
 * Email an audience using a stored template ({{name}} and {{status}} are
 * filled in per person). `category` is "announcement" (the default: only
 * people who opted in, with an unsubscribe link) or "transactional" (everyone
 * in the segment; use it for things they need, not news). With `dryRun` it
 * only counts. The emails are queued and sent in the background, one at a
 * time; cancel them with POST /api/admin/outbox/cancel-queued.
 *
 * @param {object} req - Express request.
 * @param {object} res - Express response.
 * @returns {Promise<void>}
 */
function bulkSend(req, res) {
  var body = req.body || {};
  return runBulk(req, res, {
    segmentKey: String(body.segment || ""),
    templateKey: String(body.templateKey || ""),
    category: body.category === "transactional" ? "transactional" : "announcement",
    skipAlreadySent: body.skipAlreadySent === true,
  });
}

/**
 * POST /api/admin/outbox/resend-acceptance   Body: { dryRun?, includeAlreadySent?, allowOverLimit?, round? }
 * Email every accepted applicant their acceptance email (with the check-in QR
 * code) again, for people accepted before QR codes shipped or while email was
 * down. Anyone the outbox already shows a sent acceptance email for is
 * skipped unless `includeAlreadySent` is true.
 * @param {object} req - Express request.
 * @param {object} res - Express response.
 * @returns {Promise<void>}
 */
function resendAcceptance(req, res) {
  var body = req.body || {};
  return runBulk(req, res, {
    segmentKey: "accepted",
    templateKey: "application_accepted",
    category: "transactional",
    skipAlreadySent: body.includeAlreadySent !== true,
  });
}

module.exports = {
  listOutbox: listOutbox,
  getOutboxEmail: getOutboxEmail,
  resendEmail: resendEmail,
  retryFailed: retryFailed,
  cancelEmail: cancelEmail,
  cancelQueued: cancelQueued,
  listSegments: listSegments,
  bulkSend: bulkSend,
  resendAcceptance: resendAcceptance,
};
