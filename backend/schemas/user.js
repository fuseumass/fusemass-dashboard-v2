"use strict";

var mongoose = require("mongoose");
var bcrypt = require("bcryptjs");
var qrCode = require("../utils/qrCode");

var Schema = mongoose.Schema;

/**
 * Roles in the system:
 *   - "applicant": default on register; can only apply.
 *   - "moderator": can review applications (approve/reject) and (later) see
 *     hardware data and judging progress. Cannot change org setup.
 *   - "admin": full access, including organization setup (settings, rounds,
 *     promoting users, editing the application form).
 */

var userSchema = new Schema(
  {
    name: {
      type: String,
      required: true,
      trim: true,
    },
    email: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
      index: true,
    },
    // Optional: Google-authenticated users never set a local password.
    passwordHash: {
      type: String,
    },
    // Set when the account is linked to a Google identity.
    googleId: {
      type: String,
      index: true,
      sparse: true,
    },
    // URL of the user's Google profile photo, if any.
    avatarUrl: {
      type: String,
    },
    role: {
      type: String,
      enum: ["applicant", "moderator", "admin"],
      default: "applicant",
    },
    // Password-reset flow (nodemailer). The token stored here is a SHA-256 hash
    // of the value emailed to the user, so a database leak can't be used to
    // reset passwords.
    resetPasswordToken: {
      type: String,
    },
    resetPasswordExpires: {
      type: Date,
    },
    // Event-day check-in code (HMAC-SHA256 of the email, see utils/qrCode),
    // encoded into the QR on the acceptance email. Staff scan it for the first
    // check-in, meals and hardware checkout. Set on acceptance; stored rather
    // than recomputed so an issued code keeps working if the secret changes.
    qrId: {
      type: String,
      unique: true,
      sparse: true,
    },
  },
  { timestamps: true }
);

/**
 * Hash a plain-text password with bcrypt.
 * @param {string} plain - Plain-text password.
 * @returns {Promise<string>} The bcrypt hash to store in `passwordHash`.
 */
userSchema.statics.hashPassword = function hashPassword(plain) {
  return bcrypt.hash(plain, 10);
};

/**
 * Compare a candidate password against this user's stored hash.
 * @param {string} candidate - Plain-text password to verify.
 * @returns {Promise<boolean>} True when the password matches.
 */
userSchema.methods.verifyPassword = function verifyPassword(candidate) {
  if (!this.passwordHash) {
    return Promise.resolve(false);
  }
  return bcrypt.compare(candidate, this.passwordHash);
};

/**
 * Return a user's check-in code, generating and saving it on first use. Safe
 * to call repeatedly or concurrently: the code is derived from the email, so
 * every caller computes and writes the same value.
 * @param {*} userId - The user's _id.
 * @returns {Promise<string|null>} The code, or null when there is no such user.
 */
userSchema.statics.ensureQrId = function ensureQrId(userId) {
  var User = this;

  return User.findById(userId)
    .select("email qrId")
    .then(function afterFind(user) {
      if (!user) {
        return null;
      }
      if (user.qrId) {
        return user.qrId;
      }
      var qrId = qrCode.computeQrId(user.email);
      return User.updateOne({ _id: user._id }, { $set: { qrId: qrId } }).then(function afterSave() {
        return qrId;
      });
    });
};

// Strip sensitive fields whenever a user document is serialized to JSON.
userSchema.set("toJSON", {
  transform: function transform(_doc, ret) {
    delete ret.passwordHash;
    delete ret.resetPasswordToken;
    delete ret.resetPasswordExpires;
    return ret;
  },
});

module.exports = mongoose.model("User", userSchema);
