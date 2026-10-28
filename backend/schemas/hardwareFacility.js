"use strict";

var mongoose = require("mongoose");
/**
 * @typedef {object} HardwareFacility
 * @property {string} name - Resource name.
 * @property {string} location - Where to find it.
 * @property {string} accessNotes - Access and safety instructions.
 */
var schema = new mongoose.Schema({
  name: { type: String, required: true, trim: true, maxlength: 200 },
  location: { type: String, default: "", maxlength: 500 },
  accessNotes: { type: String, default: "", maxlength: 4000 }
}, { timestamps: true });
module.exports = mongoose.model("HardwareFacility", schema);
