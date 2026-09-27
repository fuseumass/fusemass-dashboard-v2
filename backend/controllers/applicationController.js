"use strict";

var Application = require("../schemas/application");
var ApplicationRound = require("../schemas/applicationRound");
var azureBlob = require("../utils/azureBlob");
var mailer = require("../utils/mailer");
var formConfigUtil = require("../utils/formConfig");

/**
 * Parse a form field that may arrive as a JSON string (multipart form data
 * sends everything as strings, so the frontend JSON-encodes nested objects and
 * arrays). Falls back to the provided default when absent or unparseable.
 * @param {*} value - Raw field value.
 * @param {*} fallback - Value to use when parsing fails.
 * @returns {*}
 */
function parseMaybeJson(value, fallback) {
  if (value === undefined || value === null || value === "") {
    return fallback;
  }
  if (typeof value !== "string") {
    return value;
  }
  try {
    return JSON.parse(value);
  } catch (err) {
    return fallback;
  }
}

/**
 * Find the round applications are currently being accepted for.
 * @returns {Promise<object|null>} The open ApplicationRound, or null.
 */
function findOpenRound() {
  return ApplicationRound.findOne({ isOpen: true }).sort({ order: 1 });
}

/**
 * Build the profile fields to persist from a (multipart) request body.
 * @param {object} body - req.body
 * @returns {object}
 */
function buildProfile(body) {
  return {
    name: body.name,
    phone: body.phone,
    age: body.age ? Number(body.age) : undefined,
    gender: body.gender,
    pronouns: body.pronouns,
    education: body.education,
    university: body.university,
    major: body.major,
    allergies: body.allergies || "",
    tshirtSize: body.tshirtSize || "",
    socials: parseMaybeJson(body.socials, {}),
    experience: parseMaybeJson(body.experience, {}),
    programmingSkills: parseMaybeJson(body.programmingSkills, []),
    hardwareSkills: parseMaybeJson(body.hardwareSkills, []),
    otherSkills: parseMaybeJson(body.otherSkills, []),
  };
}

/**
 * POST /api/applications
 * Create or update the current applicant's application for the open round.
 * Accepts multipart/form-data so a resume file can be uploaded alongside the
 * profile fields (nested objects/arrays are JSON-encoded strings).
 *
 * @param {object} req - Express request (req.user set by parseToken; req.file by multer).
 * @param {object} res - Express response.
 * @returns {Promise<void>}
 */
function apply(req, res) {
  var claims = req.user;
  if (!claims) {
    res.status(401).json({ error: "Authentication required." });
    return Promise.resolve();
  }

  return findOpenRound()
    .then(function afterRound(round) {
      if (!round) {
        res.status(400).json({ error: "Applications are not open right now." });
        return null;
      }

      var profile = buildProfile(req.body || {});
      var status = req.body && req.body.status === "draft" ? "draft" : "pending";
      var answersInput = parseMaybeJson(req.body && req.body.answers, {});
      var answersCheck = formConfigUtil.validateAnswers(round.formConfig, answersInput);

      // Drafts can be incomplete; a real submission must satisfy the round's
      // required dynamic fields (and any options constraints).
      if (status !== "draft" && answersCheck.errors.length) {
        res.status(400).json({ error: answersCheck.errors.join(" ") });
        return null;
      }

      // Upload the resume first (if provided), then persist the application.
      var resumeStep = Promise.resolve(undefined);
      if (req.file) {
        if (!azureBlob.isAzureConfigured()) {
          res.status(501).json({ error: "Resume upload is not configured yet." });
          return null;
        }
        resumeStep = azureBlob.uploadResume(req.file, claims.id);
      }

      return resumeStep.then(function afterResume(resumeUrl) {
        var update = Object.assign({}, profile, {
          applicant: claims.id,
          round: round._id,
          status: status,
          answers: answersCheck.answers,
        });
        if (resumeUrl) {
          update.resumeUrl = resumeUrl;
        }

        return Application.findOne({ applicant: claims.id, round: round._id }).then(function afterExisting(
          existing
        ) {
          // Only the first draft->pending (or new->pending) transition counts
          // as "submitted" — re-saving an already-submitted application must
          // not re-send the received email.
          var alreadySubmitted = Boolean(existing) && existing.status !== "draft";

          return Application.findOneAndUpdate(
            { applicant: claims.id, round: round._id },
            { $set: update },
            { new: true, upsert: true, setDefaultsOnInsert: true }
          ).then(function afterSave(application) {
            res.status(200).json({ application: application.toJSON() });

            if (status === "pending" && !alreadySubmitted) {
              mailer
                .sendTemplateEmail(claims.email, "application_received", {
                  name: application.name,
                  status: application.status,
                })
                .catch(function onMailError(err) {
                  console.error("Failed to send application-received email:", err);
                });
            }
          });
        });
      });
    })
    .catch(function onError(err) {
      console.error("apply failed:", err);
      res.status(500).json({ error: "Could not submit application." });
    });
}

/**
 * GET /api/applications/me
 * Return the open round and the applicant's application for it (or null). The
 * frontend uses this to decide whether to show the form or the status.
 *
 * @param {object} req - Express request.
 * @param {object} res - Express response.
 * @returns {Promise<void>}
 */
function getMine(req, res) {
  var claims = req.user;
  if (!claims) {
    res.status(401).json({ error: "Authentication required." });
    return Promise.resolve();
  }

  return findOpenRound()
    .then(function afterRound(round) {
      if (!round) {
        res.status(200).json({ round: null, application: null });
        return null;
      }
      return Application.findOne({
        applicant: claims.id,
        round: round._id,
      }).then(function afterLookup(application) {
        res.status(200).json({
          round: round,
          application: application ? application.toJSON() : null,
        });
      });
    })
    .catch(function onError(err) {
      console.error("getMine failed:", err);
      res.status(500).json({ error: "Could not load your application." });
    });
}

module.exports = {
  apply: apply,
  getMine: getMine,
};
