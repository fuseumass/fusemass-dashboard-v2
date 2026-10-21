"use strict";

var mongoose = require("mongoose");

var Schema = mongoose.Schema;

// queued    waiting for its first or next attempt (or being sent right now,
//           which is when `lockedUntil` is in the future)
// sent      the SMTP server accepted it
// failed    gave up (out of attempts, or a permanent error) or was interrupted
//           mid-send; waits for an admin to resend it
// cancelled never sent on purpose: an admin cancelled it, or the recipient
//           unsubscribed from announcements while it waited
var EMAIL_STATUSES = ["queued", "sent", "failed", "cancelled"];

// transactional  always sent (decisions, QR codes, check-in, password links)
// announcement   bulk news; only for people who opted in, carries an
//                unsubscribe link
// test           an admin's own test send; never counts as a blast
var EMAIL_CATEGORIES = ["transactional", "announcement", "test"];

/**
 * One row per email the server tried (or still has to try) to send: the
 * outbox. Lets staff see failures, retry them and resend them without sending
 * anything twice.
 *
 * What is NOT stored, on purpose: attachments (the check-in QR image is drawn
 * again from the recipient's email at send time), passwords and single-use
 * links. Emails carrying a link like that (account setup, password reset) are
 * marked `redacted`: their placeholder values and body are never saved, so
 * they can't be retried from here either (an expired link is useless, and a
 * stored one would be a credential in the database).
 *
 * @typedef {object} EmailLog
 * @property {string} to - Recipient address (lowercase).
 * @property {string} templateKey - Template that was sent, or "password_reset" / "test_email".
 * @property {string} category - "transactional" | "announcement" | "test".
 * @property {ObjectId} [user] - Recipient's account, when they have one.
 * @property {string} status - "queued" | "sent" | "failed" | "cancelled".
 * @property {number} attempts - How many sends were started.
 * @property {number} maxAttempts - Attempts before the row is marked failed.
 * @property {string} lastError - Why the latest attempt failed ("" when it didn't).
 * @property {Date} [lastAttemptAt] - Start of the latest attempt.
 * @property {Date} [nextAttemptAt] - When a queued row is next due.
 * @property {Date} [lockedUntil] - Set while an attempt is in flight (a lease).
 * @property {Date} [sentAt] - When the SMTP server accepted it.
 * @property {string} [messageId] - The SMTP server's id for the message.
 * @property {string} subject - Rendered subject, for display.
 * @property {object} [values] - Template placeholder values, so a retry renders
 *   the same email. Absent on redacted rows.
 * @property {object} [options] - Extras a retry needs (calendar invite).
 * @property {boolean} redacted - Carries a single-use link; nothing stored.
 * @property {boolean} permanent - The last failure can't be fixed by retrying
 *   (bad address, rejected by the server).
 * @property {boolean} interrupted - The server stopped mid-send, so it may
 *   have been delivered. Never retried in bulk; only an admin's single resend.
 * @property {string} [batchId] - Groups the rows of one bulk send.
 * @property {string} [segment] - The bulk-send audience, for the duplicate guard.
 * @property {ObjectId} [resendOf] - The row this one re-sends.
 * @property {Date} [lastResentAt] - Guards against a double-clicked "send again".
 * @property {ObjectId} [requestedBy] - Admin who started a bulk send / resend.
 * @property {Date} expiresAt - The database deletes the row after this (TTL).
 */
var emailLogSchema = new Schema(
  {
    to: { type: String, required: true, trim: true, lowercase: true },
    templateKey: { type: String, required: true, trim: true },
    category: { type: String, enum: EMAIL_CATEGORIES, default: "transactional" },
    user: { type: Schema.Types.ObjectId, ref: "User" },
    status: { type: String, enum: EMAIL_STATUSES, default: "queued" },
    attempts: { type: Number, default: 0 },
    maxAttempts: { type: Number, default: 1 },
    lastError: { type: String, default: "" },
    lastAttemptAt: { type: Date },
    nextAttemptAt: { type: Date },
    lockedUntil: { type: Date },
    sentAt: { type: Date },
    messageId: { type: String },
    subject: { type: String, default: "" },
    values: { type: Schema.Types.Mixed },
    options: { type: Schema.Types.Mixed },
    redacted: { type: Boolean, default: false },
    permanent: { type: Boolean, default: false },
    interrupted: { type: Boolean, default: false },
    batchId: { type: String },
    segment: { type: String },
    resendOf: { type: Schema.Types.ObjectId, ref: "EmailLog" },
    lastResentAt: { type: Date },
    requestedBy: { type: Schema.Types.ObjectId, ref: "User" },
    // TTL: rows are deleted by the database (Cosmos DB for MongoDB supports
    // TTL indexes) once this passes. Pushed forward whenever the row changes,
    // so a row still being worked on is never deleted.
    expiresAt: { type: Date, index: { expireAfterSeconds: 0 } },
  },
  { timestamps: true }
);

// Indexes are deliberately few (the table is small and rows expire): the retry
// worker's query (queued rows that are due; `status` alone is its prefix, which
// also serves the admin's status filter and counts), the admin list newest
// first, and the TTL on `expiresAt` above.
emailLogSchema.index({ status: 1, nextAttemptAt: 1 });
emailLogSchema.index({ createdAt: -1 });

// Internal fields the admin list has no use for. The calendar invite in
// `options` can be large.
emailLogSchema.set("toJSON", {
  transform: function transform(_doc, ret) {
    ret.hasCalendarInvite = Boolean(ret.options && ret.options.icalEvent);
    delete ret.options;
    delete ret.__v;
    return ret;
  },
});

var EmailLog = mongoose.model("EmailLog", emailLogSchema);

EmailLog.STATUSES = EMAIL_STATUSES;
EmailLog.CATEGORIES = EMAIL_CATEGORIES;

module.exports = EmailLog;
