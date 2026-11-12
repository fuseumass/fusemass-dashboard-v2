"use strict";

var mongoose = require("mongoose");

var Schema = mongoose.Schema;

/**
 * One row per thing a communications automation did (or claimed), keyed so
 * it can only ever happen once: a workshop reminder email to one person for
 * one start time, one Discord "starting soon" post, one daily digest. The
 * scheduler inserts the row *before* sending; the unique index on `key` makes
 * that insert the claim, so two server processes (or a restart) never send
 * twice. A workshop that moves gets new keys (they contain the start time),
 * so its reminders are sent again for the new time.
 *
 * @typedef {object} AutomationLog
 * @property {string} key - Unique claim key, e.g. "workshop_reminder_email:<workshop>:<startsAt>:<user>".
 * @property {string} kind - workshop_reminder_email | workshop_reminder_discord |
 *   workshop_digest_discord | workshop_digest_email | workshop_update_discord.
 * @property {ObjectId} [workshop] - The workshop it was about.
 * @property {ObjectId} [user] - The recipient, for emails.
 * @property {Date} [scheduledFor] - When it was due.
 * @property {string} status - claimed | sent | failed | skipped.
 * @property {string} error - What went wrong.
 * @property {string} messageId - Discord message id.
 */
var automationLogSchema = new Schema(
  {
    key: { type: String, required: true, unique: true },
    kind: { type: String, required: true },
    workshop: { type: Schema.Types.ObjectId, ref: "Workshop" },
    user: { type: Schema.Types.ObjectId, ref: "User" },
    scheduledFor: { type: Date },
    status: { type: String, enum: ["claimed", "sent", "failed", "skipped"], default: "claimed" },
    error: { type: String, default: "" },
    messageId: { type: String, default: "" },
  },
  { timestamps: true }
);

automationLogSchema.index({ workshop: 1, kind: 1 });
automationLogSchema.index({ createdAt: -1 });

module.exports = mongoose.model("AutomationLog", automationLogSchema);
