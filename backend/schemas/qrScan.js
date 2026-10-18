
const mongoose = require("mongoose");

const checkInSchema = new mongoose.Schema(
  {
    application: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Application",
      required: true,
      unique: true,
    },
    qrId: {
      type: String,
      required: true,
      index: true,
    },
    checkedInAt: {
      type: Date,
      default: Date.now,
      required: true,
    },
    checkedInBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    forced: {
      type: Boolean,
      default: false,
    },
    reason: {
      type: String,
      default: "",
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model("CheckIn", checkInSchema);
