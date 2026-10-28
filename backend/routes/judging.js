"use strict";
var router = require("express").Router();
router.get(
  "/",
  require("../utils/isJudge"),
  require("../controllers/judgeController").status,
);
var calibration = require("../controllers/judgingCalibrationController");
router.use(require("../utils/requireFeature")("judging"));
router.get(
  "/calibration",
  require("../utils/isJudge"),
  calibration.getCalibration,
);
router.post(
  "/calibration/:round",
  require("../utils/isJudge"),
  calibration.scoreRound,
);
module.exports = router;
