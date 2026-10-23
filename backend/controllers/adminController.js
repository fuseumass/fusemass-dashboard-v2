"use strict";

var Application = require("../schemas/application");
var ApplicationRound = require("../schemas/applicationRound");
var EmailTemplate = require("../schemas/emailTemplate");
var MealService = require("../schemas/mealService");
var MealCheckIn = require("../schemas/mealCheckin");
var User = require("../schemas/user");
var mailer = require("../utils/mailer");
var primaryClientOrigin = require("../utils/clientOrigin").primaryClientOrigin;
var formConfigUtil = require("../utils/formConfig");
var applicationStatus = require("../utils/applicationStatus");
var applicationFlags = require("../utils/applicationFlags");
var waitlist = require("../utils/waitlist");
var decisions = require("../utils/decisions");
var validator = require("validator");
var mongoose = require("mongoose");

// The review table's columns (see listApplications). `flagged` is just the
// yes/no; the reasons come with the full application.
var LIST_FIELDS = "name university status round applicant resumeBlobName flagged createdAt updatedAt";

// Staff routes pass this to toJSON to include the flag fields applicants
// never see (see the Application schema's toJSON).
var WITH_FLAGS = { includeFlags: true };


/**
 * GET /api/admin/applications
 * List applications for the review dashboard. Optional filters:
 *   ?status=draft|pending|accepted|rejected|waitlisted
 *   ?round=<roundId>
 *   ?flagged=true   only flagged applications
 *
 * Also returns `flaggedCount`: how many applications are flagged among those
 * matching status/round (the flagged filter itself doesn't change it), so the
 * page can show "Flagged (3)" whichever list is on screen.
 *
 * @param {object} req - Express request.
 * @param {object} res - Express response.
 * @returns {Promise<void>}
 */
function listApplications(req, res) {
  var filter = {};
  var status = req.query && req.query.status;
  if (status && applicationStatus.APPLICATION_STATUSES.indexOf(status) !== -1) {
    filter.status = status;
  }
  if (req.query && req.query.round) {
    filter.round = req.query.round;
  }
  var flaggedOnly = Boolean(req.query) && (req.query.flagged === "true" || req.query.flagged === "1");
  var listFilter = flaggedOnly ? Object.assign({}, filter, { flagged: true }) : filter;

  // Only the review table's columns: answers and the round's form come from
  // GET /api/admin/applications/:id when a reviewer opens one, so the list
  // stays small however long the form is (with the whole form copied into
  // every row it was ~10 KB per application).
  return Promise.all([
    Application.find(listFilter)
      .select(LIST_FIELDS)
      .populate("applicant", "name email role")
      .populate("round", "name")
      .sort({ createdAt: -1 }),
    Application.countDocuments(Object.assign({}, filter, { flagged: true })),
  ])
    .then(function afterFind(found) {
      res.status(200).json({
        applications: found[0].map(function toRow(application) {
          return application.toJSON(WITH_FLAGS);
        }),
        flaggedCount: found[1],
      });
    })
    .catch(function onError(err) {
      console.error("listApplications failed:", err);
      res.status(500).json({ error: "Could not load applications." });
    });
}

/**
 * GET /api/admin/applications/:id
 * One application in full, with its round's form (which labels the custom
 * answers), for the review drawer.
 *
 * @param {object} req - Express request (req.params.id is the application id).
 * @param {object} res - Express response.
 * @returns {Promise<void>}
 */
function getApplication(req, res) {
  if (!mongoose.isValidObjectId(req.params.id)) {
    res.status(404).json({ error: "Application not found." });
    return Promise.resolve();
  }

  return Application.findById(req.params.id)
    .populate("applicant", "name email role")
    .populate("round", "name formConfig")
    .populate("flaggedBy", "name email")
    .then(function afterFind(application) {
      if (!application) {
        res.status(404).json({ error: "Application not found." });
        return;
      }
      res.status(200).json({ application: application.toJSON(WITH_FLAGS) });
    })
    .catch(function onError(err) {
      console.error("getApplication failed:", err);
      res.status(500).json({ error: "Could not load the application." });
    });
}

