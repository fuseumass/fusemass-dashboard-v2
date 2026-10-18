"use strict";
var mongoose = require("mongoose");
var Schema = mongoose.Schema;

/**
 * CheckIn records when a user checks in to the event. One check-in per user.
 * Logs the user, date of checkin, the userId of who checked them in, and timestamp.
*/

var checkInSchema = new Schema(
  {
    user: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
      unique: true,
      index: true,
    },

    checkedInAt: {
      type: Date,
      required: true,
      default: Date.now,
    },

    checkedInBy: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },

    // Forced check-in: staff checked in someone whose application wasn't
    // accepted (e.g. an approved walk-in). The reason is required and kept
    // with the record, along with their application status at the time.
    forced: {
      type: Boolean,
      default: false,
    },
    forcedReason: {
      type: String,
      trim: true,
      default: "",
    },
    applicationStatus: {
      type: String,
      default: "",
    },
  },
  {timestamps: true}
);

module.exports = mongoose.model("CheckIn", checkInSchema);
