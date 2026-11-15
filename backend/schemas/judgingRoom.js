"use strict";
var mongoose = require("mongoose");
/**
 * @typedef {object} JudgingRoomAttrs
 * @property {string} name - Room label.
 * @property {number} order - Fill order.
 * @property {number} capacity - Number of tables (tableEnd - tableStart + 1 when a range is set).
 * @property {number|null} tableStart - First table number in this room.
 * @property {number|null} tableEnd - Last table number in this room.
 * @property {boolean} hardware - Hardware room.
 */
var schema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 100 },
    order: { type: Number, default: 0, min: 0 },
    capacity: { type: Number, required: true, min: 0 },
    // Organizer-chosen table numbers (e.g. 1-5, 100-110). Rooms without a
    // range are numbered after the previous room (older data).
    tableStart: { type: Number, min: 1, default: null },
    tableEnd: { type: Number, min: 1, default: null },
    hardware: { type: Boolean, default: false },
  },
  { timestamps: true },
);
module.exports = mongoose.model("JudgingRoom", schema);
