"use strict";

const express = require("express");
const router = express.Router();

const staffController = require("../controllers/staffController");

const isAuthenticated = require("../utils/isAuthenticated");
const isModerator = require("../utils/isModerator");

// Event-day staff routes. Only authenticated admins or moderators may look up
// attendees, check them in, or read the check-in records.

router.get(
    "/attendees",
    isAuthenticated,
    isModerator,
    staffController.searchAttendees
);

// Body: { qrId } (scanned) or { userId } (from the attendee search).
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

router.get(
    "/meals",
    isAuthenticated,
    isModerator,
    staffController.listMealsForStaff
);

// Body: { qrId } (scanned) or { userId }.
router.post(
    "/meals/:mealId/checkin",
    isAuthenticated,
    isModerator,
    staffController.mealCheckInMark
);

module.exports = router;
