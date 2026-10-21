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
var applicationStatus = require("../utils/applicationStatus");
var applicationFlags = require("../utils/applicationFlags");
var resumeText = require("../utils/resumeText");
var waitlist = require("../utils/waitlist");

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
 * A round as applicants may see it: without staff-only settings (the waitlist
 * limit is the round's capacity, which is for organizers).
 * @param {(object|null)} round - An ApplicationRound document.
 * @returns {(object|null)} Plain round JSON, or null.
 */
function roundForApplicant(round) {
  if (!round) {
    return null;
  }
  var json = round.toJSON();
  delete json.waitlistAfterAccepted;
  return json;
}

/**
 * The status a newly submitted application starts with: "waitlisted" once
 * the round has reached its accepted limit (waitlist mode), otherwise
 * "pending". Applications already submitted are never moved by this.
 *
 * @param {object} round - The ApplicationRound being applied to.
 * @returns {Promise<string>} "pending" or "waitlisted".
 */
function submissionStatus(round) {
  if (!waitlist.hasLimit(round.waitlistAfterAccepted)) {
    return Promise.resolve("pending");
  }
  return Application.countDocuments({ round: round._id, status: "accepted" }).then(function afterCount(accepted) {
    return waitlist.shouldWaitlist(round.waitlistAfterAccepted, accepted) ? "waitlisted" : "pending";
  });
}

/**
 * Email a newly submitted application's owner: the waitlist email when it
 * was waitlisted on arrival (the "received" one says "pending review", which
 * would be wrong), otherwise the received email. Errors are logged, not thrown.
 *
 * @param {string} to - Recipient address.
 * @param {object} application - The saved Application.
 * @returns {Promise<void>}
 */
function sendSubmissionEmail(to, application) {
  var key = application.status === "waitlisted" ? "application_waitlisted" : "application_received";
  return mailer
    .sendTemplateEmail(to, key, {
      name: application.name,
      status: application.status,
    })
    .catch(function onMailError(err) {
      console.error("Failed to send " + key + " email:", err);
    });
}

/**
 * The automatic reasons to flag a first submission, when admins have turned
 * automatic flagging on (empty otherwise). Best effort: a failure here is
 * logged and the application is simply submitted unflagged.
 *
 * @param {object} input
 * @param {*} input.applicantId - The applicant's user id (their own other
 *   applications don't count as duplicates).
 * @param {string} input.name - Applicant name, to look for in the resume.
 * @param {string} input.phoneKey - applicationFlags.phoneKey of their phone.
 * @param {string} input.resumeHash - SHA-256 of their resume file, or "".
 * @param {(object|undefined)} input.file - The multer file uploaded with this
 *   submission, whose text is checked.
 * @returns {Promise<Array<string>>}
 */
function autoFlagReasonsFor(input) {
  return OrgSettings.getSingleton()
    .then(function afterSettings(settings) {
      if (!settings.autoFlagApplications) {
        return [];
      }
      var others = { applicant: { $ne: input.applicantId } };
      return Promise.all([
        input.file ? resumeText.extractText(input.file.buffer) : Promise.resolve(null),
        input.phoneKey ? Application.exists(Object.assign({ phoneKey: input.phoneKey }, others)) : null,
        input.resumeHash ? Application.exists(Object.assign({ resumeHash: input.resumeHash }, others)) : null,
      ]).then(function afterChecks(found) {
        return applicationFlags.autoFlagReasons({
          name: input.name,
          resumeText: found[0],
          duplicatePhone: Boolean(found[1]),
          duplicateResume: Boolean(found[2]),
        });
      });
    })
    .catch(function onError(err) {
      console.error("Automatic application checks failed:", err);
      return [];
    });
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
        .select("resumeBlobName resumeHash status")
        .then(function afterExisting(existing) {
          return {
            round: openRound,
            hadResume: Boolean(existing && existing.resumeBlobName),
            previousStatus: existing ? existing.status : null,
            previousResumeHash: (existing && existing.resumeHash) || "",
          };
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
        // Submitting a draft (or a brand new application) is the one moment
        // an application gets its starting status (waitlisted when the round
        // is full) and its automatic flags. Submitting again to edit one
        // that's already in keeps whatever status review gave it: an edit
        // must not undo an acceptance, or take someone off the waitlist.
        var previousStatus = found.previousStatus;
        var firstSubmission = status === "pending" && (!previousStatus || previousStatus === "draft");
        var statusStep =
          status !== "pending"
            ? Promise.resolve(status)
            : firstSubmission
              ? submissionStatus(round)
              : Promise.resolve(previousStatus);
        var resumeHash = req.file ? applicationFlags.fileHash(req.file.buffer) : found.previousResumeHash;
        var flagStep = firstSubmission
          ? autoFlagReasonsFor({
              applicantId: claims.id,
              name: profile.name,
              phoneKey: applicationFlags.phoneKey(profile.phone),
              resumeHash: resumeHash,
              file: req.file,
            })
          : Promise.resolve([]);

        return Promise.all([statusStep, flagStep]).then(function afterDecided(decided) {
          var update = Object.assign({}, profile, {
            applicant: claims.id,
            round: round._id,
            status: decided[0],
            answers: answersCheck.answers,
            phoneKey: applicationFlags.phoneKey(profile.phone),
          });
          if (resumeBlobName) {
            update.resumeBlobName = resumeBlobName;
            update.resumeHash = resumeHash;
          }
          var operations = { $set: update };
          if (decided[1].length) {
            update.flagged = true;
            update.flaggedAt = new Date();
            // Added, not assigned: a moderator may have flagged the draft already.
            operations.$addToSet = { flagReasons: { $each: decided[1] } };
          }

          // A single atomic upsert performs the write and reports what was
          // there before it: `new: false` returns the pre-update document, or
          // null when this call is the one that inserted. Only the first
          // draft->pending (or new->pending) transition counts as "submitted",
          // and deriving that from the write itself means two concurrent
          // submits cannot both observe "not yet submitted" and both send.
          // Reading the document first and then updating allowed exactly that.
          return Application.findOneAndUpdate({ applicant: claims.id, round: round._id }, operations, {
            new: false,
            upsert: true,
            setDefaultsOnInsert: true,
          }).then(function afterSave(previous) {
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
                sendSubmissionEmail(claims.email, application);
              }
            });
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
 * What an applicant's home page shows once the open round (if any) has
 * nothing for them: their most relevant submitted application across all
 * rounds, with the round's name and whether they have checked in.
 *
 * @param {Array<object>} applications - The applicant's submitted
 *   applications, `round` populated with its name.
 * @param {(object|null)} user - The applicant's `{ checkedIn, checkedInAt }`.
 * @returns {(object|null)} `{ application, round, checkedIn, checkedInAt }`,
 *   or null when they have never submitted one.
 */
function latestSummary(applications, user) {
  var picked = applicationStatus.pickLatest(applications);
  if (!picked) {
    return null;
  }
  return {
    application: {
      _id: picked._id,
      status: picked.status,
      name: picked.name,
      createdAt: picked.createdAt,
      updatedAt: picked.updatedAt,
    },
    round: picked.round ? { _id: picked.round._id, name: picked.round.name } : null,
    checkedIn: Boolean(user && user.checkedIn),
    checkedInAt: (user && user.checkedInAt) || null,
  };
}

/**
 * GET /api/applications/me
 * Return the open round and the applicant's application for it (or null),
 * plus `latest`: their most relevant submitted application across ALL rounds
 * (null if none). The frontend decides what to show from these: the form or
 * the status for the open round, and, when applications have closed, the
 * accepted attendee's status and check-in state (event day is exactly when
 * no round is open).
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

  return Promise.all([
    findOpenRound(),
    Application.find({ applicant: claims.id, status: { $ne: "draft" } })
      .select("status name round createdAt updatedAt")
      .populate("round", "name"),
    User.findById(claims.id).select("checkedIn checkedInAt").lean(),
  ])
    .then(function afterLoad(loaded) {
      var round = loaded[0];
      var latest = latestSummary(loaded[1], loaded[2]);
      if (!round) {
        res.status(200).json({ round: null, application: null, latest: latest });
        return null;
      }
      return Application.findOne({
        applicant: claims.id,
        round: round._id,
      }).then(function afterLookup(application) {
        res.status(200).json({
          round: roundForApplicant(round),
          application: application ? application.toJSON() : null,
          latest: latest,
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
      res.status(200).json({ round: roundForApplicant(results[1]) });
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

        // Unverified until they set a password through an emailed link, which
        // is what proves the address is theirs (see authController.resetPassword).
        // The form is multipart, so the opt-in checkbox arrives as a string.
        var wantsAnnouncements = body.marketingEmailConsent === true || body.marketingEmailConsent === "true";
        var userStep = existing
          ? Promise.resolve(existing)
          : User.create({
              name: name,
              email: email,
              role: "applicant",
              emailVerified: false,
              marketingEmailConsent: wantsAnnouncements,
            });

        return userStep.then(function afterUserReady(user) {
          return Application.exists({ applicant: user._id, round: round._id }).then(function afterExists(already) {
            if (already) {
              res.status(409).json(ALREADY_APPLIED);
              return undefined;
            }

            var resumeStep = req.file ? azureBlob.uploadResume(req.file, String(user._id)) : Promise.resolve("");
            return resumeStep.then(function afterResume(resumeBlobName) {
              var profile = buildProfile(body);
              var resumeHash = req.file ? applicationFlags.fileHash(req.file.buffer) : "";

              return Promise.all([
                submissionStatus(round),
                autoFlagReasonsFor({
                  applicantId: user._id,
                  name: name,
                  phoneKey: applicationFlags.phoneKey(profile.phone),
                  resumeHash: resumeHash,
                  file: req.file,
                }),
              ]).then(function afterDecided(decided) {
                var fields = Object.assign({}, profile, {
                  name: name,
                  applicant: user._id,
                  round: round._id,
                  status: decided[0],
                  answers: answersCheck.answers,
                  phoneKey: applicationFlags.phoneKey(profile.phone),
                });
                if (resumeBlobName) {
                  fields.resumeBlobName = resumeBlobName;
                  fields.resumeHash = resumeHash;
                }
                if (decided[1].length) {
                  fields.flagged = true;
                  fields.flagReasons = decided[1];
                  fields.flaggedAt = new Date();
                }

                return Application.create(fields).then(function afterCreate(application) {
                  res.status(201).json({ application: application.toJSON() });
                  announceApplication(application, round, true);
                  sendSubmissionEmail(email, application);
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
