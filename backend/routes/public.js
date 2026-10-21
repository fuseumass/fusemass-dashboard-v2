"use strict";

var express = require("express");
var publicController = require("../controllers/publicController");

// Public, read-only feeds for the hackathon website. No authentication; see
// controllers/publicController.js for what may be exposed here.
var router = express.Router();

router.get("/schedule", publicController.getSchedule);
router.get("/schedule.ics", publicController.getScheduleIcs);

module.exports = router;
