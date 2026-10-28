"use strict";

var mongoose = require("mongoose");
/**
 * @typedef {object} HardwareItem
 * @property {string} name - Item name.
 * @property {string} category - Catalog category.
 * @property {string} description - Usage information.
 * @property {string} link - Documentation URL.
 * @property {string} location - Shelf or bin.
 * @property {string} imageUrl - Optional image URL.
 * @property {number} totalQty - Stock owned.
 * @property {number} availableQty - Stock on hand.
 * @property {number} maxPerAttendee - Open loans allowed per person.
 * @property {boolean} trackUnits - Reserved for individual unit tracking.
 * @property {boolean} archived - Hidden inventory, retained for history.
 */
var schema = new mongoose.Schema({
  name: { type: String, required: true, trim: true, maxlength: 200 },
  category: { type: String, default: "", maxlength: 200 },
  description: { type: String, default: "", maxlength: 4000 },
  link: { type: String, default: "" },
  location: { type: String, default: "", maxlength: 500 },
  imageUrl: { type: String, default: "" },
  totalQty: { type: Number, required: true, min: 0 },
  availableQty: { type: Number, required: true, min: 0 },
  maxPerAttendee: { type: Number, default: 1, min: 1 },
  trackUnits: { type: Boolean, default: false },
  archived: { type: Boolean, default: false, index: true }
}, { timestamps: true });
module.exports = mongoose.model("HardwareItem", schema);