/**
 * POST /api/admin/applications/:id/flag
 * Flag an application for a closer look, with a reason. Flagging one that is
 * already flagged adds the reason (and records who flagged last).
 *
 * Body: { reason: string } (required, shortened to 300 characters)
 *
 * @param {object} req - Express request (req.user set by the moderator guard).
 * @param {object} res - Express response.
 * @returns {Promise<void>}
 */
function flagApplication(req, res) {
  var reason = applicationFlags.cleanReason(req.body && req.body.reason);
  if (!reason) {
    res.status(400).json({ error: "A reason is required to flag an application." });
    return Promise.resolve();
  }
  if (!mongoose.isValidObjectId(req.params.id)) {
    res.status(404).json({ error: "Application not found." });
    return Promise.resolve();
  }

  return Application.findByIdAndUpdate(
    req.params.id,
    {
      $set: { flagged: true, flaggedBy: req.user.id, flaggedAt: new Date() },
      $addToSet: { flagReasons: reason },
    },
    { new: true }
  )
    .populate("applicant", "name email role")
    .populate("flaggedBy", "name email")
    .then(function afterUpdate(application) {
      if (!application) {
        res.status(404).json({ error: "Application not found." });
        return;
      }
      res.status(200).json({ application: application.toJSON(WITH_FLAGS) });
    })
    .catch(function onError(err) {
      console.error("flagApplication failed:", err);
      res.status(500).json({ error: "Could not flag the application." });
    });
}

/**
 * DELETE /api/admin/applications/:id/flag
 * Clear an application's flag and its reasons. Clearing one that isn't
 * flagged is a successful no-op.
 *
 * @param {object} req - Express request.
 * @param {object} res - Express response.
 * @returns {Promise<void>}
 */
function unflagApplication(req, res) {
  if (!mongoose.isValidObjectId(req.params.id)) {
    res.status(404).json({ error: "Application not found." });
    return Promise.resolve();
  }

  return Application.findByIdAndUpdate(
    req.params.id,
    { $set: { flagged: false, flagReasons: [] }, $unset: { flaggedBy: "", flaggedAt: "" } },
    { new: true }
  )
    .populate("applicant", "name email role")
    .then(function afterUpdate(application) {
      if (!application) {
        res.status(404).json({ error: "Application not found." });
        return;
      }
      res.status(200).json({ application: application.toJSON(WITH_FLAGS) });
    })
    .catch(function onError(err) {
      console.error("unflagApplication failed:", err);
      res.status(500).json({ error: "Could not clear the flag." });
    });
}

/**
 * PATCH /api/admin/applications/:id
 * Set an application's review status.
 *
 * Body: { decision: "accepted" | "rejected" | "waitlisted" | "pending" }
 *
 * Accepting, rejecting and waitlisting each email the applicant (moving back
 * to pending sends nothing).
 *
 * @param {object} req - Express request.
 * @param {object} res - Express response.
 * @returns {Promise<void>}
 */
function decideApplication(req, res) {
  var admin = req.user;
  if (!admin) {
    res.status(401).json({ error: "Authentication required." });
    return Promise.resolve();
  }

  var decision = req.body.decision;

  // decisions.decide makes the status change and sends the email; of two
  // concurrent requests (a double-clicked button) only one changes anything.
  return decisions
    .decide(req.params.id, decision, admin.id)
    .then(function afterUpdate(application) {
      if (application) {
        res.status(200).json({ application: application.toJSON(WITH_FLAGS) });
        return undefined;
      }

      // No match: either there is no such application, or it already holds
      // this status. Re-applying the same decision stays a successful no-op.
      return Application.findById(req.params.id)
        .populate("applicant", "name email role")
        .then(function afterReload(existing) {
          if (!existing) {
            res.status(404).json({ error: "Application not found." });
            return;
          }
          res.status(200).json({ application: existing.toJSON(WITH_FLAGS) });
        });
    })
    .catch(function onError(err) {
      console.error("decideApplication failed:", err);
      res.status(500).json({ error: "Could not update application." });
    });
}

