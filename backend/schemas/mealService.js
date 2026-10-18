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
    // Optional: the email of the one attendee this service is for (e.g. a
    // special-diet plate). Empty for an event-wide meal like "Saturday Lunch".
    createdFor: {
      type: String,
      trim: true,
      default: "",
      validate: {
        validator: function isEmptyOrEmail(value) {
          return !value || validator.isEmail(value);
        },
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

mealServiceSchema.index({ name: 1, createdFor: 1 }, { unique: true });

module.exports = mongoose.model("MealService", mealServiceSchema);
