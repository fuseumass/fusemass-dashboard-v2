"use strict";
var mongoose = require("mongoose");
/** @typedef {object} RaffleDraw
 * @property {object} workshop
 * @property {object} drawnBy
 * @property {string} prize
 * @property {number} count
 * @property {number} poolSize
 * @property {Array<object>} winners - User reference, claimed, claimedAt and noShow.
 * @property {object} redrawOf - Original draw reference.
 */
var schema = new mongoose.Schema(
  {
    workshop: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Workshop",
      required: true,
      index: true,
    },
    drawnBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    prize: { type: String, required: true, maxlength: 200 },
    count: { type: Number, required: true },
    poolSize: { type: Number, required: true },
    winners: [
      {
        user: {
          type: mongoose.Schema.Types.ObjectId,
          ref: "User",
          required: true,
        },
        claimed: { type: Boolean, default: false },
        claimedAt: { type: Date, default: null },
        noShow: { type: Boolean, default: false },
      },
    ],
    redrawOf: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "RaffleDraw",
      default: null,
    },
  },
  { timestamps: true },
);
// A multikey unique index prevents a user winning twice in this workshop,
// including no-shows. Creating the complete draw is the atomic reservation.
schema.index({ workshop: 1, "winners.user": 1 }, { unique: true });
module.exports = mongoose.model("RaffleDraw", schema);
