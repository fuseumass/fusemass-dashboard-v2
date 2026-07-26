"use strict";

var express = require("express");
var applicationController = require("../controllers/applicationController");
var isAuthenticated = require("../utils/isAuthenticated");

var router = express.Router();

// Every application route requires the caller to be logged in.
router.post("/", isAuthenticated, applicationController.apply);
router.get("/me", isAuthenticated, applicationController.getMine);

module.exports = router;
