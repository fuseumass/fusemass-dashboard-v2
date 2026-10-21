"use strict";

var express = require("express");
var teamController = require("../controllers/teamController");
var isAuthenticated = require("../utils/isAuthenticated");
var authRateLimit = require("../utils/authRateLimit");

var router = express.Router();

// The logged-in caller's own team. (Staff see every team at GET /api/admin/teams.)
router.get("/me", isAuthenticated, teamController.getMine);
router.post("/", isAuthenticated, teamController.createTeam);
router.patch("/me", isAuthenticated, teamController.updateMine);
router.post("/me/leave", isAuthenticated, teamController.leave);
router.delete("/me/members/:userId", isAuthenticated, teamController.removeMember);

// Invites. Sending one emails the invitee, so it's rate limited.
router.post("/me/invites", isAuthenticated, authRateLimit.teamInvite, teamController.invite);
router.delete("/me/invites/:email", isAuthenticated, teamController.cancelInvite);
router.post("/invites/:teamId/accept", isAuthenticated, teamController.acceptInvite);
router.post("/invites/:teamId/decline", isAuthenticated, teamController.declineInvite);

module.exports = router;
