"use strict";

var mongoose = require("mongoose");

var Schema = mongoose.Schema;

/**
 * One dashboard override of a server environment variable (Technical settings).
 * Secret values are stored encrypted (see utils/systemConfig); everything else
 * is stored as written.
 *
 * @typedef {object} SystemSetting
 * @property {string} key - Env var name, e.g. "SMTP_HOST". Unique.
 * @property {string} value - The value, or "v1:iv:tag:ciphertext" for secrets.
 * @property {boolean} encrypted - True when `value` is ciphertext.
 * @property {import("mongoose").Types.ObjectId} [updatedBy] - Admin who saved it.
 * @property {Date} updatedAt - When it was last saved.
 */

var systemSettingSchema = new Schema({
  key: { type: String, required: true, unique: true, trim: true },
  value: { type: String, default: "" },
  encrypted: { type: Boolean, default: false },
  updatedBy: { type: Schema.Types.ObjectId, ref: "User" },
}, {
  timestamps: true,
  toJSON: {
    transform: function redact(_doc, ret) {
      delete ret.value;
      return ret;
    },
  },
});

module.exports = mongoose.model("SystemSetting", systemSettingSchema);
