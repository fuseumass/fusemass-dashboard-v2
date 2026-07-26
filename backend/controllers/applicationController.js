"use strict";

var Application = require("../schemas/application");
var Team = require("../schemas/team");

/**
 * POST /api/applications
 * Submit the current applicant's application. This is the single action an
 * applicant can take after registering (the "Apply" button on the frontend).
 *
 * Body: {
 *   type: "individual" | "group" | "team",
 *   groupMembers?: string[],   // when type === "group"
 *   teamName?: string          // when type === "team"
 * }
 *
 * @param {object} req - Express request.
 * @param {object} res - Express response.
 * @returns {Promise<void>}
 */
function apply(req, res) {
  var claims = req.user;
  if (!claims) {
    res.status(401).json({ error: "Authentication required." });
    return Promise.resolve();
  }

  var type = req.body && req.body.type;
  if (type !== "individual" && type !== "group" && type !== "team") {
    res.status(400).json({ error: "type must be 'individual', 'group' or 'team'." });
    return Promise.resolve();
  }

  return Application.findOne({ applicant: claims.id })
    .then(function afterLookup(existing) {
      if (existing) {
        res.status(409).json({ error: "You have already submitted an application." });
        return null;
      }

      // For a team application, create the Team first, then link it.
      if (type === "team") {
        var teamName = req.body && req.body.teamName;
        if (!teamName) {
          res.status(400).json({ error: "teamName is required for a team application." });
          return null;
        }
        return Team.create({
          name: teamName,
          leader: claims.id,
          members: [claims.id],
        }).then(function afterTeam(team) {
          return Application.create({
            applicant: claims.id,
            type: "team",
            team: team._id,
          });
        });
      }

      return Application.create({
        applicant: claims.id,
        type: type,
        groupMembers: type === "group" ? req.body.groupMembers || [] : undefined,
      });
    })
    .then(function afterCreate(application) {
      if (!application) {
        return; // conflict or validation already handled
      }
      res.status(201).json({ application: application.toJSON() });
    })
    .catch(function onError(err) {
      console.error("apply failed:", err);
      res.status(500).json({ error: "Could not submit application." });
    });
}

/**
 * GET /api/applications/me
 * Return the current applicant's application (or null if they have not applied).
 * The frontend uses this to decide whether to show the "Apply" button or the
 * application's status.
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

  return Application.findOne({ applicant: claims.id })
    .populate("team")
    .then(function afterLookup(application) {
      res.status(200).json({ application: application ? application.toJSON() : null });
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
