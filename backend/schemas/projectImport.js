"use strict";
var mongoose = require("mongoose");
/**
 * @typedef {object} ProjectImportAttrs
 * @property {object} createdBy - Uploading User id.
 * @property {Date} expiresAt - Preview expires after 30 minutes.
 * @property {Date} consumedAt - Atomic confirmation claim; prevents replay.
 * @property {object} preview - Immutable parsed, matched snapshot.
 */
var schema = new mongoose.Schema(
  {
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    expiresAt: { type: Date, required: true },
    consumedAt: Date,
    preview: { type: mongoose.Schema.Types.Mixed, required: true },
  },
  { timestamps: true },
);
schema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
module.exports = mongoose.model("ProjectImport", schema);
