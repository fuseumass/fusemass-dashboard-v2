"use strict";

var crypto = require("crypto");

/**
 * Rules that decide whether an application looks suspicious, as small pure
 * functions: no database, no files, everything the rule needs is passed in.
 * (The old dashboard's version of this lived inside the Application model
 * with a misplaced `!` in its university/major check, which flagged the wrong
 * applications. Keeping each rule separate and tested is the fix.)
 *
 * A flag is only a label for reviewers to look at. Nothing here ever rejects
 * or blocks an application, and every rule errs on the side of NOT flagging:
 * a missing input (no resume, text that couldn't be read) skips its rule.
 */

// The reasons automatic checks add. Moderators' own reasons are free text.
var REASONS = {
  resumeTooShort: "Resume has very little text.",
  resumeMissingName: "Resume doesn't mention the applicant's name.",
  duplicatePhone: "Phone number matches another applicant's.",
  duplicateResume: "Resume file is identical to another applicant's.",
};

// A one-page resume has well over 500 letters; this only catches blank,
// near-empty and scanned-image files.
var MIN_RESUME_LETTERS = 100;
// Shorter name parts ("Li", "Jo") turn up in any text by chance, so they
// can't prove the resume is the applicant's.
var MIN_NAME_PART_LENGTH = 3;
var MAX_REASON_LENGTH = 300;

/**
 * Lowercase letters only, accents removed: "José  Núñez-Smith" becomes
 * "josenunezsmith". Resume text from PDFs has unreliable spacing, so text is
 * compared with spacing and punctuation removed.
 *
 * @param {*} value - Any text.
 * @returns {string}
 */
function lettersOnly(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^\p{L}]/gu, "");
}

/**
 * The parts of a name worth searching a resume for.
 * @param {*} name - Full name as typed by the applicant.
 * @returns {Array<string>} Lowercase letters-only parts, 3+ letters each.
 */
function nameParts(name) {
  return String(name || "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .split(/[^\p{L}]+/u)
    .filter(function longEnough(part) {
      return part.length >= MIN_NAME_PART_LENGTH;
    });
}

/**
 * A phone number reduced to what identifies the line: its last 10 digits, so
 * "(413) 555-0100", "413.555.0100" and "+1 413 555 0100" are the same. Too few
 * digits to be a number gives "" (never compared).
 *
 * @param {*} phone - Phone number as typed.
 * @returns {string}
 */
function phoneKey(phone) {
  var digits = String(phone || "").replace(/\D/g, "");
  return digits.length < 7 ? "" : digits.slice(-10);
}

/**
 * Fingerprint of an uploaded file, to spot the same resume on two accounts.
 * @param {Buffer} buffer - File contents.
 * @returns {string} Hex SHA-256.
 */
function fileHash(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

/**
 * Problems with a resume's text: nearly empty, or not mentioning the applicant.
 *
 * @param {(string|null|undefined)} text - The resume's text; anything but a
 *   string (no resume, or text that couldn't be read) means "don't judge".
 * @param {string} name - The applicant's name.
 * @returns {Array<string>} Reasons, empty when nothing looks wrong.
 */
function resumeProblems(text, name) {
  if (typeof text !== "string") {
    return [];
  }
  var letters = lettersOnly(text);
  if (letters.length < MIN_RESUME_LETTERS) {
    return [REASONS.resumeTooShort];
  }
  var parts = nameParts(name);
  var mentioned = parts.some(function appears(part) {
    return letters.indexOf(part) !== -1;
  });
  return parts.length && !mentioned ? [REASONS.resumeMissingName] : [];
}

/**
 * Every automatic reason to flag a new submission.
 *
 * @param {object} input
 * @param {string} input.name - The applicant's name.
 * @param {(string|null)} [input.resumeText] - Text of the uploaded resume, or
 *   null/undefined when there is none or it couldn't be read.
 * @param {boolean} [input.duplicatePhone] - Another account has this phone number.
 * @param {boolean} [input.duplicateResume] - Another account uploaded this exact file.
 * @returns {Array<string>} Reasons, empty when the application looks fine.
 */
function autoFlagReasons(input) {
  var reasons = resumeProblems(input.resumeText, input.name);
  if (input.duplicatePhone) {
    reasons.push(REASONS.duplicatePhone);
  }
  if (input.duplicateResume) {
    reasons.push(REASONS.duplicateResume);
  }
  return reasons;
}

/**
 * Tidy a moderator's free-text flag reason: one line, trimmed, capped.
 * @param {*} value - Raw `reason` from the request body.
 * @returns {string} The reason, or "" when there is nothing usable.
 */
function cleanReason(value) {
  if (typeof value !== "string") {
    return "";
  }
  return value.replace(/\s+/g, " ").trim().slice(0, MAX_REASON_LENGTH);
}

module.exports = {
  REASONS: REASONS,
  MIN_RESUME_LETTERS: MIN_RESUME_LETTERS,
  MAX_REASON_LENGTH: MAX_REASON_LENGTH,
  lettersOnly: lettersOnly,
  nameParts: nameParts,
  phoneKey: phoneKey,
  fileHash: fileHash,
  resumeProblems: resumeProblems,
  autoFlagReasons: autoFlagReasons,
  cleanReason: cleanReason,
};
