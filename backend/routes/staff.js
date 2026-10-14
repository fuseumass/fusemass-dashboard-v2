"use strict";

const express = require("express");
const router = express.Router();

const staffController = require("../controllers/staffController");

const isAuthenticated = require("../utils/isAuthenticated");
const isModerator = require("../utils/isModerator");

// Only authenticated admins or moderators may check in a participant or access the check in records.

router.post(
    "/checkin",
    isAuthenticated,
    isModerator,
    staffController.checkInMark
);

router.get(
    "/checkin/:userId",
    isAuthenticated,
    isModerator,
    staffController.getCheckInStatus
);

router.post(
    "/meals/:mealId/checkin",
    isAuthenticated,
    isModerator,
    staffController.mealCheckInMark
);

router.get(
    "/meals",
    isAuthenticated,
    isModerator,
    staffController.listMealsForStaff
);

module.exports = router;