/**
 * GET /api/admin/users?q=...
 * Search users by name or email (case-insensitive) so an admin can promote
 * them. Returns up to 25 matches; with no query, the most recent users.
 *
 * @param {object} req - Express request.
 * @param {object} res - Express response.
 * @returns {Promise<void>}
 */
function searchUsers(req, res) {
  var q = req.query && req.query.q ? String(req.query.q).trim() : "";
  var filter = {};
  if (q) {
    var rx = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
    filter = { $or: [{ name: rx }, { email: rx }] };
  }

  return User.find(filter)
    .sort({ createdAt: -1 })
    .limit(25)
    .then(function afterFind(users) {
      res.status(200).json({ users: users.map(function toJson(u) { return u.toJSON(); }) });
    })
    .catch(function onError(err) {
      console.error("searchUsers failed:", err);
      res.status(500).json({ error: "Could not search users." });
    });
}

/**
 * PATCH /api/admin/users/:id/role
 * Set a user's role. Admin only (mounted behind isAdmin).
 *
 * Body: { role: "applicant" | "moderator" | "admin" }
 *
 * @param {object} req - Express request.
 * @param {object} res - Express response.
 * @returns {Promise<void>}
 */
function setRole(req, res) {
  var role = req.body.role;

  return User.findByIdAndUpdate(req.params.id, { role: role }, { new: true })
    .then(function afterUpdate(user) {
      if (!user) {
        res.status(404).json({ error: "User not found." });
        return;
      }
      res.status(200).json({ user: user.toJSON() });
    })
    .catch(function onError(err) {
      console.error("setRole failed:", err);
      res.status(500).json({ error: "Could not update role." });
    });
}

// ---- Application rounds -----------------------------------------------------

/**
 * GET /api/admin/rounds — list all rounds (open and closed).
 * @param {object} _req
 * @param {object} res
 * @returns {Promise<void>}
 */
function listRounds(_req, res) {
  return ApplicationRound.find({})
    .sort({ order: 1, createdAt: 1 })
    .then(function afterFind(rounds) {
      res.status(200).json({ rounds: rounds });
    })
    .catch(function onError(err) {
      console.error("listRounds failed:", err);
      res.status(500).json({ error: "Could not load rounds." });
    });
}

/**
 * POST /api/admin/rounds — create a new application round.
 * Body: { name, description?, isOpen?, opensAt?, closesAt?, order?,
 *         waitlistAfterAccepted? }
 * @param {object} req
 * @param {object} res
 * @returns {Promise<void>}
 */
function createRound(req, res) {
  var name = req.body.name;

  var shapeErrors = formConfigUtil
    .validateFormConfigShape(req.body.formConfig)
    .errors.concat(formConfigUtil.validateProfileFieldsShape(req.body.profileFields).errors);
  var limit = waitlist.parseLimit(req.body.waitlistAfterAccepted);
  if (limit.error) {
    shapeErrors.push(limit.error);
  }
  if (shapeErrors.length) {
    res.status(400).json({ error: shapeErrors.join(" ") });
    return Promise.resolve();
  }

  return ApplicationRound.create({
    name: name,
    description: req.body.description || "",
    isOpen: Boolean(req.body.isOpen),
    opensAt: req.body.opensAt || undefined,
    closesAt: req.body.closesAt || undefined,
    order: req.body.order ? Number(req.body.order) : 0,
    formConfig: req.body.formConfig || [],
    profileFields: req.body.profileFields || {},
    waitlistAfterAccepted: limit.value,
  })
    .then(function afterCreate(round) {
      res.status(201).json({ round: round });
    })
    .catch(function onError(err) {
      console.error("createRound failed:", err);
      res.status(500).json({ error: "Could not create round." });
    });
}

