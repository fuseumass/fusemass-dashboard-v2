"use strict";
var mongoose = require("mongoose");
/**
 * @typedef {object} JudgingTableAttrs
 * @property {number} number - Globally unique table number.
 * @property {object} room - Room reference.
 * @property {string} token - Random printed table credential.
 */
var schema = new mongoose.Schema({
  number: { type: Number, required: true, unique: true },
  room: { type: mongoose.Schema.Types.ObjectId, ref: "JudgingRoom", required: true },
  token: { type: String, required: true, unique: true, select: false },
}, { timestamps: true });
module.exports = mongoose.model("JudgingTable", schema);
