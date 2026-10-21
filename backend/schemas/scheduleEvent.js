"use strict";

var mongoose = require("mongoose");

var Schema = mongoose.Schema;

/**
 * One item in the event's run of show (opening ceremony, hacking starts,
 * judging, ...). Admins manage these; the full list goes out as a calendar
 * invite in the "checked in" email.
 *
 * @typedef {object} ScheduleEvent
 * @property {string} title - What is happening, e.g. "Opening ceremony".
 * @property {Date} startsAt - Start time.
 * @property {Date} endsAt - End time.
 * @property {string} location - Where, e.g. "Main hall". Optional.
 * @property {string} description - Extra detail. Optional.
 * @property {boolean} published - Shown on the public schedule feed for the
 *   hackathon website (GET /api/public/schedule). Off until an admin turns it
 *   on, so nothing becomes public by accident. Every item still goes into the
 *   "checked in" email's calendar invite, published or not.
 */
var scheduleEventSchema = new Schema(
  {
    title: {
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
    location: {
      type: String,
      trim: true,
      default: "",
    },
    description: {
      type: String,
      trim: true,
      default: "",
    },
    published: {
      type: Boolean,
      default: false,
    },
  },
  { timestamps: true }
);

scheduleEventSchema.pre("validate", function validateScheduleEvent(next) {
  if (this.startsAt && this.endsAt && this.startsAt >= this.endsAt) {
    this.invalidate("endsAt", "endsAt must be after startsAt.");
  }
  next();
});

module.exports = mongoose.model("ScheduleEvent", scheduleEventSchema);
