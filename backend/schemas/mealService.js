"use strict";

var mongoose = require("mongoose");
var validator = require("validator");

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
    createdFor: {
      type: String,
      required: true,
      trim: true,
      validate: {
        validator: validator.isEmail,
        message: "createdFor must be a valid email address.",
      },
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
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
    updatedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
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