/**
 * PATCH /api/admin/rounds/:id — update a round (rename, open/close, reschedule).
 * Body: any of { name, description, isOpen, opensAt, closesAt, order,
 * formConfig, profileFields, waitlistAfterAccepted }. `waitlistAfterAccepted`
 * is a whole number of 1+, or null/"" to remove the limit.
 * @param {object} req
 * @param {object} res
 * @returns {Promise<void>}
 */
function updateRound(req, res) {
  var allowed = [
    "name",
    "description",
    "isOpen",
    "opensAt",
    "closesAt",
    "order",
    "formConfig",
    "profileFields",
    "waitlistAfterAccepted",
  ];
  var update = {};
  allowed.forEach(function pick(key) {
    if (req.body && req.body[key] !== undefined) {
      update[key] = req.body[key];
    }
  });

  var shapeErrors = formConfigUtil
    .validateFormConfigShape(update.formConfig)
    .errors.concat(formConfigUtil.validateProfileFieldsShape(update.profileFields).errors);
  if (update.waitlistAfterAccepted !== undefined) {
    var limit = waitlist.parseLimit(update.waitlistAfterAccepted);
    if (limit.error) {
      shapeErrors.push(limit.error);
    } else {
      update.waitlistAfterAccepted = limit.value;
    }
  }
  if (shapeErrors.length) {
    res.status(400).json({ error: shapeErrors.join(" ") });
    return Promise.resolve();
  }

  return ApplicationRound.findByIdAndUpdate(req.params.id, { $set: update }, { new: true })
    .then(function afterUpdate(round) {
      if (!round) {
        res.status(404).json({ error: "Round not found." });
        return;
      }
      res.status(200).json({ round: round });
    })
    .catch(function onError(err) {
      console.error("updateRound failed:", err);
      res.status(500).json({ error: "Could not update round." });
    });
}

/**
 * DELETE /api/admin/rounds/:id — remove a round.
 * @param {object} req
 * @param {object} res
 * @returns {Promise<void>}
 */
function deleteRound(req, res) {
  return ApplicationRound.findByIdAndDelete(req.params.id)
    .then(function afterDelete(round) {
      if (!round) {
        res.status(404).json({ error: "Round not found." });
        return;
      }
      res.status(200).json({ ok: true });
    })
    .catch(function onError(err) {
      console.error("deleteRound failed:", err);
      res.status(500).json({ error: "Could not delete round." });
    });
}

// ---- Email templates ------------------------------------------------------

/**
 * GET /api/admin/email-templates
 * List all email templates.
 * @param {object} _req
 * @param {object} res
 * @returns {Promise<void>}
 */
function listEmailTemplates(_req, res) {
  return EmailTemplate.find({})
    .sort({ key: 1 })
    .then(function afterFind(templates) {
      res.status(200).json({ templates: templates.map(function mapTemplate(template) {
        return template.toJSON ? template.toJSON() : template;
      }) });
    })
    .catch(function onError(err) {
      console.error("listEmailTemplates failed:", err);
      res.status(500).json({ error: "Could not load email templates." });
    });
}

/**
 * POST /api/admin/email-templates
 * Create a new email template.
 * @param {object} req
 * @param {object} res
 * @returns {Promise<void>}
 */
function createEmailTemplate(req, res) {
  var key = req.body.key;
  var subject = req.body.subject;
  var body = req.body.body;

  return EmailTemplate.create({
    key: key,
    subject: subject || "",
    body: body || "",
  })
    .then(function afterCreate(template) {
      res.status(201).json({ template: template.toJSON ? template.toJSON() : template });
    })
    .catch(function onError(err) {
      if (err && err.code === 11000) {
        res.status(409).json({ error: "An email template with that key already exists." });
        return;
      }
      console.error("createEmailTemplate failed:", err);
      res.status(500).json({ error: "Could not create email template." });
    });
}

