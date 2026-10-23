"use strict";
var router = require("express").Router();
router.get(
  "/",
  require("../utils/isJudge"),
  require("../controllers/judgeController").status,
);
module.exports = router;
