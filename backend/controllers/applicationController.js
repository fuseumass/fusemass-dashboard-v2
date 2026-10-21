"use strict";

var validator = require("validator");

var Application = require("../schemas/application");
var ApplicationRound = require("../schemas/applicationRound");
var OrgSettings = require("../schemas/orgSettings");
var User = require("../schemas/user");
var passwordToken = require("../utils/passwordToken");
var azureBlob = require("../utils/azureBlob");
var discord = require("../utils/discord");
var mailer = require("../utils/mailer");
var formConfigUtil = require("../utils/formConfig");
var qrCode = require("../utils/qrCode");

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
    .then(function afterRound(openRound) {
      if (!openRound) {
        res.status(400).json({ error: "Applications are not open right now." });
        return null;
      }
      // A required resume question is satisfied by a resume uploaded earlier.
      return Application.findOne({ applicant: claims.id, round: openRound._id })
        .select("resumeBlobName")
        .then(function afterExisting(existing) {
          return { round: openRound, hadResume: Boolean(existing && existing.resumeBlobName) };
        });
    })
    .then(function afterLookup(found) {
      if (!found) {
        return null;
      }
      var round = found.round;

      var profile = buildProfile(req.body || {});
      var status = req.body && req.body.status === "draft" ? "draft" : "pending";
      var answersInput = parseMaybeJson(req.body && req.body.answers, {});
      var answersCheck = formConfigUtil.validateAnswers(round.formConfig, answersInput, {
        hasResume: Boolean(req.file) || found.hadResume,
      });

      // Drafts can be incomplete; a real submission must satisfy the round's
      // required questions (built-in and custom) and any options constraints.
      var problems = formConfigUtil.validateProfile(round.profileFields, profile).concat(answersCheck.errors);
      if (status !== "draft" && problems.length) {
        res.status(400).json({ error: problems.join(" ") });
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

      return resumeStep.then(function afterResume(resumeBlobName) {
        var update = Object.assign({}, profile, {
          applicant: claims.id,
          round: round._id,
          status: status,
          answers: answersCheck.answers,
        });
        if (resumeBlobName) {
          update.resumeBlobName = resumeBlobName;
        }

        // A single atomic upsert performs the write and reports what was
        // there before it: `new: false` returns the pre-update document, or
        // null when this call is the one that inserted. Only the first
        // draft->pending (or new->pending) transition counts as "submitted",
        // and deriving that from the write itself means two concurrent
        // submits cannot both observe "not yet submitted" and both send.
        // Reading the document first and then updating allowed exactly that.
        return Application.findOneAndUpdate(
          { applicant: claims.id, round: round._id },
          { $set: update },
          { new: false, upsert: true, setDefaultsOnInsert: true }
        ).then(function afterSave(previous) {
          var alreadySubmitted = Boolean(previous) && previous.status !== "draft";

          // The pre-image is not what the client should get back, so reload
          // the saved document. The write has already landed, so this read
          // is not part of the decision and cannot race it.
          return Application.findOne({ applicant: claims.id, round: round._id }).then(function afterReload(
            application
          ) {
            res.status(200).json({ application: application.toJSON() });

            if (status === "pending" && !alreadySubmitted) {
              announceApplication(application, round, false);
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

/**
 * GET /api/applications/me/qr
 * The caller's event check-in QR code (the same one on their acceptance
 * email), once any of their applications has been accepted. Looks across all
 * rounds, not just the open one: on event day applications are usually closed.
 *
 * @param {object} req - Express request.
 * @param {object} res - Express response.
 * @returns {Promise<void>}
 */
function getMyQr(req, res) {
  var claims = req.user;
  if (!claims) {
    res.status(401).json({ error: "Authentication required." });
    return Promise.resolve();
  }

  return Application.exists({ applicant: claims.id, status: "accepted" })
    .then(function afterLookup(accepted) {
      if (!accepted) {
        res.status(404).json({ error: "Your check-in QR code is available once your application is accepted." });
        return null;
      }
      return User.ensureQrId(claims.id).then(function afterQrId(qrId) {
        if (!qrId) {
          res.status(404).json({ error: "User not found." });
          return null;
        }
        return qrCode.toDataUrl(qrId).then(function afterRender(dataUrl) {
          res.status(200).json({ qrId: qrId, qrCode: dataUrl });
        });
      });
    })
    .catch(function onError(err) {
      console.error("getMyQr failed:", err);
      res.status(500).json({ error: "Could not load your check-in QR code." });
    });
}

/**
 * Post a newly submitted application to the applications Discord webhook
 * (when configured), with its running count in the round. Fire and forget.
 *
 * @param {object} application - The submitted Application.
 * @param {object} round - Its ApplicationRound.
 * @param {boolean} withoutAccount - Whether it came from the no-account form.
 * @returns {void}
 */
function announceApplication(application, round, withoutAccount) {
  if (!process.env.DISCORD_APPLICATIONS_WEBHOOK_URL) {
    return;
  }
  Application.countDocuments({ round: round._id, status: { $ne: "draft" } })
    .then(function afterCount(total) {
      return discord.notifyApplication(application, {
        roundName: round.name,
        withoutAccount: withoutAccount,
        totalInRound: total,
      });
    })
    .catch(function onError(err) {
      console.error("Failed to announce application:", err);
    });
}

/**
 * Whether admins have switched on applying without an account.
 * @returns {Promise<boolean>}
 */
function publicApplicationsEnabled() {
  return OrgSettings.getSingleton().then(function afterLoad(settings) {
    return Boolean(settings.publicApplications);
  });
}

/**
 * GET /api/applications/public/round
 * The open round and its form, for the no-account application form on the
 * home page. 404 unless admins have enabled applying without an account.
 *
 * @param {object} _req - Express request.
 * @param {object} res - Express response.
 * @returns {Promise<void>}
 */
function getPublicRound(_req, res) {
  return Promise.all([publicApplicationsEnabled(), findOpenRound()])
    .then(function afterLookups(results) {
      if (!results[0]) {
        res.status(404).json({ error: "Applying without an account isn't enabled." });
        return;
      }
      res.status(200).json({ round: results[1] || null });
    })
    .catch(function onError(err) {
      console.error("getPublicRound failed:", err);
      res.status(500).json({ error: "Could not load the application form." });
    });
}

var ALREADY_APPLIED = {
  error: "We already have an application from this email.",
  code: "ALREADY_APPLIED",
};

/**
 * POST /api/applications/public
 * Submit an application without an account (multipart, same fields as
 * POST /api/applications plus `email`; no drafts). The email gets a
 * passwordless applicant account, which login refuses until a password is set
 * through an emailed link (sent on acceptance, or via "Forgot password").
 *
 * Without a login nobody may change an existing application, so this refuses
 * (409) an email that already has a usable account (log in and apply instead)
 * or that already applied to this round.
 *
 * @param {object} req - Express request (req.file set by multer).
 * @param {object} res - Express response.
 * @returns {Promise<void>}
 */
function applyPublic(req, res) {
  var body = req.body || {};
  var email = String(body.email || "").trim().toLowerCase();
  var name = String(body.name || "").trim();

  return Promise.all([publicApplicationsEnabled(), findOpenRound()])
    .then(function afterLookups(results) {
      var round = results[1];
      if (!results[0]) {
        res.status(404).json({ error: "Applying without an account isn't enabled." });
        return undefined;
      }
      if (!round) {
        res.status(400).json({ error: "Applications are not open right now." });
        return undefined;
      }
      if (!validator.isEmail(email)) {
        res.status(400).json({ error: "A valid email address is required." });
        return undefined;
      }
      if (!name) {
        res.status(400).json({ error: "Full name is required." });
        return undefined;
      }

      var answersCheck = formConfigUtil.validateAnswers(round.formConfig, parseMaybeJson(body.answers, {}), {
        hasResume: Boolean(req.file),
      });
      var problems = formConfigUtil.validateProfile(round.profileFields, buildProfile(body)).concat(answersCheck.errors);
      if (problems.length) {
        res.status(400).json({ error: problems.join(" ") });
        return undefined;
      }
      if (req.file && !azureBlob.isAzureConfigured()) {
        res.status(501).json({ error: "Resume upload is not configured yet." });
        return undefined;
      }

      return User.findOne({ email: email }).then(function afterUser(existing) {
        if (existing && !passwordToken.needsPasswordSetup(existing)) {
          res.status(409).json({
            error: "You already have an account with this email. Log in to apply.",
            code: "ACCOUNT_EXISTS",
          });
          return undefined;
        }

        var userStep = existing ? Promise.resolve(existing) : User.create({ name: name, email: email, role: "applicant" });

        return userStep.then(function afterUserReady(user) {
          return Application.exists({ applicant: user._id, round: round._id }).then(function afterExists(already) {
            if (already) {
              res.status(409).json(ALREADY_APPLIED);
              return undefined;
            }

            var resumeStep = req.file ? azureBlob.uploadResume(req.file, String(user._id)) : Promise.resolve("");
            return resumeStep.then(function afterResume(resumeBlobName) {
              var fields = Object.assign({}, buildProfile(body), {
                name: name,
                applicant: user._id,
                round: round._id,
                status: "pending",
                answers: answersCheck.answers,
              });
              if (resumeBlobName) {
                fields.resumeBlobName = resumeBlobName;
              }

              return Application.create(fields).then(function afterCreate(application) {
                res.status(201).json({ application: application.toJSON() });
                announceApplication(application, round, true);

                mailer
                  .sendTemplateEmail(email, "application_received", {
                    name: application.name,
                    status: application.status,
                  })
                  .catch(function onMailError(err) {
                    console.error("Failed to send application-received email:", err);
                  });
              });
            });
          });
        });
      });
    })
    .catch(function onError(err) {
      if (res.headersSent) {
        console.error("applyPublic failed after responding:", err);
        return;
      }
      // Two submits for the same email at once: the loser trips the unique
      // email / (applicant, round) index, which means the same thing.
      if (err && err.code === 11000) {
        res.status(409).json(ALREADY_APPLIED);
        return;
      }
      console.error("applyPublic failed:", err);
      res.status(500).json({ error: "Could not submit application." });
    });
}

module.exports = {
  apply: apply,
  getMine: getMine,
  getMyQr: getMyQr,
  getPublicRound: getPublicRound,
  applyPublic: applyPublic,
};
