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
  },
  {timestamps: true}
);

module.exports = mongoose.model("CheckIn", checkInSchema);
