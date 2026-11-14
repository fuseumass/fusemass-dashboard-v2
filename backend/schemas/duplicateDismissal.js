"use strict";

var mongoose = require("mongoose");

var Schema = mongoose.Schema;

/**
 * Staff decided two applications are not duplicates of each other, so the
 * "possible duplicates" view stops suggesting the pair.
 *
 * The two ids are stored in sorted order (`a` < `b`, as strings) so a pair has
 * exactly one document whichever way round it was dismissed.
 *
 * @typedef {object} DuplicateDismissal
 * @property {object} a - Application _id (the smaller id).
 * @property {object} b - Application _id (the larger id).
 * @property {object} by - User who dismissed the pair.
 * @property {Date} createdAt
 */
var duplicateDismissalSchema = new Schema(
  {
    a: { type: Schema.Types.ObjectId, ref: "Application", required: true },
    b: { type: Schema.Types.ObjectId, ref: "Application", required: true },
    by: { type: Schema.Types.ObjectId, ref: "User" },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

duplicateDismissalSchema.index({ a: 1, b: 1 }, { unique: true });

module.exports = mongoose.model("DuplicateDismissal", duplicateDismissalSchema);
