"use strict";

var passport = require("passport");
var GoogleStrategy = require("passport-google-oauth20").Strategy;
var User = require("../schemas/user");

/**
 * Whether Google OAuth is configured. The /google routes check this and return
 * a clear error when the hackathon organizer hasn't set up credentials yet.
 * @returns {boolean}
 */
function isGoogleConfigured() {
  return Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);
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
        var email =
          profile.emails && profile.emails[0] && profile.emails[0].value;
        var photo =
          profile.photos && profile.photos[0] && profile.photos[0].value;

        if (!email) {
          return done(new Error("Google account has no email."));
        }

        User.findOne({ email: String(email).toLowerCase() })
          .then(function afterLookup(user) {
            if (user) {
              // Link the Google id to an existing (e.g. password) account.
              if (!user.googleId) {
                user.googleId = profile.id;
                if (photo && !user.avatarUrl) {
                  user.avatarUrl = photo;
                }
                return user.save();
              }
              return user;
            }
            return User.create({
              name: profile.displayName || email,
              email: email,
              googleId: profile.id,
              avatarUrl: photo,
              role: "applicant",
            });
          })
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
  isGoogleConfigured: isGoogleConfigured,
};
