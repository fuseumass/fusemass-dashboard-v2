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
 * @property {object} reminderEmail - `{ enabled, minutesBefore }`: email everyone signed up.
 * @property {object} reminderDiscord - `{ enabled, minutesBefore }`: post "starting soon" to the workshops channel.
 * @property {object} digestDiscord - `{ enabled, time, windowHours }`: daily post of upcoming workshops with spots.
 * @property {object} digestEmail - `{ enabled }`: the same list emailed to accepted participants who opted in (same time, at most daily).
 * @property {object} updatesDiscord - `{ enabled }`: post when a workshop is published or changes time or room.
 * @property {ObjectId} [updatedBy] - Last admin to change these.
 */
var communicationSettingsSchema = new Schema(
  {
    key: { type: String, default: "default", unique: true, enum: ["default"] },
    reminderEmail: {
      enabled: { type: Boolean, default: true },
      minutesBefore: { type: Number, default: 45, min: 5, max: 1440 },
    },
    reminderDiscord: {
      enabled: { type: Boolean, default: true },
      minutesBefore: { type: Number, default: 45, min: 5, max: 1440 },
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
