"use strict";
var mongoose = require("mongoose");
var Schema = mongoose.Schema;
/**
 * @typedef {object} ProjectAttrs
 * @property {string} name - Imported project title.
 * @property {string} devpostUrl - Normalized unique project URL.
 * @property {string} submitterEmail - Submitter email.
 * @property {object[]} members - Matched User ids.
 * @property {Array<{name: string, email: string}>} unmatchedMembers - Unmatched people.
 * @property {string} category - Judged track.
 * @property {string[]} optInPrizes - Prize selections.
 * @property {string[]} mlhTracks - MLH selections.
 * @property {boolean} hardware - Hardware judging.
 * @property {boolean} needsPower - Power needed.
 * @property {object} room - JudgingRoom id.
 * @property {number} tableNumber - Assigned table.
 * @property {Date} deskCheckedInAt - Desk check-in time.
 * @property {Date} tableCheckedInAt - Table check-in time.
 * @property {boolean} withdrawn - Withdrawn from judging.
 * @property {string[]} overriddenFields - Fields maintained by admins.
 */
var schema = new Schema(
  {
    name: { type: String, required: true },
    devpostUrl: { type: String, required: true, unique: true },
    submitterEmail: { type: String, default: "" },
    members: [{ type: Schema.Types.ObjectId, ref: "User" }],
    unmatchedMembers: [{ _id: false, name: String, email: String }],
    category: { type: String, default: "" },
    optInPrizes: [String],
    mlhTracks: [String],
    hardware: { type: Boolean, default: false },
    needsPower: { type: Boolean, default: false },
    room: { type: Schema.Types.ObjectId, ref: "JudgingRoom" },
    tableNumber: { type: Number, min: 1 },
    deskCheckedInAt: Date,
    tableCheckedInAt: Date,
    withdrawn: { type: Boolean, default: false },
    overriddenFields: [String],
  },
  { timestamps: true },
);
schema.index(
  { room: 1, tableNumber: 1 },
  {
    unique: true,
    partialFilterExpression: {
      tableNumber: { $type: "number" },
    },
  },
);
module.exports = mongoose.model("Project", schema);
