"use strict";

var Application = require("../schemas/application");
var ApplicationRound = require("../schemas/applicationRound");
var EmailTemplate = require("../schemas/emailTemplate");
var User = require("../schemas/user");

var DECISIONS = ["accepted", "rejected", "waitlisted", "pending"];

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
  var validStatus = ["draft", "pending", "accepted", "rejected", "waitlisted"];
  if (status && validStatus.indexOf(status) !== -1) {
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

  var decision = req.body && req.body.decision;
  if (DECISIONS.indexOf(decision) === -1) {
    res.status(400).json({ error: "decision must be one of " + DECISIONS.join(", ") + "." });
    return Promise.resolve();
  }

  return Application.findByIdAndUpdate(
    req.params.id,
    {
      status: decision,
      reviewedBy: admin.id,
      reviewedAt: new Date(),
    },
    { new: true }
  )
    .then(function afterUpdate(application) {
      if (!application) {
        res.status(404).json({ error: "Application not found." });
        return;
      }
      res.status(200).json({ application: application.toJSON() });
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
  var role = req.body && req.body.role;
  var validRoles = ["applicant", "moderator", "admin"];
  if (validRoles.indexOf(role) === -1) {
    res.status(400).json({ error: "role must be one of " + validRoles.join(", ") + "." });
    return Promise.resolve();
  }

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
  var name = req.body && req.body.name;
  if (!name) {
    res.status(400).json({ error: "name is required." });
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
  var key = req.body && req.body.key;
  var subject = req.body && req.body.subject;
  var body = req.body && req.body.body;

  if (!key) {
    res.status(400).json({ error: "key is required." });
    return Promise.resolve();
  }

  return EmailTemplate.create({
    key: key,
    subject: subject || "",
    body: body || "",
  })
    .then(function afterCreate(template) {
      res.status(201).json({ template: template.toJSON ? template.toJSON() : template });
    })
    .catch(function onError(err) {
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

  return EmailTemplate.findByIdAndUpdate(req.params.id, { $set: update }, { new: true })
    .then(function afterUpdate(template) {
      if (!template) {
        res.status(404).json({ error: "Email template not found." });
        return;
      }
      res.status(200).json({ template: template.toJSON ? template.toJSON() : template });
    })
    .catch(function onError(err) {
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
  return EmailTemplate.findByIdAndDelete(req.params.id)
    .then(function afterDelete(template) {
      if (!template) {
        res.status(404).json({ error: "Email template not found." });
        return;
      }
      res.status(200).json({ ok: true });
    })
    .catch(function onError(err) {
      console.error("deleteEmailTemplate failed:", err);
      res.status(500).json({ error: "Could not delete email template." });
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
};
