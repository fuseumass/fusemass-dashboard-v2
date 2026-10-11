"use strict";

var Application = require("../schemas/application");
var ApplicationRound = require("../schemas/applicationRound");
var EmailTemplate = require("../schemas/emailTemplate");
var MealService = require("../schemas/mealService");
var User = require("../schemas/user");
var mailer = require("../utils/mailer");
var formConfigUtil = require("../utils/formConfig");
var applicationStatus = require("../utils/applicationStatus");

var DECISION_TEMPLATE_KEYS = {
  accepted: "application_accepted",
  rejected: "application_rejected",
};

/**
 * GET /api/admin/applications
 * List applications for the review dashboard. Optional filters:
 *   ?status=draft|pending|accepted|rejected|waitlisted
 *   ?round=<roundId>
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

  return Application.find(filter)
    .populate("applicant", "name email role")
    .populate("round", "name")
    .sort({ createdAt: -1 })
    .then(function afterFind(applications) {
      res.status(200).json({ applications: applications });
    })
    .catch(function onError(err) {
      console.error("listApplications failed:", err);
      res.status(500).json({ error: "Could not load applications." });
    });
}

/**
 * PATCH /api/admin/applications/:id
 * Set an application's review status.
 *
 * Body: { decision: "accepted" | "rejected" | "waitlisted" | "pending" }
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

  return Application.findById(req.params.id)
    .then(function afterFind(existing) {
      if (!existing) {
        res.status(404).json({ error: "Application not found." });
        return null;
      }

      var previousStatus = existing.status;

      return Application.findByIdAndUpdate(
        req.params.id,
        {
          status: decision,
          reviewedBy: admin.id,
          reviewedAt: new Date(),
        },
        { new: true }
      )
        .populate("applicant", "name email role")
        .then(function afterUpdate(application) {
          res.status(200).json({ application: application.toJSON() });

          // Idempotent: only fire when the decision actually changes the
          // status (re-clicking the same decision must not re-send).
          var templateKey = DECISION_TEMPLATE_KEYS[decision];
          var recipient = application.applicant && application.applicant.email;
          if (templateKey && decision !== previousStatus && recipient) {
            mailer
              .sendTemplateEmail(recipient, templateKey, {
                name: application.name,
                status: application.status,
              })
              .catch(function onMailError(err) {
                console.error("Failed to send decision email:", err);
              });
          }
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
 * Body: { name, description?, isOpen?, opensAt?, closesAt?, order? }
 * @param {object} req
 * @param {object} res
 * @returns {Promise<void>}
 */
function createRound(req, res) {
  var name = req.body.name;

  var formConfigCheck = formConfigUtil.validateFormConfigShape(req.body.formConfig);
  if (formConfigCheck.errors.length) {
    res.status(400).json({ error: formConfigCheck.errors.join(" ") });
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
 * Body: any of { name, description, isOpen, opensAt, closesAt, order }
 * @param {object} req
 * @param {object} res
 * @returns {Promise<void>}
 */
function updateRound(req, res) {
  var allowed = ["name", "description", "isOpen", "opensAt", "closesAt", "order", "formConfig"];
  var update = {};
  allowed.forEach(function pick(key) {
    if (req.body && req.body[key] !== undefined) {
      update[key] = req.body[key];
    }
  });

  var formConfigCheck = formConfigUtil.validateFormConfigShape(update.formConfig);
  if (formConfigCheck.errors.length) {
    res.status(400).json({ error: formConfigCheck.errors.join(" ") });
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
 * Whether a value parses to a real date (new Date("nope") is Invalid Date).
 * @param {*} value - Raw date input from the request body.
 * @returns {boolean} True when the value is a usable date.
 */
function isValidDate(value) {
  return !Number.isNaN(new Date(value).getTime());
}

/**
 * GET /api/admin/meals — list meal services.
 * @param {object} _req
 * @param {object} res
 * @returns {Promise<void>}
 */
function listMeals(_req, res) {
  return MealService.find({})
    .sort({ startsAt: 1, createdAt: 1 })
    .then(function afterFind(meals) {
      res.status(200).json({ meals: meals });
    })
    .catch(function onError(err) {
      console.error("listMeals failed:", err);
      res.status(500).json({ error: "Could not load meal services." });
    });
}

/**
 * POST /api/admin/meals — create a meal service.
 * Body: { name, startsAt, endsAt, active? }
 * @param {object} req
 * @param {object} res
 * @returns {Promise<void>}
 */
function createMeal(req, res) {
  var name = req.body && req.body.name;
  var startsAt = req.body && req.body.startsAt;
  var endsAt = req.body && req.body.endsAt;
  var actorId = req.user && req.user.id ? req.user.id : null;

  if (!name) {
    res.status(400).json({ error: "name is required." });
    return Promise.resolve();
  }
  if (!startsAt || !endsAt) {
    res.status(400).json({ error: "startsAt and endsAt are required." });
    return Promise.resolve();
  }
  if (!isValidDate(startsAt) || !isValidDate(endsAt)) {
    res.status(400).json({ error: "startsAt and endsAt must be valid dates." });
    return Promise.resolve();
  }
  if (!actorId) {
    res.status(401).json({ error: "Authentication required." });
    return Promise.resolve();
  }

  return MealService.findOne({
    name: name,
    $or: [{ createdBy: actorId }, { updatedBy: actorId }],
  })
    .then(function afterLookup(existingMeal) {
      if (existingMeal) {
        res.status(409).json({ error: "A meal with this name already exists for this user." });
        return null;
      }

      return MealService.create({
        name: name,
        startsAt: new Date(startsAt),
        endsAt: new Date(endsAt),
        active: req.body.active !== undefined ? Boolean(req.body.active) : true,
        createdBy: actorId,
        updatedBy: actorId,
      }).then(function afterCreate(meal) {
        res.status(201).json({ meal: meal });
      });
    })
    .catch(function onError(err) {
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
  if (req.body && req.body.name !== undefined) {
    update.name = req.body.name;
  }
  if (req.body && req.body.startsAt !== undefined) {
    update.startsAt = new Date(req.body.startsAt);
  }
  if (req.body && req.body.endsAt !== undefined) {
    update.endsAt = new Date(req.body.endsAt);
  }
  if (req.body && req.body.active !== undefined) {
    update.active = Boolean(req.body.active);
  }
  if (actorId) {
    update.updatedBy = actorId;
  }
  if (
    (req.body && req.body.startsAt !== undefined && !isValidDate(req.body.startsAt)) ||
    (req.body && req.body.endsAt !== undefined && !isValidDate(req.body.endsAt))
  ) {
    res.status(400).json({ error: "startsAt and endsAt must be valid dates." });
    return Promise.resolve();
  }

  return MealService.findByIdAndUpdate(req.params.id, { $set: update }, { new: true })
    .then(function afterUpdate(meal) {
      if (!meal) {
        res.status(404).json({ error: "Meal service not found." });
        return;
      }
      res.status(200).json({ meal: meal });
    })
    .catch(function onError(err) {
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
  return MealService.findByIdAndDelete(req.params.id)
    .then(function afterDelete(meal) {
      if (!meal) {
        res.status(404).json({ error: "Meal service not found." });
        return;
      }
      res.status(200).json({ ok: true });
    })
    .catch(function onError(err) {
      console.error("deleteMeal failed:", err);
      res.status(500).json({ error: "Could not delete meal service." });
    });
}

module.exports = {
  listApplications: listApplications,
  decideApplication: decideApplication,
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
  listMeals: listMeals,
  createMeal: createMeal,
  updateMeal: updateMeal,
  deleteMeal: deleteMeal,
};
