"use strict";

var mongoose = require("mongoose");
var Schema = mongoose.Schema;

/**
 * MealCheckIn records a user checking in for a specific meal service.
 * Prevents double serving by enforcing a unique combination of user + mealService.
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

// one check-in per service?
mealCheckInSchema.index({user: 1, mealService: 1}, {unique: true});

module.exports = mongoose.model("MealCheckIn", mealCheckInSchema);