/**
 * PATCH /api/admin/email-templates/:id
 * Update an email template.
 * @param {object} req
 * @param {object} res
 * @returns {Promise<void>}
 */
function updateEmailTemplate(req, res) {
  var update = {};
  if (req.body && req.body.subject !== undefined) {
    update.subject = req.body.subject;
  }
  if (req.body && req.body.body !== undefined) {
    update.body = req.body.body;
  }
  if (req.body && req.body.key !== undefined) {
    update.key = req.body.key;
  }

  return EmailTemplate.findById(req.params.id)
    .then(function afterFind(existing) {
      if (!existing) {
        res.status(404).json({ error: "Email template not found." });
        return null;
      }

      // Subject and body stay editable — that is the whole point of the
      // feature. Only the key is locked, because the application and decision
      // flows look these templates up by key.
      if (update.key !== undefined && update.key !== existing.key && EmailTemplate.isBuiltInKey(existing.key)) {
        res.status(400).json({
          error: "Built-in templates cannot be renamed. Edit the subject and body instead.",
        });
        return null;
      }

      return EmailTemplate.findByIdAndUpdate(req.params.id, { $set: update }, { new: true, runValidators: true });
    })
    .then(function afterUpdate(template) {
      if (template === null) {
        return; // 404 or built-in rename, already answered above
      }
      if (!template) {
        res.status(404).json({ error: "Email template not found." });
        return;
      }
      res.status(200).json({ template: template.toJSON ? template.toJSON() : template });
    })
    .catch(function onError(err) {
      if (err && err.name === "CastError") {
        res.status(404).json({ error: "Email template not found." });
        return;
      }
      if (err && err.name === "ValidationError") {
        res.status(400).json({ error: err.message });
        return;
      }
      if (err && err.code === 11000) {
        res.status(409).json({ error: "An email template with that key already exists." });
        return;
      }
      console.error("updateEmailTemplate failed:", err);
      res.status(500).json({ error: "Could not update email template." });
    });
}

/**
 * Sample values for previews and test sends, based on the admin themselves.
 * @param {object} user - The admin's User document.
 * @returns {object}
 */
function sampleTemplateValues(user) {
  var calendar = require("../utils/calendar");
  var start = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
  return {
    name: user.name,
    status: "accepted",
    setupUrl: primaryClientOrigin() + "/reset-password?token=sample&setup=1",
    verifyUrl: primaryClientOrigin() + "/verify-email?token=sample",
    runOfShow: calendar.formatRunOfShow([
      {
        title: "Opening ceremony (sample)",
        startsAt: start,
        endsAt: new Date(start.getTime() + 60 * 60 * 1000),
        location: "Main hall",
      },
    ]),
  };
}

/**
 * Read the template being edited from the body: `{ subject, body }` (unsaved
 * edits), falling back to the stored template `:id`.
 * @param {object} req
 * @returns {Promise<object|null>} `{ subject, body }`, or null when not found.
 */
function templateFromRequest(req) {
  var hasDraft = req.body && (req.body.subject !== undefined || req.body.body !== undefined);
  if (hasDraft) {
    return Promise.resolve({ subject: String(req.body.subject || ""), body: String(req.body.body || "") });
  }
  if (!req.params.id || !mongoose.isValidObjectId(req.params.id)) {
    return Promise.resolve(null);
  }
  return EmailTemplate.findById(req.params.id).lean();
}

/**
 * POST /api/admin/email-templates/preview
 * Render `{ subject, body }` exactly as the email will look, using the admin's
 * own name and check-in QR code (shown inline as an image when the body has
 * {{qrcode}}).
 * @param {object} req
 * @param {object} res
 * @returns {Promise<void>}
 */
