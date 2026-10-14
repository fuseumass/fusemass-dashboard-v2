"use strict";

const User = require("../schemas/user");
const Application = require("../schemas/application");
const CheckIn = require("../schemas/checkin");
const MealService = require("../schemas/mealService");
const MealCheckIn = require("../schemas/mealCheckin");

//  POST /api/staff/checkin
/**
 * Mark that a user has been checked-in.
 */
async function checkInMark(req, res) {
  try {
    const { userId } = req.body;
    if (!userId) {
      return res.status(400).json({ error: "userId is required"});}

    const user = await User.findById(userId);
    if (!user) {
      return res.status(404).json({ error: "User not found" });
    }

    const application = await Application.findOne({ applicant: userId, status: "accepted" });
    if (!application || application.status !== "accepted") {
      return res.status(400).json({ error: "User application has not been accepted or does not exist" });
    };

    const exists = await CheckIn.findOne({ user: userId });
    if (exists) {
      return res.status(409).json({
          error: "User already checked in.",
          checkedInAt: exists.checkedInAt
      });
    }

    const checkIn = await CheckIn.create({
      user: userId,
      checkedInBy: req.user.id
    });

    return res.json({
        success: true,
        checkIn
    });

  } catch (err){
    console.error(err);
    return res.status(500).json({ error: "Server error" });
  }
}


//  POST /api/staff/meals/:mealId/checkin
/**
 * Record a check-in for a specific meal service.
 */
async function mealCheckInMark(req, res) {
  try {
    const { mealId } = req.params;
    const { userId } = req.body;

    if (!userId) {
      return res.status(400).json({ error: "userId is required" });
    }

    // meal exist check
    const meal = await MealService.findById(mealId);
    if (!meal) {
      return res.status(404).json({ error: "Meal service not found" });
    }
    if (!meal.active) {
      return res.status(400).json({ error: "Meal service is not active" });
    }

    // user exist check
    const user = await User.findById(userId);
    if (!user) {
      return res.status(404).json({ error: "User not found" });
    }

    
    const exists = await MealCheckIn.findOne({ user: userId, mealService: mealId });
    if (exists) {
      return res.status(409).json({
        error: "User already checked in for this meal.",
        checkedInAt: exists.checkedInAt
      });
    }

    // check in creation?
    const checkIn = await MealCheckIn.create({
      user: userId,
      mealService: mealId,
      checkedInBy: req.user.id
    });

    return res.json({
      success: true,
      checkIn
    });

  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Server error" });
  }
}


//  GET /api/staff/meals
/**
 * List meal services so staff can pick which one to check attendees into.
 */
async function listMealsForStaff(req, res) {
  try {
    const meals = await MealService.find({}).sort({ startsAt: 1, createdAt: 1 });
    return res.json({ meals });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Server error" });
  }
}

//   GET /api/staff/checkin/:userId 
/**
 * Returns true if user has checked in, false otherwise.
 * If true, also returns the date of check-in and userId of who checked them in.
 * */
async function getCheckInStatus (req, res) {
  try {
    const checkIn = await CheckIn.findOne({
      user: req.params.userId
    });

    if (!checkIn) {
        return res.json({
            checkedIn: false
        });
    }

    return res.json({
        checkedIn: true,
        checkedInAt: checkIn.checkedInAt,
        checkedInBy: checkIn.checkedInBy
    });
  } catch(err) {
    console.error(err);
    return res.status(500).json({ error: "Server error" });
  }
}

module.exports = {
  checkInMark: checkInMark,
  getCheckInStatus: getCheckInStatus,
  mealCheckInMark: mealCheckInMark,
  listMealsForStaff: listMealsForStaff,
};
