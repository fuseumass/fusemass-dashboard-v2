"use strict";

var express = require("express");
var exportController = require("../controllers/exportController");
var isAdmin = require("../utils/isAdmin");

// Data exports, mounted at /api/admin/exports. They contain personal data, so
// every route here is admin-only (moderators review applications but do not
// get bulk downloads).
var router = express.Router();

router.use(isAdmin);

router.get("/applications.csv", exportController.exportApplications);
router.get("/checkins.csv", exportController.exportCheckIns);
router.get("/meals.csv", exportController.exportMeals);
router.get("/resumes.zip", exportController.exportResumes);

module.exports = router;