function previewEmailTemplate(req, res) {
  var user;
  return User.findById(req.user.id)
    .then(function afterUser(found) {
      user = found;
      if (!user) {
        res.status(401).json({ error: "Authentication required." });
        return null;
      }
      return templateFromRequest(req);
    })
    .then(function afterTemplate(template) {
      if (!user) return null;
      if (!template) {
        res.status(404).json({ error: "Email template not found." });
        return null;
      }
      var qrIdPromise = mailer.usesQrCode(template.body) ? User.ensureQrId(user._id) : Promise.resolve(null);
      return qrIdPromise
        .then(function afterQrId(qrId) {
          return mailer.renderEmail(template, sampleTemplateValues(user), { qrId: qrId, dataUrlImages: true });
        })
        .then(function afterRender(rendered) {
          res.status(200).json({
            subject: rendered.subject,
            html: rendered.html,
            text: rendered.text,
            hasQrCode: mailer.usesQrCode(template.body),
          });
        });
    })
    .catch(function onError(err) {
      console.error("previewEmailTemplate failed:", err);
      res.status(500).json({ error: "Could not render the preview." });
    });
}

/**
 * POST /api/admin/email-templates/:id/test (or /test with a draft body)
 * Send the template (or the unsaved draft `{ subject, body }`) to the admin's
 * own address through the real mailer, QR attachment included, so they can
 * check it in an actual inbox.
 * @param {object} req
 * @param {object} res
 * @returns {Promise<void>}
 */
function sendTestEmailTemplate(req, res) {
  if (!mailer.isMailConfigured()) {
    res.status(503).json({ error: "Email isn't configured on the server (SMTP_HOST / SMTP_USER)." });
    return Promise.resolve();
  }
  var user;
  return User.findById(req.user.id)
    .then(function afterUser(found) {
      user = found;
      if (!user) {
        res.status(401).json({ error: "Authentication required." });
        return null;
      }
      return templateFromRequest(req);
    })
    .then(function afterTemplate(template) {
      if (!user) return null;
      if (!template) {
        res.status(404).json({ error: "Email template not found." });
        return null;
      }
      return mailer
        .sendRenderedTemplate(
          user.email,
          { subject: "[Test] " + template.subject, body: template.body },
          sampleTemplateValues(user)
        )
        .then(function afterSend() {
          res.status(200).json({ ok: true, sentTo: user.email });
        });
    })
    .catch(function onError(err) {
      console.error("sendTestEmailTemplate failed:", err);
      res.status(502).json({ error: "The test email could not be sent: " + (err && err.message ? err.message : "unknown error") });
    });
}

/**
 * DELETE /api/admin/email-templates/:id
 * Delete an email template.
 * @param {object} req
 * @param {object} res
 * @returns {Promise<void>}
 */
function deleteEmailTemplate(req, res) {
  return EmailTemplate.findById(req.params.id)
    .then(function afterFind(existing) {
      if (!existing) {
        res.status(404).json({ error: "Email template not found." });
        return null;
      }

      if (EmailTemplate.isBuiltInKey(existing.key)) {
        res.status(400).json({
          error: "Built-in templates cannot be deleted. Edit the subject and body instead.",
        });
        return null;
      }

      return EmailTemplate.findByIdAndDelete(req.params.id);
    })
    .then(function afterDelete(template) {
      if (template === null) {
        return; // 404 or built-in delete, already answered above
      }
      if (!template) {
        res.status(404).json({ error: "Email template not found." });
        return;
      }
      res.status(200).json({ ok: true });
    })
    .catch(function onError(err) {
      if (err && err.name === "CastError") {
        res.status(404).json({ error: "Email template not found." });
        return;
      }
      console.error("deleteEmailTemplate failed:", err);
      res.status(500).json({ error: "Could not delete email template." });
    });
}

/**
 * Parse a date value using JavaScript's native Date parser.
 * @param {*} value - Raw date input from the request body.
 * @returns {Date|null} The parsed date, or null for invalid input.
 */
