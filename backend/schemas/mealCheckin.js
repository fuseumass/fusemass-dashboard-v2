"use strict";

var mongoose = require("mongoose");
var Schema = mongoose.Schema;

/**
 * MealCheckIn records a user being served a specific meal service. The
 * unique (user, mealService) index is what prevents double serving: even two
 * simultaneous scans of the same QR code can only create one row.
 *
 * @typedef {object} MealCheckIn
 * @property {*} user - The attendee served (User _id).
 * @property {*} mealService - The meal they were served (MealService _id).
 * @property {*} checkedInBy - The staff member who scanned them (User _id).
 * @property {Date} checkedInAt - When they were served.
 */
var mealCheckInSchema = new Schema(
  {
    user: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    mealService: {
      type: Schema.Types.ObjectId,
      ref: "MealService",
      required: true,
      index: true,
    },
    checkedInBy: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    checkedInAt: {
      type: Date,
      required: true,
      default: Date.now,
    },
  },
  { timestamps: true }
);

// One check-in per user per meal service.
mealCheckInSchema.index({ user: 1, mealService: 1 }, { unique: true });

/**
 * Number of check-ins recorded for each meal service.
 * @returns {Promise<object>} Map of mealService id (string) to count.
 */
mealCheckInSchema.statics.countsByMeal = function countsByMeal() {
  return this.aggregate([{ $group: { _id: "$mealService", count: { $sum: 1 } } }]).then(function toMap(rows) {
    var counts = {};
    rows.forEach(function addRow(row) {
      counts[String(row._id)] = row.count;
    });
    return counts;
  });
};

module.exports = mongoose.model("MealCheckIn", mealCheckInSchema);
