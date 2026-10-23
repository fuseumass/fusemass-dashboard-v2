"use strict";

var mongoose = require("mongoose");
/**
 * @typedef {object} HardwareCheckout
 * @property {object} user - Borrower reference.
 * @property {object} item - Inventory reference.
 * @property {object} checkedOutBy - Staff reference.
 * @property {Date} checkedOutAt - Checkout time.
 * @property {Date} dueAt - Optional return deadline.
 * @property {Date} returnedAt - Null while open.
 * @property {object} returnedTo - Return staff reference.
 * @property {string} notes - Condition or collateral notes.
 * @property {number} slot - Unique open loan slot enforcing the attendee limit.
 */
var schema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
  item: { type: mongoose.Schema.Types.ObjectId, ref: "HardwareItem", required: true, index: true },
  checkedOutBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  checkedOutAt: { type: Date, default: Date.now },
  dueAt: { type: Date, default: null },
  returnedAt: { type: Date, default: null },
  returnedTo: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
  notes: { type: String, default: "", maxlength: 4000 },
  slot: { type: Number, required: true }
}, { timestamps: true });
// A count followed by create races. A unique slot makes the limit hold across processes.
schema.index({ user: 1, item: 1, slot: 1 }, { unique: true, partialFilterExpression: { returnedAt: null } });
module.exports = mongoose.model("HardwareCheckout", schema);