function parseDate(value) {
  var parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/**
 * GET /api/admin/meals — list meal services.
 * @param {object} _req
 * @param {object} res
 * @returns {Promise<void>}
 */
function listMeals(_req, res) {
  return Promise.all([MealService.find({}).sort({ startsAt: 1, createdAt: 1 }), MealCheckIn.countsByMeal()])
    .then(function afterFind(results) {
      var counts = results[1];
      res.status(200).json({
        meals: results[0].map(function withCount(meal) {
          return Object.assign(meal.toJSON(), { checkInCount: counts[String(meal._id)] || 0 });
        }),
      });
    })
    .catch(function onError(err) {
      console.error("listMeals failed:", err);
      res.status(500).json({ error: "Could not load meal services." });
    });
}

/**
 * POST /api/admin/meals — create a meal service.
 * Body: { name, startsAt, endsAt, active?, createdFor? }
 * createdFor is optional: leave it out for an event-wide meal.
 * @param {object} req
 * @param {object} res
 * @returns {Promise<void>}
 */
function createMeal(req, res) {
  var name = req.body && req.body.name;
  var createdFor = req.body && req.body.createdFor ? String(req.body.createdFor).trim() : "";
  var startsAt = req.body && req.body.startsAt;
  var endsAt = req.body && req.body.endsAt;
  var startDate = parseDate(startsAt);
  var endDate = parseDate(endsAt);
  var actorId = req.user && req.user.id ? req.user.id : null;

  if (!name) {
    res.status(400).json({ error: "name is required." });
    return Promise.resolve();
  }
  if (createdFor && !validator.isEmail(createdFor)) {
    res.status(400).json({ error: "createdFor must be a valid email address." });
    return Promise.resolve();
  }
  if (!startsAt || !endsAt) {
    res.status(400).json({ error: "startsAt and endsAt are required." });
    return Promise.resolve();
  }
  if (!startDate || !endDate) {
    res.status(400).json({ error: "startsAt and endsAt must be valid date-time values." });
    return Promise.resolve();
  }
  // getTime() returns each Date's millisecond value for numeric comparison.
  if (startDate.getTime() >= endDate.getTime()) {
    res.status(400).json({ error: "endsAt must be after startsAt." });
    return Promise.resolve();
  }
  if (!actorId) {
    res.status(401).json({ error: "Authentication required." });
    return Promise.resolve();
  }

  return MealService.findOne({
    name: name,
    createdFor: createdFor
  })
    .then(function afterLookup(existingMeal) {
      if (existingMeal) {
        res.status(409).json({ error: "A meal with this name already exists for this user." });
        return null;
      }

      return MealService.create({
        name: name,
        createdFor: createdFor,
        startsAt: startDate.toUTCString(),
        endsAt: endDate.toUTCString(),
        active: req.body.active !== undefined ? Boolean(req.body.active) : true,
        createdBy: actorId,
        updatedBy: actorId,
      }).then(function afterCreate(meal) {
        res.status(201).json({ meal: meal });
      });
    })
    .catch(function onError(err) { /*Mealservice.create-promise rejects if createdFor value and name value are both already present in a mealservice-schema document. 
      this rejection is based on mealservice schema enforcement "mealServiceSchema.index({ name: 1, createdFor: 1 }, { unique: true }); */

      if (err && err.code === 11000) { //this rejection is based
        res.status(409).json({ error: "A meal with this name already exists for this user." });
        return;
      } 
      console.error("createMeal failed:", err);
      res.status(500).json({ error: "Could not create meal service." });
    });
}

/**
 * PATCH /api/admin/meals/:id — update a meal service.
 * Body: { name?, startsAt?, endsAt?, active? }
 * @param {object} req
 * @param {object} res
 * @returns {Promise<void>}
 */
function updateMeal(req, res) {
  var update = {};
  var actorId = req.user && req.user.id ? req.user.id : null;
  var startsAt = req.body && req.body.startsAt;
  var endsAt = req.body && req.body.endsAt;
  var startDate = parseDate(startsAt);
  var endDate = parseDate(endsAt);

  if (req.body && req.body.name !== undefined) {
    update.name = req.body.name;
  }
  if (req.body && req.body.createdFor !== undefined) {
    var createdFor = req.body.createdFor ? String(req.body.createdFor).trim() : "";
    if (createdFor && !validator.isEmail(createdFor)) {
      res.status(400).json({ error: "createdFor must be a valid email address." });
      return Promise.resolve();
    }
    update.createdFor = createdFor; //a valid email address, or "" to make the meal event-wide
  }
  if (req.body && req.body.active !== undefined) {
    update.active = Boolean(req.body.active);
  }
  if (actorId) {
    update.updatedBy = actorId;
  }
  return MealService.findById(req.params.id)
    .then(function afterFind(existingMeal) {
      if (!existingMeal) {
        res.status(404).json({ error: "Meal service not found." });
        return null;
      }

      var effectiveStartsAt = startDate || parseDate(existingMeal.startsAt);
      var effectiveEndsAt = endDate || parseDate(existingMeal.endsAt);
      if (!effectiveStartsAt || !effectiveEndsAt) {
        res.status(400).json({ error: "startsAt and endsAt must be valid dates." });
        return null;
      }
      // getTime() returns each Date's millisecond value for numeric comparison.
      if (effectiveStartsAt.getTime() >= effectiveEndsAt.getTime()) {
        res.status(400).json({ error: "endsAt must be after startsAt." });
        return null;
      }

      // Store the normalized date values as UTC strings; Mongoose casts them to Date fields.
      update.startsAt = effectiveStartsAt.toUTCString();
      update.endsAt = effectiveEndsAt.toUTCString();

      return MealService.findByIdAndUpdate(req.params.id, { $set: update }, { new: true, runValidators: true });

      //find doc corresponding to that meal via its mealservice-unique ID and then update keys with new values
    })
    .then(function afterUpdate(meal) {
      if (!meal) {
        return;
      }
      res.status(200).json({ meal: meal });
    })
    .catch(function onError(err) {
      if (err && err.code === 11000) {
        res.status(409).json({ error: "A meal with this name already exists for this user." });
        return;
      }
      console.error("updateMeal failed:", err);
      res.status(500).json({ error: "Could not update meal service." });
    });
}

/**
 * DELETE /api/admin/meals/:id — remove a meal service.
 * @param {object} req
 * @param {object} res
 * @returns {Promise<void>}
 */
function deleteMeal(req, res) {
  // Once anyone has been served, deleting the meal would orphan its check-ins
  // and let a re-created copy serve the same people twice. Deactivate instead.
  return MealCheckIn.countDocuments({ mealService: req.params.id })
    .then(function afterCount(served) {
      if (served > 0) {
        res.status(409).json({
          error: "This meal already has " + served + " check-in(s). Deactivate it instead of deleting it.",
        });
        return undefined;
      }
      return MealService.findByIdAndDelete(req.params.id).then(function afterDelete(meal) {
        if (!meal) {
          res.status(404).json({ error: "Meal service not found." });
          return;
        }
        res.status(200).json({ ok: true });
      });
    })
    .catch(function onError(err) {
      console.error("deleteMeal failed:", err);
      res.status(500).json({ error: "Could not delete meal service." });
    });
}

module.exports = {
  listApplications: listApplications,
  getApplication: getApplication,
  decideApplication: decideApplication,
  flagApplication: flagApplication,
  unflagApplication: unflagApplication,
  searchUsers: searchUsers,
  setRole: setRole,
  listRounds: listRounds,
  createRound: createRound,
  updateRound: updateRound,
  deleteRound: deleteRound,
  listEmailTemplates: listEmailTemplates,
  createEmailTemplate: createEmailTemplate,
  updateEmailTemplate: updateEmailTemplate,
  deleteEmailTemplate: deleteEmailTemplate,
  previewEmailTemplate: previewEmailTemplate,
  sendTestEmailTemplate: sendTestEmailTemplate,
  listMeals: listMeals,
  createMeal: createMeal,
  updateMeal: updateMeal,
  deleteMeal: deleteMeal,
};
