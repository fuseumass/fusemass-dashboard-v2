"use strict";

var Application = require("../schemas/application");
var ApplicationRound = require("../schemas/applicationRound");
var MealService = require("../schemas/mealService");
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
 * Body: { name, startsAt, endsAt, active?, createdFor? }
 * @param {object} req
 * @param {object} res
 * @returns {Promise<void>}
 */
function createMeal(req, res) {
  var name = req.body && req.body.name;
  var startsAt = req.body && req.body.startsAt;
  var endsAt = req.body && req.body.endsAt;
  var createdFor = req.body && req.body.createdFor ? String(req.body.createdFor).trim() : "";
  var actorId = req.user && req.user.id ? req.user.id : null;

  if (!name) {
    res.status(400).json({ error: "name is required." });
    return Promise.resolve();
  }
  if (!startsAt || !endsAt) {
    res.status(400).json({ error: "startsAt and endsAt are required." });
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
        createdFor: createdFor,
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
 * Body: { name?, startsAt?, endsAt?, active?, createdFor? }
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
  if (req.body && req.body.createdFor !== undefined) {
    update.createdFor = String(req.body.createdFor).trim();
  }
  if (actorId) {
    update.updatedBy = actorId;
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
  listMeals: listMeals,
  createMeal: createMeal,
  updateMeal: updateMeal,
  deleteMeal: deleteMeal,
};
