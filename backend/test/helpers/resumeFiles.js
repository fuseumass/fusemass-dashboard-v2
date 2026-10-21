"use strict";

var zlib = require("zlib");

// Builders for tiny but real resume files (a .docx and PDFs), so the text
// extraction and the automatic application checks can be tested end to end
// without binary fixtures in the repository.

// A table-driven CRC-32 (the zip format wants one; Node's zlib.crc32 is only in newer 22.x).
var CRC_TABLE = (function buildTable() {
  var table = [];
  for (var n = 0; n < 256; n++) {
    var c = n;
    for (var k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table.push(c >>> 0);
  }
  return table;
})();

/**
 * @param {Buffer} buffer - Data.
 * @returns {number} Its CRC-32.
 */
function crc32(buffer) {
  var crc = 0xffffffff;
  for (var i = 0; i < buffer.length; i++) {
    crc = CRC_TABLE[(crc ^ buffer[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/**
 * Build a zip archive.
 * @param {object} files - `{ "path/in/zip": string|Buffer }`.
 * @param {object} [options]
 * @param {boolean} [options.store] - Store entries uncompressed.
 * @returns {Buffer}
 */
function makeZip(files, options) {
  var store = Boolean(options && options.store);
  var locals = [];
  var centrals = [];
  var offset = 0;

  Object.keys(files).forEach(function add(name) {
    var data = Buffer.from(files[name]);
    var packed = store ? data : zlib.deflateRawSync(data);
    var nameBuffer = Buffer.from(name);

    var local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(store ? 0 : 8, 8);
    local.writeUInt32LE(crc32(data), 14);
    local.writeUInt32LE(packed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuffer.length, 26);
    locals.push(local, nameBuffer, packed);

    var central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(store ? 0 : 8, 10);
    central.writeUInt32LE(crc32(data), 16);
    central.writeUInt32LE(packed.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuffer.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBuffer);

    offset += 30 + nameBuffer.length + packed.length;
  });

  var centralBuffer = Buffer.concat(centrals);
  var end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(files).length, 8);
  end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(centralBuffer.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat(locals.concat([centralBuffer, end]));
}

/**
 * @param {string} text - Plain text.
 * @returns {string} XML-escaped text.
 */
function xmlEscape(text) {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * A minimal Word document.
 * @param {Array<string>} paragraphs - Body paragraphs.
 * @param {object} [options]
 * @param {string} [options.header] - Text for a header part.
 * @returns {Buffer}
 */
function makeDocx(paragraphs, options) {
  var body = paragraphs
    .map(function toParagraph(text) {
      return "<w:p><w:r><w:t xml:space=\"preserve\">" + xmlEscape(text) + "</w:t></w:r></w:p>";
    })
    .join("");
  var files = {
    "[Content_Types].xml": "<Types></Types>",
    "word/document.xml":
      '<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>' +
      body +
      "</w:body></w:document>",
  };
  if (options && options.header) {
    files["word/header1.xml"] =
      '<w:hdr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:p><w:r><w:t>' +
      xmlEscape(options.header) +
      "</w:t></w:r></w:p></w:hdr>";
  }
  return makeZip(files);
}

/**
 * A minimal PDF with one page whose content stream is given as-is.
 * @param {string} content - Content stream operators.
 * @param {object} [options]
 * @param {boolean} [options.compress=true] - Flate-compress the stream.
 * @param {string} [options.filter] - Declare this filter instead (e.g. "/ASCII85Decode").
 * @param {boolean} [options.encrypted] - Add an /Encrypt entry to the trailer.
 * @returns {Buffer}
 */
function makePdf(content, options) {
  var opts = options || {};
  var compress = opts.compress !== false && !opts.filter;
  var data = compress ? zlib.deflateSync(Buffer.from(content, "latin1")) : Buffer.from(content, "latin1");
  var filter = opts.filter ? " /Filter [" + opts.filter + "]" : compress ? " /Filter /FlateDecode" : "";
  return Buffer.concat([
    Buffer.from(
      "%PDF-1.4\n" +
        "1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n" +
        "2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n" +
        "3 0 obj\n<< /Type /Page /Parent 2 0 R /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>\nendobj\n" +
        "4 0 obj\n<< /Length " +
        data.length +
        filter +
        " >>\nstream\n",
      "latin1"
    ),
    data,
    Buffer.from(
      "\nendstream\nendobj\n" +
        "5 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n" +
        "trailer\n<< /Root 1 0 R" +
        (opts.encrypted ? " /Encrypt 6 0 R" : "") +
        " >>\n%%EOF\n",
      "latin1"
    ),
  ]);
}

/**
 * A PDF showing each line as a plain string, the way Word and TeX write text.
 * @param {Array<string>} lines - Lines of text.
 * @param {object} [options] - See makePdf.
 * @returns {Buffer}
 */
function makeTextPdf(lines, options) {
  var ops = lines
    .map(function toOp(line) {
      var escaped = line.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
      return "0 -14 Td (" + escaped + ") Tj";
    })
    .join("\n");
  return makePdf("BT\n/F1 11 Tf\n72 740 Td\n" + ops + "\nET\n", options);
}

// A realistic one-page resume: well over the "very little text" threshold.
var RESUME_LINES = [
  "Jonathan Griffin-Smith",
  "jon.griffin@example.edu | (413) 555-0100 | github.com/jgriffin",
  "EDUCATION",
  "University of Massachusetts Amherst, B.S. Computer Science, expected May 2027",
  "Relevant coursework: Data Structures, Algorithms, Operating Systems, Databases, Machine Learning",
  "EXPERIENCE",
  "Software Engineering Intern, Example Corp (Summer 2025)",
  "Built a REST API in Node.js and MongoDB serving fifty thousand requests per day. Reduced page load time by",
  "forty percent by introducing caching and lazy loading across the web application. Mentored two new interns.",
  "PROJECTS",
  "Hackathon scheduler: a React and Express application that assigns judges to tables using a greedy algorithm.",
  "Weather station: an Arduino and Raspberry Pi sensor network that reports temperature to a web dashboard.",
  "SKILLS",
  "JavaScript, Python, Java, C, SQL, Git, Docker, Linux, React, Express, MongoDB",
];

module.exports = {
  makeZip: makeZip,
  makeDocx: makeDocx,
  makePdf: makePdf,
  makeTextPdf: makeTextPdf,
  RESUME_LINES: RESUME_LINES,
};
