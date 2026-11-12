"use strict";

var mongoose = require("mongoose");

var Schema = mongoose.Schema;

// Where an announcement can go. Email goes through the outbox; the Discord
// channels are webhooks (DISCORD_ANNOUNCEMENTS_WEBHOOK_URL,
// DISCORD_WORKSHOPS_WEBHOOK_URL).
var CHANNELS = ["email", "discord_announcements", "discord_workshops"];

// scheduled  waiting for `scheduledFor` (the scheduler worker sends it)
// sending    claimed by one process, being sent right now
// sent       every channel was attempted (see `discord` and the outbox for details)
// failed     nothing could be sent, or the server stopped mid-send
// cancelled  staff cancelled it before it was sent
var STATUSES = ["scheduled", "sending", "sent", "failed", "cancelled"];

/**
 * A message staff sent (or scheduled) from the Communications page, to email
 * and/or Discord.
 *
 * @typedef {object} Announcement
 * @property {string} title - Email subject and Discord embed title (256 chars max).
 * @property {string} message - Email body: plain text with links.
 * @property {string} discordMessage - Discord text, with `@everyone`, `@here` and `@label` mentions (empty: older posts reuse `message`).
 * @property {string} discordTitle - Optional embed title for the Discord post.
 * @property {string} url - Optional link shown under the message.
 * @property {Array<string>} channels - Any of CHANNELS.
 * @property {object} audience - Email audience: `{ segment, workshop, checkedInOnly }`.
 * @property {string} audienceLabel - Human label of the audience, for history.
 * @property {boolean} mentionEveryone - Ping @everyone in Discord.
 * @property {string} status - One of STATUSES.
 * @property {Date} [scheduledFor] - When a scheduled one goes out.
 * @property {Date} [sentAt] - When sending started.
 * @property {Date} [lockedUntil] - Claim lease while sending.
 * @property {object} emailCounts - `{ inAudience, queued, skippedOptOut }`.
 * @property {Array<object>} discord - Per channel: `{ channel, status, messageId, error, attempts }`.
 * @property {string} error - Why it failed, when it did.
 * @property {ObjectId} createdBy - Staff member who wrote it.
 * @property {ObjectId} [cancelledBy] - Who cancelled it.
 * @property {ObjectId} [resendOf] - The announcement this one sends again.
 */
var announcementSchema = new Schema(
  {
    title: { type: String, required: true, trim: true, maxlength: 256 },
    message: { type: String, required: true, maxlength: 4096 },
    discordMessage: { type: String, default: "", maxlength: 4096 },
    discordTitle: { type: String, default: "", maxlength: 256 },
    url: { type: String, default: "" },
    channels: [{ type: String, enum: CHANNELS }],
    audience: {
      segment: { type: String, default: "" },
      workshop: { type: Schema.Types.ObjectId, ref: "Workshop" },
      checkedInOnly: { type: Boolean, default: false },
    },
    audienceLabel: { type: String, default: "" },
    mentionEveryone: { type: Boolean, default: false },
    status: { type: String, enum: STATUSES, default: "scheduled", index: true },
    scheduledFor: { type: Date },
    sentAt: { type: Date },
    lockedUntil: { type: Date },
    emailCounts: {
      inAudience: { type: Number, default: 0 },
      queued: { type: Number, default: 0 },
      skippedOptOut: { type: Number, default: 0 },
    },
    discord: [
      {
        _id: false,
        channel: { type: String, enum: CHANNELS },
        status: { type: String, enum: ["pending", "sent", "failed", "skipped"], default: "pending" },
        messageId: { type: String, default: "" },
        error: { type: String, default: "" },
        attempts: { type: Number, default: 0 },
      },
    ],
    error: { type: String, default: "" },
    createdBy: { type: Schema.Types.ObjectId, ref: "User" },
    cancelledBy: { type: Schema.Types.ObjectId, ref: "User" },
    resendOf: { type: Schema.Types.ObjectId, ref: "Announcement" },
  },
  { timestamps: true }
);

announcementSchema.index({ status: 1, scheduledFor: 1 });
announcementSchema.index({ createdAt: -1 });

var Announcement = mongoose.model("Announcement", announcementSchema);

Announcement.CHANNELS = CHANNELS;
Announcement.STATUSES = STATUSES;

module.exports = Announcement;
