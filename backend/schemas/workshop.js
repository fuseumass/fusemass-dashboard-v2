"use strict";
var mongoose = require("mongoose");
/**
 * @typedef {object} Workshop
 * @property {string} title
 * @property {string} description
 * @property {string} host - Speaker name.
 * @property {string} location
 * @property {Date} startsAt
 * @property {Date} endsAt
 * @property {number} capacity - Zero means unlimited.
 * @property {number} signupCount
 * @property {Array<object>} organizers - Reserved User references.
 * @property {boolean} published
 * @property {boolean} raffleEnabled
 * @property {boolean} cancelled
 * @property {number} sequence - Calendar revision.
 */
var schema = new mongoose.Schema(
  {
    title: { type: String, required: true, trim: true },
    description: { type: String, default: "" },
    host: { type: String, default: "" },
    location: { type: String, default: "" },
    startsAt: { type: Date, required: true },
    endsAt: { type: Date, required: true },
    capacity: { type: Number, default: 0, min: 0 },
    signupCount: { type: Number, default: 0, min: 0 },
    organizers: [{ type: mongoose.Schema.Types.ObjectId, ref: "User" }],
    published: { type: Boolean, default: false },
    raffleEnabled: { type: Boolean, default: false },
    cancelled: { type: Boolean, default: false },
    sequence: { type: Number, default: 0 },
  },
  { timestamps: true },
);
module.exports = mongoose.model("Workshop", schema);
