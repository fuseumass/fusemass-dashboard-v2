"use strict";

var mongoose = require("mongoose");
var bcrypt = require("bcryptjs");

var Schema = mongoose.Schema;

/**
 * The two roles in the system. Everyone who registers is an "applicant" by
 * default; an existing admin can promote a user to "admin".
 * @typedef {"applicant" | "admin"} UserRole
 */

/**
 * @typedef {Object} UserAttrs
 * @property {string} name        - Display name of the user.
 * @property {string} email       - Unique, lowercased email used to log in.
 * @property {string} passwordHash - Bcrypt hash of the password. Never the plain password.
 * @property {UserRole} role      - Access level.
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
    passwordHash: {
      type: String,
      required: true,
    },
    role: {
      type: String,
      enum: ["applicant", "admin"],
      default: "applicant",
    },
  },
  { timestamps: true }
);

/**
 * Hash a plain-text password with bcrypt. Static helper so callers never hand a
 * plain password to the model directly.
 *
 * @param {string} plain - Plain-text password.
 * @returns {Promise<string>} The bcrypt hash to store in `passwordHash`.
 */
userSchema.statics.hashPassword = function hashPassword(plain) {
  return bcrypt.hash(plain, 10);
};

/**
 * Compare a candidate password against this user's stored hash.
 *
 * @this {mongoose.Document & UserAttrs}
 * @param {string} candidate - Plain-text password to verify.
 * @returns {Promise<boolean>} True when the password matches.
 */
userSchema.methods.verifyPassword = function verifyPassword(candidate) {
  return bcrypt.compare(candidate, this.passwordHash);
};

// Strip the password hash whenever a user document is serialized to JSON.
userSchema.set("toJSON", {
  transform: function transform(_doc, ret) {
    delete ret.passwordHash;
    return ret;
  },
});

module.exports = mongoose.model("User", userSchema);
