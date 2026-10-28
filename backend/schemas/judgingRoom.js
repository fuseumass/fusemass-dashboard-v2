"use strict";
var mongoose = require("mongoose");
/**
 * @typedef {object} JudgingRoomAttrs
 * @property {string} name - Room label.
 * @property {number} order - Fill order.
 * @property {number} capacity - Number of tables.
 * @property {boolean} hardware - Hardware room.
 */
var schema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 100 },
    order: { type: Number, default: 0, min: 0 },
    capacity: { type: Number, required: true, min: 0 },
    hardware: { type: Boolean, default: false },
  },
  { timestamps: true },
);
module.exports = mongoose.model("JudgingRoom", schema);
