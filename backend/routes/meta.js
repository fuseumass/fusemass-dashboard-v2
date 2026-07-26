"use strict";

var express = require("express");
var metaController = require("../controllers/metaController");

var router = express.Router();

// Public reference data used by the application form's autocompletes.
router.get("/config", metaController.config);
router.get("/colleges", metaController.colleges);
router.get("/skills/programming", metaController.programmingSkills);
router.get("/skills/hardware", metaController.hardwareSkills);

module.exports = router;
