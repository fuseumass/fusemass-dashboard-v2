"use strict";

var express = require("express");
var isAuthenticated = require("../utils/isAuthenticated");
var requireFeature = require("../utils/requireFeature");
var controller = require("../controllers/discordLinkController");

var router = express.Router();

// Every route links or reads the signed-in account only (req.user).
router.use(requireFeature("discord"), isAuthenticated);
router.get("/link", controller.status);
router.delete("/link", controller.unlink);
router.post("/callback", controller.callback);

module.exports = router;
