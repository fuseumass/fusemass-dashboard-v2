"use strict";
var mongoose = require("mongoose");
/**
 * @typedef {object} WorkshopSignup
 * @property {object} user - User reference.
 * @property {object} workshop - Workshop reference.
 * @property {Date} createdAt
 */
var schema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    workshop: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Workshop",
      required: true,
    },
  },
  { timestamps: true },
);
schema.index({ user: 1, workshop: 1 }, { unique: true });
module.exports = mongoose.model("WorkshopSignup", schema);
