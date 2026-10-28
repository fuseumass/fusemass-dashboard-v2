"use strict";
var router = require("express").Router();
router.get(
  "/",
  require("../utils/isJudge"),
  require("../controllers/judgeController").status,
);
var checkin = require("../controllers/judgingCheckinController");
var authenticated = require("../utils/isAuthenticated");
var feature = require("../utils/requireFeature")("judging");
router.get("/projects", feature, authenticated, checkin.myProjects);
router.post("/table-checkin", feature, authenticated, checkin.tableCheckin);
var scoring = require("../controllers/judgingController");
var isJudge = require("../utils/isJudge");
router.get("/queue", feature, isJudge, scoring.queue);
router.post("/scores", feature, isJudge, scoring.scores);
router.post("/skip", feature, isJudge, scoring.skip);
module.exports = router;
