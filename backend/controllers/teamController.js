"use strict";

var hardwareTeamChange = require("../utils/hardwareTeamChange");
var mongoose = require("mongoose");
var validator = require("validator");

var Team = require("../schemas/team");
var User = require("../schemas/user");
var Application = require("../schemas/application");
var OrgSettings = require("../schemas/orgSettings");
var mailer = require("../utils/mailer");
var primaryClientOrigin = require("../utils/clientOrigin").primaryClientOrigin;

// Hackathon teams (see schemas/team.js). Every route here is for the logged-in
// caller's own team, except listAllTeams (moderators + admins).

var DUPLICATE_KEY = 11000;

/**
 * "https://devpost.com/software/my-app/" (any case, www., http, query, hash)
 * -> "https://devpost.com/software/my-app". Only Devpost project pages count:
 * a hackathon's own page or any other site is refused.
 * @param {string} raw - What the team pasted.
 * @returns {string|null} The normalized URL, or null if it isn't one.
 */
function normalizeDevpostUrl(raw) {
  var match = /^(?:https?:\/\/)?(?:www\.)?devpost\.com\/software\/([a-z0-9][a-z0-9_-]*)\/?(?:[?#].*)?$/i.exec(
    String(raw || "").trim()
  );
  return match ? "https://devpost.com/software/" + match[1].toLowerCase() : null;
}

/**
 * @returns {Promise<number>} The admin's maximum team size.
 */
function maxTeamSize() {
  return OrgSettings.getSingleton().then(function afterLoad(settings) {
    return settings.teamMaxSize || 4;
  });
}

/**
 * The caller's team (with members and invites filled in), or null.
 * @param {string} userId - Caller's user id.
 * @returns {Promise<object|null>}
 */
function findMyTeam(userId) {
  return Team.findOne({ members: userId })
    .populate("members", "name email")
    .populate("leader", "name email")
    .populate("invites.invitedBy", "name");
}

/**
 * The JSON a member sees for their team.
 * @param {object} team - Populated Team document.
 * @param {number} maxSize - Maximum team size.
 * @returns {object}
 */
function teamView(team, maxSize) {
  return {
    _id: team._id,
    name: team.name,
    leader: team.leader ? { _id: team.leader._id, name: team.leader.name, email: team.leader.email } : null,
    members: team.members.map(function toMember(m) {
      return { _id: m._id, name: m.name, email: m.email };
    }),
    invites: team.invites.map(function toInvite(i) {
      return { email: i.email, invitedAt: i.invitedAt, invitedBy: i.invitedBy ? i.invitedBy.name : null };
    }),
    devpostUrl: team.devpostUrl || "",
    lockedAt: team.lockedAt || null,
    maxSize: maxSize,
  };
}

/**
 * Respond with the caller's team (or null) and the invites addressed to them.
 * @param {object} req - Express request.
 * @param {object} res - Express response.
 * @param {number} [status] - HTTP status (200 by default).
 * @returns {Promise<void>}
 */
function sendMine(req, res, status) {
  return Promise.all([
    findMyTeam(req.user.id),
    User.findById(req.user.id).select("email"),
    maxTeamSize(),
  ]).then(function afterLoad(results) {
    var team = results[0];
    var me = results[1];
    var maxSize = results[2];
    var email = me ? me.email : "";
    return Team.find({ "invites.email": email })
      .select("name members invites lockedAt")
      .populate("invites.invitedBy", "name")
      .then(function afterInvites(teams) {
        res.status(status || 200).json({
          team: team ? teamView(team, maxSize) : null,
          invites: teams.map(function toInvite(t) {
            var invite = t.invites.find(function mine(i) {
              return i.email === email;
            });
            return {
              teamId: t._id,
              teamName: t.name,
              lockedAt: t.lockedAt || null,
              members: t.members.length,
              invitedBy: invite && invite.invitedBy ? invite.invitedBy.name : null,
              invitedAt: invite ? invite.invitedAt : null,
            };
          }),
          maxSize: maxSize,
        });
      });
  });
}

/**
 * Turn an error into a response: duplicate keys get a clear 409.
 * @param {object} res - Express response.
 * @param {string} label - For the log.
 * @param {Error} err - The error.
 * @param {object} [duplicates] - Messages by index field, e.g. { nameKey: "..." }.
 * @returns {void}
 */
function sendError(res, label, err, duplicates) {
  if (err && err.code === DUPLICATE_KEY && duplicates) {
    var field = Object.keys(err.keyPattern || err.keyValue || {})[0];
    var message = duplicates[field];
    if (message) {
      res.status(409).json({ error: message });
      return;
    }
  }
  console.error(label + " failed:", err);
  res.status(500).json({ error: "Something went wrong with your team. Try again." });
}

var ALREADY_ON_A_TEAM = "You're already on a team. Leave it first.";

/**
 * GET /api/teams/me
 * The caller's team and the invites waiting for them.
 * @param {object} req - Express request.
 * @param {object} res - Express response.
 * @returns {Promise<void>}
 */
function getMine(req, res) {
  return sendMine(req, res).catch(function onError(err) {
    sendError(res, "getMine (team)", err);
  });
}

/**
 * POST /api/teams   Body: { name }
 * Start a team with the caller as leader.
 * @param {object} req - Express request.
 * @param {object} res - Express response.
 * @returns {Promise<void>}
 */
function createTeam(req, res) {
  var name = String((req.body && req.body.name) || "").trim().replace(/\s+/g, " ");
  if (name.length < 2 || name.length > 60) {
    res.status(400).json({ error: "Team names are 2 to 60 characters." });
    return Promise.resolve();
  }
  return Team.create({ name: name, nameKey: Team.nameKeyFor(name), leader: req.user.id, members: [req.user.id] })
    .then(function afterCreate() {
      hardwareTeamChange(req.user.id);
      return sendMine(req, res, 201);
    })
    .catch(function onError(err) {
      sendError(res, "createTeam", err, { members: ALREADY_ON_A_TEAM, nameKey: "That team name is taken." });
    });
}

/**
 * PATCH /api/teams/me   Body: { name?, devpostUrl? }
 * The leader can rename the team; any member can set or clear the Devpost
 * project link (which judging uses to match the project to the team).
 * @param {object} req - Express request.
 * @param {object} res - Express response.
 * @returns {Promise<void>}
 */
function updateMine(req, res) {
  var body = req.body || {};
  return Team.findOne({ members: req.user.id })
    .then(function afterFind(team) {
      if (!team) {
        res.status(404).json({ error: "You're not on a team." });
        return undefined;
      }
      var set = {};
      var unset = {};
      if (body.name !== undefined) {
        if (String(team.leader) !== String(req.user.id)) {
          res.status(403).json({ error: "Only the team leader can rename the team." });
          return undefined;
        }
        var name = String(body.name).trim().replace(/\s+/g, " ");
        if (name.length < 2 || name.length > 60) {
          res.status(400).json({ error: "Team names are 2 to 60 characters." });
          return undefined;
        }
        set.name = name;
        set.nameKey = Team.nameKeyFor(name);
      }
      if (body.devpostUrl !== undefined) {
        if (String(body.devpostUrl).trim() === "") {
          unset.devpostUrl = 1;
          set.devpostUpdatedAt = new Date();
        } else {
          var url = normalizeDevpostUrl(body.devpostUrl);
          if (!url) {
            res.status(400).json({
              error: "Paste your project's Devpost link, like https://devpost.com/software/your-project.",
            });
            return undefined;
          }
          set.devpostUrl = url;
          set.devpostUpdatedAt = new Date();
        }
      }
      var update = {};
      if (Object.keys(set).length) update.$set = set;
      if (Object.keys(unset).length) update.$unset = unset;
      if (!Object.keys(update).length) {
        return sendMine(req, res);
      }
      return Team.updateOne({ _id: team._id, members: req.user.id, lockedAt: null }, update).then(function afterUpdate() {
        return sendMine(req, res);
      });
    })
    .catch(function onError(err) {
      sendError(res, "updateMine (team)", err, {
        nameKey: "That team name is taken.",
        devpostUrl: "Another team has already linked that Devpost project.",
      });
    });
}

/**
 * POST /api/teams/me/invites   Body: { email }
 * Invite someone by email. Pending invites count toward the size limit.
 * @param {object} req - Express request.
 * @param {object} res - Express response.
 * @returns {Promise<void>}
 */
function invite(req, res) {
  var email = String((req.body && req.body.email) || "").trim().toLowerCase();
  if (!validator.isEmail(email)) {
    res.status(400).json({ error: "Enter a valid email address." });
    return Promise.resolve();
  }
  return Promise.all([findMyTeam(req.user.id), maxTeamSize()])
    .then(function afterLoad(results) {
      var team = results[0];
      var maxSize = results[1];
      if (!team) {
        res.status(404).json({ error: "You're not on a team." });
        return undefined;
      }
      if (team.members.some(function isMember(m) { return m.email === email; })) {
        res.status(409).json({ error: "They're already on your team." });
        return undefined;
      }
      if (team.invites.some(function isInvited(i) { return i.email === email; })) {
        res.status(409).json({ error: "You've already invited them." });
        return undefined;
      }
      // Atomic: only adds the invite while there's room and it isn't a duplicate.
      var room = {};
      room["invites." + Math.max(0, maxSize - team.members.length - 1)] = { $exists: false };
      var filter = Object.assign({ _id: team._id, lockedAt: null, members: req.user.id, "invites.email": { $ne: email } }, room);
      if (team.members.length >= maxSize) {
        res.status(400).json({ error: "Your team is full (" + maxSize + " people)." });
        return undefined;
      }
      return Team.findOneAndUpdate(
        filter,
        { $push: { invites: { email: email, invitedBy: req.user.id, invitedAt: new Date() } } },
        { new: true }
      ).then(function afterPush(updated) {
        if (!updated) {
          res.status(400).json({
            error: "Your team is full (" + maxSize + " people, counting pending invites). Cancel an invite to send a new one.",
          });
          return undefined;
        }
        var inviter = team.members.find(function isMe(m) {
          return String(m._id) === String(req.user.id);
        });
        mailer
          .sendTemplateEmail(email, "team_invite", {
            inviterName: inviter ? inviter.name : "A teammate",
            teamName: team.name,
            teamsUrl: primaryClientOrigin() + "/dashboard/team",
          })
          .catch(function onMailError(err) {
            console.error("Failed to send team invite email:", err);
          });
        return sendMine(req, res, 201);
      });
    })
    .catch(function onError(err) {
      sendError(res, "invite (team)", err);
    });
}

/**
 * DELETE /api/teams/me/invites/:email
 * Cancel a pending invite (any member).
 * @param {object} req - Express request.
 * @param {object} res - Express response.
 * @returns {Promise<void>}
 */
function cancelInvite(req, res) {
  var email = String(req.params.email || "").trim().toLowerCase();
  return Team.updateOne({ members: req.user.id, lockedAt: null }, { $pull: { invites: { email: email } } })
    .then(function afterPull(result) {
      if (!result.matchedCount) {
        res.status(404).json({ error: "You're not on a team." });
        return undefined;
      }
      return sendMine(req, res);
    })
    .catch(function onError(err) {
      sendError(res, "cancelInvite", err);
    });
}

/**
 * POST /api/teams/invites/:teamId/accept
 * Join the team that invited the caller's email, if it still has room. The
 * unique index on members turns "already on a team" races into a clean 409.
 * @param {object} req - Express request.
 * @param {object} res - Express response.
 * @returns {Promise<void>}
 */
function acceptInvite(req, res) {
  if (!mongoose.isValidObjectId(req.params.teamId)) {
    res.status(404).json({ error: "That invite doesn't exist anymore." });
    return Promise.resolve();
  }
  return Promise.all([User.findById(req.user.id).select("email"), maxTeamSize(), Team.exists({ members: req.user.id })])
    .then(function afterLoad(results) {
      var me = results[0];
      var maxSize = results[1];
      if (!me) {
        res.status(401).json({ error: "Authentication required." });
        return undefined;
      }
      if (results[2]) {
        res.status(409).json({ error: ALREADY_ON_A_TEAM });
        return undefined;
      }
      var full = {};
      full["members." + (maxSize - 1)] = { $exists: false };
      return Team.findOneAndUpdate(
        Object.assign({ _id: req.params.teamId, lockedAt: null, "invites.email": me.email }, full),
        { $push: { members: me._id }, $pull: { invites: { email: me.email } } },
        { new: true }
      ).then(function afterJoin(team) {
        if (team) {
          hardwareTeamChange(req.user.id);
          return sendMine(req, res);
        }
        return Team.findOne({ _id: req.params.teamId, lockedAt: null, "invites.email": me.email }).then(function why(stillInvited) {
          res.status(stillInvited ? 400 : 404).json({
            error: stillInvited ? "That team is full." : "That invite doesn't exist anymore.",
          });
        });
      });
    })
    .catch(function onError(err) {
      sendError(res, "acceptInvite", err, { members: ALREADY_ON_A_TEAM });
    });
}

/**
 * POST /api/teams/invites/:teamId/decline
 * @param {object} req - Express request.
 * @param {object} res - Express response.
 * @returns {Promise<void>}
 */
function declineInvite(req, res) {
  if (!mongoose.isValidObjectId(req.params.teamId)) {
    return sendMine(req, res).catch(function onError(err) {
      sendError(res, "declineInvite", err);
    });
  }
  return User.findById(req.user.id)
    .select("email")
    .then(function afterMe(me) {
      return Team.updateOne({ _id: req.params.teamId }, { $pull: { invites: { email: me ? me.email : "" } } });
    })
    .then(function afterPull() {
      return sendMine(req, res);
    })
    .catch(function onError(err) {
      sendError(res, "declineInvite", err);
    });
}

/**
 * POST /api/teams/me/leave
 * Leave the team. A leaving leader hands over to the next member; the last
 * person out deletes the team.
 * @param {object} req - Express request.
 * @param {object} res - Express response.
 * @returns {Promise<void>}
 */
function leave(req, res) {
  return Team.findOneAndUpdate({ members: req.user.id, lockedAt: null }, { $pull: { members: req.user.id } }, { new: true })
    .then(function afterPull(team) {
      if (!team) {
        res.status(404).json({ error: "You're not on a team." });
        return undefined;
      }
      var next;
      if (!team.members.length) {
        next = Team.deleteOne({ _id: team._id });
      } else if (String(team.leader) === String(req.user.id)) {
        next = Team.updateOne({ _id: team._id }, { $set: { leader: team.members[0] } });
      } else {
        next = Promise.resolve();
      }
      return next.then(function afterLeave() {
        hardwareTeamChange(req.user.id);
        return sendMine(req, res);
      });
    })
    .catch(function onError(err) {
      sendError(res, "leave (team)", err);
    });
}

/**
 * DELETE /api/teams/me/members/:userId
 * The leader removes someone from the team.
 * @param {object} req - Express request.
 * @param {object} res - Express response.
 * @returns {Promise<void>}
 */
function removeMember(req, res) {
  if (!mongoose.isValidObjectId(req.params.userId)) {
    res.status(404).json({ error: "They're not on your team." });
    return Promise.resolve();
  }
  if (String(req.params.userId) === String(req.user.id)) {
    res.status(400).json({ error: "Use Leave team to remove yourself." });
    return Promise.resolve();
  }
  return Team.findOne({ members: req.user.id })
    .then(function afterFind(team) {
      if (!team) {
        res.status(404).json({ error: "You're not on a team." });
        return undefined;
      }
      if (String(team.leader) !== String(req.user.id)) {
        res.status(403).json({ error: "Only the team leader can remove members." });
        return undefined;
      }
      return Team.updateOne({ _id: team._id, lockedAt: null }, { $pull: { members: req.params.userId } }).then(function afterPull(result) {
        if (!result.modifiedCount) {
          res.status(404).json({ error: "They're not on your team." });
          return undefined;
        }
        hardwareTeamChange(req.params.userId);
        return sendMine(req, res);
      });
    })
    .catch(function onError(err) {
      sendError(res, "removeMember (team)", err);
    });
}

/**
 * GET /api/admin/teams (moderators + admins)
 * Every team with its members' application status and Devpost link, for
 * staff and for matching projects in judging.
 * @param {object} _req - Express request.
 * @param {object} res - Express response.
 * @returns {Promise<void>}
 */
function listAllTeams(_req, res) {
  return Team.find({})
    .select("name leader members invites devpostUrl createdAt")
    .populate("members", "name email")
    .sort({ createdAt: 1 })
    .lean()
    .then(function afterFind(teams) {
      var ids = [];
      teams.forEach(function collect(t) {
        t.members.forEach(function add(m) {
          ids.push(m._id);
        });
      });
      return Application.find({ applicant: { $in: ids } })
        .select("applicant status")
        .lean()
        .then(function afterApps(apps) {
          // Show "accepted" if any of someone's applications was accepted.
          var status = {};
          apps.forEach(function note(a) {
            var key = String(a.applicant);
            if (status[key] !== "accepted") status[key] = a.status;
          });
          res.status(200).json({
            teams: teams.map(function toRow(t) {
              return {
                _id: t._id,
                name: t.name,
                devpostUrl: t.devpostUrl || "",
                pendingInvites: (t.invites || []).length,
                createdAt: t.createdAt,
                members: t.members.map(function toMember(m) {
                  return {
                    _id: m._id,
                    name: m.name,
                    email: m.email,
                    leader: String(m._id) === String(t.leader),
                    applicationStatus: status[String(m._id)] || "none",
                  };
                }),
              };
            }),
          });
        });
    })
    .catch(function onError(err) {
      sendError(res, "listAllTeams", err);
    });
}

var LOCKED_MESSAGE = "Your team is checked in for judging. Ask at the help desk to change your team.";
/** @param {function} handler - Self-service mutation. @returns {function} Serialized handler that refuses checked-in teams. */
function guarded(handler) {
  return async function unlockedTeam(req, res) {
    try {
      return await require("../utils/judging/state").locked(async function mutateTeam() {
        var ids = [{ members: req.user.id }];
        if (mongoose.isValidObjectId(req.params.teamId)) ids.push({ _id: req.params.teamId });
        if (await Team.exists({ $or: ids, lockedAt: { $ne: null } })) return res.status(423).json({ error: LOCKED_MESSAGE });
        return await handler(req, res);
      });
    } catch (err) {
      if (res.headersSent) return;
      if (err.status) return res.status(err.status).json({ error: err.message });
      sendError(res, "team lock", err);
    }
  };
}
module.exports = {
  normalizeDevpostUrl: normalizeDevpostUrl,
  getMine: getMine,
  createTeam: guarded(createTeam),
  updateMine: guarded(updateMine),
  invite: guarded(invite),
  cancelInvite: guarded(cancelInvite),
  acceptInvite: guarded(acceptInvite),
  declineInvite: guarded(declineInvite),
  leave: guarded(leave),
  removeMember: guarded(removeMember),
  listAllTeams: listAllTeams,
};
