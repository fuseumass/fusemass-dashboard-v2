"use strict";

var express = require("express");
var metaController = require("../controllers/metaController");
var brandingController = require("../controllers/brandingController");
var isAuthenticated = require("../utils/isAuthenticated");

var router = express.Router();

// Public reference data used by the application form's autocompletes.
router.get("/config", metaController.config);
router.get("/colleges", metaController.colleges);
router.get("/skills/programming", metaController.programmingSkills);
router.get("/skills/hardware", metaController.hardwareSkills);

// Runtime branding + module flags (cacheable ~60 s), and the uploaded logo /
// favicon files it points at.
router.get("/branding", brandingController.getBranding);
router.get("/branding/files/:file", brandingController.getFile);

// Community links (Discord, mentorship) for logged-in participants.
router.get("/links", isAuthenticated, metaController.links);

module.exports = router;
