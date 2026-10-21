"use strict";

// CSV building and streaming for the admin exports (controllers/exportController).
//
// Exports hold personal data and get opened in Excel or Google Sheets, so two
// things matter here beyond RFC 4180 quoting:
//   - Formula injection: a cell that starts with = + - @ (or a tab / carriage
//     return) is run as a formula by spreadsheet apps. An applicant typing
//     =HYPERLINK(...) as their name must not turn the organizer's export into
//     an attack, so such text gets a leading apostrophe (shown as plain text).
//   - Size: exports are written in batches with backpressure, never built as
//     one string in memory.

// Excel needs a byte-order mark to read UTF-8 (names with accents) correctly.
var BOM = "﻿";

// First characters spreadsheet apps treat as the start of a formula.
var FORMULA_START = /^[=+\-@\t\r]/;

/**
 * Make text safe to open in a spreadsheet: text that would be read as a
 * formula gets a leading apostrophe.
 * @param {string} text - Cell text.
 * @returns {string}
 */
function neutralizeFormula(text) {
  return FORMULA_START.test(text) ? "'" + text : text;
}

/**
 * Turn one value into a CSV cell: formula-safe, and quoted when it holds a
 * comma, quote or line break. Numbers are written as numbers (a real -5 is
 * not a formula); dates as ISO 8601; booleans as true/false; lists joined
 * with "; "; null/undefined as an empty cell.
 * @param {*} value - Any value.
 * @returns {string}
 */
function formatCell(value) {
  var text;
  if (value === null || value === undefined) {
    return "";
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? String(value) : "";
  }
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? "" : value.toISOString();
  }
  if (Array.isArray(value)) {
    text = value
      .map(function toText(item) {
        return item === null || item === undefined ? "" : String(item);
      })
      .join("; ");
  } else {
    text = String(value);
  }
  text = neutralizeFormula(text);
  return /[",\r\n]/.test(text) ? '"' + text.replace(/"/g, '""') + '"' : text;
}

/**
 * @param {Array} values - One row's values.
 * @returns {string} The row as a CSV line, CRLF-terminated.
 */
function formatRow(values) {
  return values.map(formatCell).join(",") + "\r\n";
}

/**
 * @param {string} base - Name without extension, e.g. "applications".
 * @param {string} extension - e.g. "csv".
 * @returns {string} e.g. "applications-2026-10-21.csv" (today, UTC).
 */
function datedFilename(base, extension) {
  return base + "-" + new Date().toISOString().slice(0, 10) + "." + extension;
}

/**
 * Write a chunk to a response, waiting for it to drain when the client is
 * slower than we are. Rejects if the client went away.
 * @param {object} res - Node/Express response.
 * @param {string|Buffer} chunk - Data to send.
 * @returns {Promise<void>}
 */
function writeChunk(res, chunk) {
  return new Promise(function executor(resolve, reject) {
    if (res.destroyed || res.writableEnded) {
      reject(new Error("The client closed the connection."));
      return;
    }
    function cleanup() {
      res.removeListener("drain", onDrain);
      res.removeListener("close", onClose);
    }
    function onDrain() {
      cleanup();
      resolve();
    }
    function onClose() {
      cleanup();
      reject(new Error("The client closed the connection."));
    }
    if (res.write(chunk)) {
      resolve();
      return;
    }
    res.on("drain", onDrain);
    res.on("close", onClose);
  });
}

/**
 * Set the headers of a file download. Personal data, so never cached.
 * @param {object} res - Express response.
 * @param {string} contentType - e.g. "text/csv; charset=utf-8".
 * @param {string} filename - Plain ASCII, no quotes.
 * @returns {void}
 */
function setDownloadHeaders(res, contentType, filename) {
  res.status(200);
  res.set({
    "Content-Type": contentType,
    "Content-Disposition": 'attachment; filename="' + filename + '"',
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
}

/**
 * Stream a CSV download. Rows come from `nextRows`, called repeatedly until it
 * returns an empty list, so a large collection is read and sent in batches.
 * The first batch is fetched before any header is sent, so a failing query is
 * still a clean 500 JSON error; a failure after that can only cut the
 * download short (the connection is dropped, so the file is visibly broken
 * rather than silently truncated).
 *
 * @param {object} res - Express response.
 * @param {object} options
 * @param {string} options.filename - Download name, e.g. "applications-2026-10-21.csv".
 * @param {Array<string>} options.header - Column headings.
 * @param {function(): Promise<Array<Array>>} options.nextRows - Next batch of
 *   rows (each an array of cell values); an empty array means done.
 * @returns {Promise<void>}
 */
async function sendCsv(res, options) {
  var closed = false;
  res.on("close", function onClose() {
    closed = true;
  });

  try {
    var rows = await options.nextRows();
    setDownloadHeaders(res, "text/csv; charset=utf-8", options.filename);
    await writeChunk(res, BOM + formatRow(options.header));
    while (rows.length) {
      await writeChunk(res, rows.map(formatRow).join(""));
      rows = await options.nextRows();
    }
    res.end();
  } catch (err) {
    if (closed) {
      return;
    }
    console.error("CSV export failed:", err);
    if (res.headersSent) {
      res.destroy(err);
    } else {
      res.status(500).json({ error: "Could not build the export." });
    }
  }
}

module.exports = {
  BOM: BOM,
  neutralizeFormula: neutralizeFormula,
  formatCell: formatCell,
  formatRow: formatRow,
  datedFilename: datedFilename,
  writeChunk: writeChunk,
  setDownloadHeaders: setDownloadHeaders,
  sendCsv: sendCsv,
};
