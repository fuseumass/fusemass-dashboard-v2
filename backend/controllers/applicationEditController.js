"use strict";

var mongoose = require("mongoose");

var Application = require("../schemas/application");
var ApplicationRound = require("../schemas/applicationRound");
var User = require("../schemas/user");
var applicationEdit = require("../utils/applicationEdit");
var applicationFlags = require("../utils/applicationFlags");

var EMAIL_TAKEN = { error: "Another account already uses this email.", errors: { "user.email": "Another account already uses this email." } };

/**
 * Load an application in the shape the review drawer reads (the same
 * populates as GET /api/admin/applications/:id).
 * @param {*} id - Application _id.
 * @returns {Promise<object|null>} The Application document, or null.
 */
function loadForReview(id) {
  return Application.findById(id)
    .populate("applicant", "name email role")
    .populate("round", "name formConfig profileFields")
    .populate("flaggedBy", "name email")
    .populate("edits.by", "name email");
}

/**
 * Apply a checked account change (name / email) to the applicant's User. A
 * new email address drops every single-use link sent to the old one
 * (password reset or account setup, email verification): those were for an
 * address that is now wrong. `emailVerified` stays as it was, so a verified
 * account stays verified (staff vouch for the corrected address).
 *
 * @param {object} user - The applicant's User document.
 * @param {object} changes - `{ name?, email? }` from applicationEdit.buildEdit.
 * @returns {Promise<void>}
 */
function saveAccount(user, changes) {
  if (changes.name !== undefined) {
    user.name = changes.name;
  }
  if (changes.email !== undefined) {
    user.email = changes.email;
    user.resetPasswordToken = undefined;
    user.resetPasswordExpires = undefined;
    user.emailVerificationToken = undefined;
    user.emailVerificationExpires = undefined;
    user.emailVerificationSentAt = undefined;
  }
  return user.save().then(function done() {
    return undefined;
  });
}

/**
 * PATCH /api/admin/applications/:id/details
 * Correct a submitted application (moderators and admins): typo'd names,
 * schools, answers, and the account's name and email.
 *
 * Body: {
 *   fields?: { name, phone, age, gender, pronouns, education, university,
 *              major, allergies, tshirtSize, socials, experience,
 *              programmingSkills, hardwareSkills, otherSkills },
 *   answers?: { <formConfig key>: value },
 *   user?: { name, email }
 * }
 *
 * Values are checked like a submission (required questions stay required,
 * choices must be options) without asking staff to tick consent boxes.
 * Status, flags, applicant, round and resume can't be set here (400). An
 * email used by another account is a 409. Every change is recorded in
 * `edits` with who made it.
 *
 * @param {object} req - Express request (req.user set by the moderator guard).
 * @param {object} res - Express response.
 * @returns {Promise<void>}
 */
function editApplicationDetails(req, res) {
  if (!mongoose.isValidObjectId(req.params.id)) {
    res.status(404).json({ error: "Application not found." });
    return Promise.resolve();
  }

  var state = {};
  return Application.findById(req.params.id)
    .then(function afterApplication(application) {
      if (!application) {
        res.status(404).json({ error: "Application not found." });
        return null;
      }
      state.application = application;
      return Promise.all([
        application.round ? ApplicationRound.findById(application.round).lean() : null,
        User.findById(application.applicant),
      ]);
    })
    .then(function afterLookups(found) {
      if (!found) {
        return null;
      }
      var round = found[0];
      var user = found[1];
      var application = state.application;

      var edit = applicationEdit.buildEdit({
        body: req.body,
        application: application,
        round: round,
        user: user || {},
      });
      if (edit.error) {
        res.status(400).json({ error: edit.error, errors: edit.errors });
        return null;
      }
      if (!user && Object.keys(edit.user).length) {
        res.status(404).json({ error: "This application's account no longer exists." });
        return null;
      }
      if (!edit.changed.length) {
        return loadForReview(application._id).then(function afterReload(fresh) {
          res.status(200).json({ application: fresh.toJSON({ includeFlags: true }), changed: [] });
          return null;
        });
      }

      var emailCheck =
        edit.user.email !== undefined
          ? User.exists({ email: edit.user.email, _id: { $ne: user._id } })
          : Promise.resolve(null);

      return emailCheck.then(function afterEmailCheck(taken) {
        if (taken) {
          res.status(409).json(EMAIL_TAKEN);
          return null;
        }

        // The account first: its unique email index is the last word on a
        // duplicate, and a refused email must leave the application as it was.
        var accountStep = Object.keys(edit.user).length ? saveAccount(user, edit.user) : Promise.resolve();
        return accountStep.then(function afterAccount() {
          Object.keys(edit.fields).forEach(function setField(key) {
            application.set(key, edit.fields[key]);
          });
          if (edit.fields.phone !== undefined) {
            application.phoneKey = applicationFlags.phoneKey(edit.fields.phone) || undefined;
          }
          var answerKeys = Object.keys(edit.answers);
          if (answerKeys.length) {
            var answers = Object.assign({}, application.answers || {});
            answerKeys.forEach(function setAnswer(key) {
              if (edit.answers[key] === undefined) {
                delete answers[key];
              } else {
                answers[key] = edit.answers[key];
              }
            });
            application.answers = answers;
            application.markModified("answers");
          }
          application.edits = (application.edits || []).concat([
            { by: req.user.id, at: new Date(), fields: edit.changed },
          ]);

          return application.save().then(function afterSave() {
            return loadForReview(application._id).then(function afterReload(fresh) {
              res.status(200).json({
                application: fresh.toJSON({ includeFlags: true }),
                changed: edit.changed,
                emailChanged: edit.user.email !== undefined,
              });
              return null;
            });
          });
        });
      });
    })
    .catch(function onError(err) {
      if (res.headersSent) {
        console.error("editApplicationDetails failed after responding:", err);
        return;
      }
      // Lost a race for the address with another account (unique index).
      if (err && err.code === 11000) {
        res.status(409).json(EMAIL_TAKEN);
        return;
      }
      if (err && err.name === "ValidationError") {
        res.status(400).json({ error: err.message });
        return;
      }
      console.error("editApplicationDetails failed:", err);
      res.status(500).json({ error: "Could not save the changes." });
    });
}

module.exports = {
  editApplicationDetails: editApplicationDetails,
  loadForReview: loadForReview,
};
