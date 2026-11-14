"use strict";

var express = require("express");
var communicationsController = require("../controllers/communicationsController");
var isAuthenticated = require("../utils/isAuthenticated");
var isModerator = require("../utils/isModerator");
var isAdmin = require("../utils/isAdmin");

// The Communications page: announcements to email and Discord (moderators
// and admins), and the workshop automation settings (admins change them,
// moderators see them).
var router = express.Router();

router.get("/", isAuthenticated, isModerator, communicationsController.overview);
router.get("/announcements", isAuthenticated, isModerator, communicationsController.listAnnouncements);
router.post("/preview", isAuthenticated, isModerator, communicationsController.previewAnnouncement);
router.post("/announcements", isAuthenticated, isModerator, communicationsController.createAnnouncement);
router.post("/announcements/:id/cancel", isAuthenticated, isModerator, communicationsController.cancelAnnouncement);
router.post("/announcements/:id/send-again", isAuthenticated, isModerator, communicationsController.sendAgain);
router.patch("/settings", isAuthenticated, isAdmin, communicationsController.updateSettings);

module.exports = router;
