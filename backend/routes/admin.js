"use strict";

var express = require("express");
var adminController = require("../controllers/adminController");
var isAdmin = require("../utils/isAdmin");

var router = express.Router();

// Every admin route requires the caller to be a logged-in admin.
router.get("/applications", isAdmin, adminController.listApplications);
router.patch("/applications/:id", isAdmin, adminController.decideApplication);
router.patch("/users/:id/role", isAdmin, adminController.setRole);

module.exports = router;
