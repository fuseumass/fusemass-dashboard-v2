"use strict";
var crypto = require("crypto");
var alphabet = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
/** @param {object} workshop - Session with secret and period. @param {number} now - Milliseconds. @returns {string} Five character code. */
function workshopCode(workshop, now) {
  var step = Math.floor(now / (workshop.attendancePeriodSec * 1000));
  var bytes = crypto
    .createHmac("sha256", workshop.attendanceSecret)
    .update(String(step))
    .digest();
  var number = bytes.readUIntBE(0, 6);
  var code = "";
  for (var i = 0; i < 5; i += 1) {
    code += alphabet[number % alphabet.length];
    number = Math.floor(number / alphabet.length);
  }
  return code;
}
module.exports = workshopCode;
