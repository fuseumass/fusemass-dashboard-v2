"use strict";

var passport = require("passport");
var GoogleStrategy = require("passport-google-oauth20").Strategy;
var User = require("../schemas/user");
var emailVerification = require("./emailVerification");

/**
 * Whether Google OAuth is configured. The /google routes check this and return
 * a clear error when the hackathon organizer hasn't set up credentials yet.
 * @returns {boolean}
 */
function isGoogleConfigured() {
  return Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);
}

/**
 * Find or create the local user for a Google profile. Google has already
 * verified the address, so this also marks the account's email verified.
 *
 * If the matching account was an unverified password sign-up, its password is
 * removed: whoever chose it never proved they own the inbox (it could be
 * someone who registered with another person's address), so it must not
 * outlive the real owner proving it through Google. The owner can sign in with
 * Google or use "Forgot password" to choose a new one.
 *
 * @param {object} profile - Google profile (id, displayName, emails, photos).
 * @returns {Promise<object>} The User document. Rejects when the profile has no
 *   email, or Google reports it as unverified.
 */
function findOrCreateGoogleUser(profile) {
  var first = profile.emails && profile.emails[0];
  var email = first && first.value;
  var photo = profile.photos && profile.photos[0] && profile.photos[0].value;

  if (!email) {
    return Promise.reject(new Error("Google account has no email."));
  }
  // Everything below treats a Google sign-in as proof of the inbox, so an
  // address Google itself reports as unverified must not be accepted.
  if (first.verified === false) {
    return Promise.reject(new Error("Google has not verified this email address."));
  }

  return User.findOne({ email: String(email).toLowerCase() }).then(function afterLookup(user) {
    if (!user) {
      return User.create({
        name: profile.displayName || email,
        email: email,
        googleId: profile.id,
        avatarUrl: photo,
        role: "applicant",
      });
    }

    var changed = false;
    // Link the Google id to an existing (e.g. password) account.
    if (!user.googleId) {
      user.googleId = profile.id;
      if (photo && !user.avatarUrl) {
        user.avatarUrl = photo;
      }
      changed = true;
    }
    if (user.emailVerified === false) {
      user.passwordHash = undefined;
      emailVerification.markVerified(user);
      changed = true;
    }
    return changed ? user.save() : user;
  });
}

/**
 * Register the Google strategy with passport. We run passport with
 * `session: false` — the callback route signs our own JWT — so there is no
 * serialize/deserialize needed. Safe to call once at startup; it no-ops when
 * Google isn't configured.
 * @returns {void}
 */
function configurePassport() {
  if (!isGoogleConfigured()) {
    return;
  }

  passport.use(
    new GoogleStrategy(
      {
        clientID: process.env.GOOGLE_CLIENT_ID,
        clientSecret: process.env.GOOGLE_CLIENT_SECRET,
        callbackURL:
          process.env.GOOGLE_CALLBACK_URL ||
          "http://localhost:4000/api/auth/google/callback",
      },
      /**
       * Find or create a local user for this Google identity.
       * @param {string} _accessToken
       * @param {string} _refreshToken
       * @param {object} profile - Google profile.
       * @param {function} done - passport callback (err, user).
       */
      function verify(_accessToken, _refreshToken, profile, done) {
        findOrCreateGoogleUser(profile)
          .then(function afterUser(user) {
            done(null, user);
          })
          .catch(function onError(err) {
            done(err);
          });
      }
    )
  );
}

module.exports = {
  passport: passport,
  configurePassport: configurePassport,
  findOrCreateGoogleUser: findOrCreateGoogleUser,
  isGoogleConfigured: isGoogleConfigured,
};
