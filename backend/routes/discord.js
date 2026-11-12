"use strict";

var express = require("express");
var isAuthenticated = require("../utils/isAuthenticated");
var controller = require("../controllers/discordLinkController");

var router = express.Router();

// The callback uses req.user to save the Discord ID to the logged-in account.
router.post("/callback", isAuthenticated, controller);

module.exports = router;
