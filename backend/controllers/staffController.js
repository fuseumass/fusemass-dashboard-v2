"use strict";

const User = require("../schemas/user");
const Application = require("../schemas/application");
const CheckIn = require("../schemas/checkin");

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
};
