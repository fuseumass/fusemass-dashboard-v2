"use strict";

var mongoose = require("mongoose");

var Schema = mongoose.Schema;

/**
 * A meal service block such as "Saturday Lunch" that admins can manage for
 * event-day meal check-in workflows.
 * @typedef {object} MealService
 */
var mealServiceSchema = new Schema(
  {
    name: {
      type: String,
      required: true,
      trim: true,
    },
    startsAt: {
      type: Date,
      required: true,
    },
    endsAt: {
      type: Date,
      required: true,
    },
    active: {
      type: Boolean,
      default: true,
    },
  },
  { timestamps: true }
);

mealServiceSchema.pre("validate", function validateMealService(next) {
  if (this.startsAt && this.endsAt && this.startsAt > this.endsAt) {
    this.invalidate("endsAt", "endsAt must be after startsAt.");
  }
  next();
});

module.exports = mongoose.model("MealService", mealServiceSchema);
