"use strict";

var Application = require("../schemas/application");
var User = require("../schemas/user");

/**
 * GET /api/admin/applications
 * List every application for the review dashboard. Supports an optional
 * `?status=pending|accepted|rejected` filter.
 *
 * @param {object} req - Express request.
 * @param {object} res - Express response.
 * @returns {Promise<void>}
 */
function listApplications(req, res) {
  var filter = {};
  var status = req.query && req.query.status;
  if (status === "pending" || status === "accepted" || status === "rejected") {
    filter.status = status;
  }

  return Application.find(filter)
    .populate("applicant", "name email role")
    .populate("team")
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
 * Accept or reject a single application.
 *
 * Body: { decision: "accepted" | "rejected" }
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
  if (decision !== "accepted" && decision !== "rejected") {
    res.status(400).json({ error: "decision must be 'accepted' or 'rejected'." });
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
 * PATCH /api/admin/users/:id/role
 * Assign or revoke admin access for a user.
 *
 * Body: { role: "applicant" | "admin" }
 *
 * @param {object} req - Express request.
 * @param {object} res - Express response.
 * @returns {Promise<void>}
 */
function setRole(req, res) {
  var role = req.body && req.body.role;
  if (role !== "applicant" && role !== "admin") {
    res.status(400).json({ error: "role must be 'applicant' or 'admin'." });
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

module.exports = {
  listApplications: listApplications,
  decideApplication: decideApplication,
  setRole: setRole,
};
