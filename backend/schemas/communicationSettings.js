"use strict";

var mongoose = require("mongoose");

var Schema = mongoose.Schema;

/**
 * Workshop automations on the Communications page (a singleton). Everything
 * is on by default except the email digest, but each one only runs while the
 * workshops module is on and its channel exists (email configured, the
 * Discord workshops webhook set).
 *
 * @typedef {object} CommunicationSettings
 * @property {string} key - Always "default".
 * @property {object} reminderAll - `{ discord, email, offsets }`: announce each published workshop to all accepted
 *   participants (Discord workshops channel and email) this many minutes before it starts. Default [120].
 * @property {object} reminderSignedUp - `{ email, discord, offsets }`: remind the people signed up this many minutes
 *   before. Default [45, 5], email only.
 * @property {Array<object>} discordTags - Saved role mentions `{ label, roleId }` writers can use as `@label`.
 * @property {object} workshopMention - `{ enabled, tag }`: ping a tag (a saved label, "everyone" or "here") in automated workshop posts.
 * @property {object} digestDiscord - `{ enabled, time, windowHours }`: daily post of upcoming workshops with spots.
 * @property {object} digestEmail - `{ enabled }`: the same list emailed to accepted participants who opted in (same time, at most daily).
 * @property {object} updatesDiscord - `{ enabled }`: post when a workshop is published or changes time or room.
 * @property {ObjectId} [updatedBy] - Last admin to change these.
 */
var communicationSettingsSchema = new Schema(
  {
    key: { type: String, default: "default", unique: true, enum: ["default"] },
    reminderAll: {
      discord: { type: Boolean, default: true },
      email: { type: Boolean, default: true },
      offsets: { type: [Number], default: [120] },
    },
    reminderSignedUp: {
      email: { type: Boolean, default: true },
      discord: { type: Boolean, default: false },
      offsets: { type: [Number], default: [45, 5] },
    },
    discordTags: {
      type: [{ _id: false, label: { type: String, required: true }, roleId: { type: String, required: true } }],
      default: [],
    },
    workshopMention: {
      enabled: { type: Boolean, default: false },
      tag: { type: String, default: "" },
    },
    digestDiscord: {
      enabled: { type: Boolean, default: true },
      // HH:MM in the event time zone (EVENT_TIMEZONE).
      time: { type: String, default: "09:00" },
      windowHours: { type: Number, default: 24, min: 1, max: 72 },
    },
    digestEmail: {
      enabled: { type: Boolean, default: false },
    },
    updatesDiscord: {
      enabled: { type: Boolean, default: true },
    },
    updatedBy: { type: Schema.Types.ObjectId, ref: "User" },
  },
  { timestamps: true }
);

/**
 * The settings document, created with the defaults the first time.
 * @returns {Promise<object>}
 */
communicationSettingsSchema.statics.getSingleton = function getSingleton() {
  return this.findOneAndUpdate(
    { key: "default" },
    { $setOnInsert: { key: "default" } },
    { new: true, upsert: true, setDefaultsOnInsert: true }
  );
};

module.exports = mongoose.model("CommunicationSettings", communicationSettingsSchema);
