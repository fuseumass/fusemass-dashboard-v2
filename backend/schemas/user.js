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
    // Event-day check-in code (SHA-256 of the email, see utils/qrCode),
    // encoded into the QR on the acceptance email. Staff scan it for the first
    // check-in, meals and hardware checkout. Set on acceptance and stored so
    // scans can look the attendee up by it.
    qrId: {
      type: String,
      unique: true,
      sparse: true,
    },
    // Whether the attendee has arrived (first event check-in). Flipped once,
    // atomically, by POST /api/staff/checkin; the CheckIn collection keeps the
    // who/when record.
    checkedIn: {
      type: Boolean,
      default: false,
      index: true,
    },
    checkedInAt: {
      type: Date,
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

/**
 * The check-in code for whoever owns this email address: their stored code if
 * they have an account, otherwise just SHA-256 of the email. Used when sending
 * any email whose template contains {{qrcode}}.
 * @param {string} email - Recipient email.
 * @returns {Promise<string>}
 */
userSchema.statics.ensureQrIdForEmail = function ensureQrIdForEmail(email) {
  var User = this;
  var normalized = String(email || "").trim().toLowerCase();

  return User.findOne({ email: normalized })
    .select("_id")
    .then(function afterFind(user) {
      return user ? User.ensureQrId(user._id) : qrCode.computeQrId(normalized);
    });
};

/**
 * Recompute and save the check-in code of every user that's missing one. The
 * code is just SHA-256 of the email, so lost codes can always be rebuilt
 * (e.g. after a restore or a field being dropped).
 * @returns {Promise<number>} How many users were updated.
 */
userSchema.statics.backfillQrIds = function backfillQrIds() {
  var User = this;

  return User.find({ $or: [{ qrId: { $exists: false } }, { qrId: null }, { qrId: "" }] })
    .select("email")
    .lean()
    .then(function afterFind(users) {
      if (!users.length) {
        return 0;
      }
      return User.bulkWrite(
        users.map(function toUpdate(user) {
          return {
            updateOne: {
              filter: { _id: user._id },
              update: { $set: { qrId: qrCode.computeQrId(user.email) } },
            },
          };
        })
      ).then(function afterWrite() {
        return users.length;
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
