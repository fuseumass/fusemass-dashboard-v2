"use strict";

var util = require("util");
var zlib = require("zlib");

/**
 * Best-effort text extraction from an uploaded resume, for the automatic
 * application checks (see utils/applicationFlags). No parsing dependency is
 * used on purpose: resumes are untrusted uploads, and a full PDF engine in
 * the API process is a lot of attack surface for a "does it mention the
 * applicant's name" check.
 *
 * The contract that matters: the result is either the text, or `null` for
 * "couldn't read this" (a format that isn't handled, an encoding that needs a
 * real PDF engine, a damaged or oversized file). Callers must treat null as
 * "don't judge", never as "empty". The PDF reader therefore only trusts the
 * simple case (text stored as plain strings in a stream it can inflate) and
 * gives up on anything else, e.g. fonts that store glyph numbers instead of
 * characters, which Chrome, Google Docs and Skia always produce.
 */

var inflate = util.promisify(zlib.inflate);
var inflateRaw = util.promisify(zlib.inflateRaw);

// Limits so a hostile file (a zip or Flate bomb, thousands of streams) can't
// tie the server up. Resume uploads are already capped at 5 MB.
var MAX_PART_BYTES = 8 * 1024 * 1024;
var MAX_TOTAL_BYTES = 16 * 1024 * 1024;
var MAX_PDF_STREAMS = 4000;
var MAX_ZIP_ENTRIES = 5000;
var MAX_TEXT_CHARS = 200000;
// Text from a font with a scrambled encoding is mostly symbols (real prose
// and resumes are about 1% symbols) or has the wrong share of vowels (real
// English is about 38%). Judged only when there is enough text to tell.
var MIN_PLAUSIBILITY_CHARS = 30;
var MAX_SYMBOL_SHARE = 0.1;
var MIN_VOWEL_SHARE = 0.2;

// pdfTeX's default font encoding stores these ligatures as control codes.
var LIGATURES = { 11: "ff", 12: "fi", 13: "fl", 14: "ffi", 15: "ffl" };

var XML_ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

/**
 * Extract the text of a PDF or Word (.docx) resume. The file type is sniffed
 * from the bytes, not trusted from the upload's declared type.
 *
 * @param {Buffer} buffer - The uploaded file.
 * @returns {Promise<(string|null)>} The text (possibly empty for a scanned
 *   image), or null when it can't be read reliably. Never rejects.
 */
function extractText(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 8) {
    return Promise.resolve(null);
  }
  var work;
  var pdfAt = buffer.indexOf("%PDF-");
  if (pdfAt !== -1 && pdfAt < 1024) {
    work = extractPdfText(buffer);
  } else if (buffer[0] === 0x50 && buffer[1] === 0x4b) {
    work = extractDocxText(buffer);
  } else {
    return Promise.resolve(null);
  }
  return work.then(
    function ok(text) {
      return typeof text === "string" ? text.slice(0, MAX_TEXT_CHARS) : null;
    },
    function failed() {
      return null;
    }
  );
}

// ---- Word (.docx) -----------------------------------------------------------

/**
 * Read the central directory of a zip file.
 * @param {Buffer} buffer - The zip.
 * @returns {Array<object>} `{ name, method, size, offset }` per entry (empty
 *   for anything that isn't a plain, non-zip64 archive).
 */
function zipEntries(buffer) {
  var entries = [];
  var eocd = -1;
  var lowest = Math.max(0, buffer.length - 22 - 65535);
  for (var i = buffer.length - 22; i >= lowest; i--) {
    if (buffer.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd === -1) {
    return entries;
  }
  var total = Math.min(buffer.readUInt16LE(eocd + 10), MAX_ZIP_ENTRIES);
  var pos = buffer.readUInt32LE(eocd + 16);
  for (var n = 0; n < total; n++) {
    if (pos + 46 > buffer.length || buffer.readUInt32LE(pos) !== 0x02014b50) {
      break;
    }
    var nameLength = buffer.readUInt16LE(pos + 28);
    entries.push({
      name: buffer.toString("utf8", pos + 46, pos + 46 + nameLength),
      method: buffer.readUInt16LE(pos + 10),
      size: buffer.readUInt32LE(pos + 20),
      offset: buffer.readUInt32LE(pos + 42),
    });
    pos += 46 + nameLength + buffer.readUInt16LE(pos + 30) + buffer.readUInt16LE(pos + 32);
  }
  return entries;
}

/**
 * Read one zip entry's contents.
 * @param {Buffer} buffer - The zip.
 * @param {object} entry - From zipEntries.
 * @returns {Promise<(Buffer|null)>} The bytes, or null when stored in a way we don't read.
 */
function readZipEntry(buffer, entry) {
  var at = entry.offset;
  if (at + 30 > buffer.length || buffer.readUInt32LE(at) !== 0x04034b50) {
    return Promise.resolve(null);
  }
  var start = at + 30 + buffer.readUInt16LE(at + 26) + buffer.readUInt16LE(at + 28);
  var end = start + entry.size;
  if (end > buffer.length) {
    return Promise.resolve(null);
  }
  var data = buffer.subarray(start, end);
  if (entry.method === 0) {
    return Promise.resolve(data.length <= MAX_PART_BYTES ? data : null);
  }
  if (entry.method === 8) {
    return inflateRaw(data, { maxOutputLength: MAX_PART_BYTES });
  }
  return Promise.resolve(null);
}

/**
 * @param {string} xml - WordprocessingML.
 * @returns {string} Its text, paragraphs on separate lines.
 */
function wordXmlToText(xml) {
  return xml
    .replace(/<\/w:p>/g, "\n")
    .replace(/<w:(?:tab|br|cr)\b[^>]*\/>/g, " ")
    .replace(/<[^>]*>/g, "")
    .replace(/&(?:#x([0-9a-fA-F]{1,6})|#(\d{1,7})|(\w+));/g, function decode(match, hex, dec, named) {
      if (named) {
        return Object.prototype.hasOwnProperty.call(XML_ENTITIES, named) ? XML_ENTITIES[named] : match;
      }
      var code = hex ? parseInt(hex, 16) : parseInt(dec, 10);
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
    });
}

/**
 * Text of a .docx: the body, plus headers and footers (where a resume's
 * name often lives).
 * @param {Buffer} buffer - The .docx.
 * @returns {Promise<(string|null)>}
 */
function extractDocxText(buffer) {
  var parts = zipEntries(buffer).filter(function wanted(entry) {
    return /^word\/(?:document|header\d*|footer\d*)\.xml$/.test(entry.name);
  });
  var hasBody = parts.some(function isBody(entry) {
    return entry.name === "word/document.xml";
  });
  if (!hasBody) {
    return Promise.resolve(null);
  }

  var total = 0;
  return Promise.all(
    parts.map(function read(entry) {
      return readZipEntry(buffer, entry).then(function afterRead(data) {
        if (!data) {
          throw new Error("unreadable zip entry");
        }
        total += data.length;
        if (total > MAX_TOTAL_BYTES) {
          throw new Error("too large");
        }
        return wordXmlToText(data.toString("utf8"));
      });
    })
  ).then(function join(texts) {
    return texts.join("\n");
  });
}

// ---- PDF --------------------------------------------------------------------

/**
 * Find every `stream ... endstream` in a PDF.
 * @param {string} text - The file as a latin1 string.
 * @returns {{streams: Array<object>, damaged: boolean}} Each stream is
 *   `{ dict, start, end }`: the preceding dictionary text and the data's
 *   offsets. `damaged` is set for a stream that never ends or when there are
 *   more streams than we are willing to look at.
 */
function pdfStreams(text) {
  var streams = [];
  var from = 0;
  while (true) {
    var at = text.indexOf("stream", from);
    if (at === -1) {
      break;
    }
    if (streams.length >= MAX_PDF_STREAMS) {
      return { streams: streams, damaged: true };
    }
    from = at + 6;
    if (text.slice(at - 3, at) === "end") {
      continue;
    }
    var start = at + 6;
    if (text.charAt(start) === "\r" && text.charAt(start + 1) === "\n") {
      start += 2;
    } else if (text.charAt(start) === "\n") {
      start += 1;
    } else {
      continue;
    }
    var end = text.indexOf("endstream", start);
    if (end === -1) {
      return { streams: streams, damaged: true };
    }
    var dictFrom = Math.max(text.lastIndexOf("obj", at), at - 4000, 0);
    streams.push({ dict: text.slice(dictFrom, at), start: start, end: end });
    from = end + 9;
  }
  return { streams: streams, damaged: false };
}

/**
 * Streams that never hold page text, so aren't worth decoding.
 * @param {string} dict - The stream's dictionary text.
 * @returns {boolean}
 */
function isNonTextStream(dict) {
  return (
    /\/Subtype\s*\/Image\b/.test(dict) ||
    /\/Type\s*\/(?:ObjStm|XRef|Metadata|EmbeddedFile)\b/.test(dict) ||
    /\/Length[123]\b/.test(dict) ||
    /\/Subtype\s*\/(?:Type1C|CIDFontType0C|OpenType)\b/.test(dict)
  );
}

/**
 * How a stream is encoded.
 * @param {string} dict - The stream's dictionary text.
 * @returns {string} "none", "flate" or "other".
 */
function streamEncoding(dict) {
  var match = /\/Filter\s*(\[[^\]]*\]|\/\w+)/.exec(dict);
  if (!match) {
    return "none";
  }
  var names = match[1].match(/\/\w+/g) || [];
  return names.length === 1 && (names[0] === "/FlateDecode" || names[0] === "/Fl") ? "flate" : "other";
}

/**
 * Read a PDF literal string `( ... )` starting at `at`.
 * @param {string} s - Content stream.
 * @param {number} at - Index of the opening parenthesis.
 * @returns {{bytes: Array<number>, next: number}}
 */
function readLiteralString(s, at) {
  var bytes = [];
  var depth = 1;
  var i = at + 1;
  while (i < s.length && depth > 0) {
    var code = s.charCodeAt(i);
    if (code === 0x5c) {
      var next = s.charAt(i + 1);
      i += 2;
      if (next >= "0" && next <= "7") {
        var octal = next;
        while (octal.length < 3 && s.charAt(i) >= "0" && s.charAt(i) <= "7") {
          octal += s.charAt(i);
          i += 1;
        }
        bytes.push(parseInt(octal, 8) & 255);
      } else if (next === "n") {
        bytes.push(10);
      } else if (next === "r") {
        bytes.push(13);
      } else if (next === "t") {
        bytes.push(9);
      } else if (next === "b" || next === "f") {
        bytes.push(32);
      } else if (next === "\r") {
        if (s.charAt(i) === "\n") {
          i += 1;
        }
      } else if (next !== "\n" && next !== "") {
        bytes.push(next.charCodeAt(0));
      }
    } else if (code === 0x28) {
      depth += 1;
      bytes.push(code);
      i += 1;
    } else if (code === 0x29) {
      depth -= 1;
      if (depth > 0) {
        bytes.push(code);
      }
      i += 1;
    } else {
      bytes.push(code);
      i += 1;
    }
  }
  return { bytes: bytes, next: i };
}

/**
 * Turn the bytes of a shown string into text, or flag that they aren't
 * characters we can trust (control codes: a font whose codes are glyph numbers).
 * @param {Array<number>} bytes - String bytes.
 * @param {object} state - Parser state; `unreadable` is set when needed.
 * @returns {string}
 */
function decodeShownBytes(bytes, state) {
  var out = "";
  for (var i = 0; i < bytes.length; i++) {
    var b = bytes[i];
    if (b >= 0x20 && b <= 0x7e) {
      out += String.fromCharCode(b);
    } else if (LIGATURES[b]) {
      out += LIGATURES[b];
    } else if (b >= 0xa0) {
      out += String.fromCharCode(b);
    } else if (b === 9 || b === 10 || b === 13 || (b >= 0x80 && b < 0xa0)) {
      out += " ";
    } else {
      state.unreadable = true;
    }
  }
  return out;
}

/**
 * Collect the text a content stream shows (Tj, TJ, ' and " operators).
 * @param {string} s - A decoded content stream, as latin1.
 * @param {object} state - `{ pieces: Array<string>, unreadable: boolean }`.
 * @returns {void}
 */
function scanContentStream(s, state) {
  var i = 0;
  var stack = [];
  var delimiters = " \t\r\n\f\0()<>[]{}/%";

  while (i < s.length) {
    var ch = s.charAt(i);
    if (ch === " " || ch === "\n" || ch === "\r" || ch === "\t" || ch === "\f" || ch === "\0") {
      i += 1;
    } else if (ch === "(") {
      var literal = readLiteralString(s, i);
      stack.push({ bytes: literal.bytes });
      i = literal.next;
    } else if (ch === "<") {
      if (s.charAt(i + 1) === "<") {
        i += 2;
        stack = [];
      } else {
        var close = s.indexOf(">", i);
        i = close === -1 ? s.length : close + 1;
        // Hex strings are how fonts that store glyph numbers write text.
        stack.push({ hex: true });
      }
    } else if (ch === "%") {
      var eol = s.indexOf("\n", i);
      i = eol === -1 ? s.length : eol + 1;
    } else if (ch === "[") {
      stack.push({ mark: true });
      i += 1;
    } else if (ch === "]" || ch === ">" || ch === "{" || ch === "}" || ch === ")") {
      i += 1;
    } else if (ch === "/") {
      i += 1;
      while (i < s.length && delimiters.indexOf(s.charAt(i)) === -1) {
        i += 1;
      }
      stack.push({ name: true });
    } else {
      var from = i;
      while (i < s.length && delimiters.indexOf(s.charAt(i)) === -1) {
        i += 1;
      }
      var token = s.slice(from, i);
      if (token === "") {
        i += 1;
      } else if (/^[+-]?\d*\.?\d+$/.test(token)) {
        stack.push({ number: Number(token) });
      } else if (token === "ID") {
        // Inline image: raw bytes up to "EI" that must not be read as content.
        var imageEnd = s.slice(i).search(/\sEI(?:\s|$)/);
        i = imageEnd === -1 ? s.length : i + imageEnd + 3;
        stack = [];
      } else {
        applyOperator(token, stack, state);
        stack = [];
      }
    }
  }
}

/**
 * Handle one content-stream operator.
 * @param {string} operator - e.g. "Tj", "TJ", "Td".
 * @param {Array<object>} stack - The operands before it.
 * @param {object} state - See scanContentStream.
 * @returns {void}
 */
function applyOperator(operator, stack, state) {
  if (operator === "Tj" || operator === "'" || operator === '"') {
    showItems(stack.slice(-1), state);
    state.pieces.push(operator === "Tj" ? "" : "\n");
  } else if (operator === "TJ") {
    var markAt = -1;
    for (var i = stack.length - 1; i >= 0; i--) {
      if (stack[i].mark) {
        markAt = i;
        break;
      }
    }
    showItems(stack.slice(markAt + 1), state);
  } else if (operator === "Td" || operator === "TD" || operator === "T*" || operator === "Tm" || operator === "ET") {
    state.pieces.push("\n");
  }
}

/**
 * Append the strings among `items`, turning big negative adjustments (TJ
 * kerning that means a word space) into spaces.
 * @param {Array<object>} items - Stack entries.
 * @param {object} state - See scanContentStream.
 * @returns {void}
 */
function showItems(items, state) {
  items.forEach(function show(item) {
    if (item.hex) {
      state.unreadable = true;
    } else if (item.bytes) {
      state.pieces.push(decodeShownBytes(item.bytes, state));
    } else if (typeof item.number === "number" && item.number < -180) {
      state.pieces.push(" ");
    }
  });
}

/**
 * Text of a PDF whose text is stored as plain strings; null otherwise.
 * @param {Buffer} buffer - The PDF.
 * @returns {Promise<(string|null)>}
 */
function extractPdfText(buffer) {
  var text = buffer.toString("latin1");
  var found = pdfStreams(text);
  var state = { pieces: [], unreadable: found.damaged };
  var total = 0;

  var chain = Promise.resolve();
  found.streams.forEach(function each(stream) {
    if (isNonTextStream(stream.dict)) {
      return;
    }
    chain = chain.then(function decode() {
      if (state.unreadable) {
        return undefined;
      }
      var encoding = streamEncoding(stream.dict);
      var data = buffer.subarray(stream.start, stream.end);
      if (encoding === "other") {
        state.unreadable = true;
        return undefined;
      }
      var decoded = encoding === "flate" ? inflate(data, { maxOutputLength: MAX_PART_BYTES }) : Promise.resolve(data);
      return decoded.then(function afterDecode(bytes) {
        total += bytes.length;
        if (total > MAX_TOTAL_BYTES) {
          state.unreadable = true;
          return;
        }
        var content = bytes.toString("latin1");
        if (/\bBT\b/.test(content)) {
          scanContentStream(content, state);
        }
      });
    });
  });

  return chain
    .catch(function onError() {
      // Encrypted, damaged or oversized: not safe to judge.
      state.unreadable = true;
    })
    .then(function afterAll() {
      if (state.unreadable || /\/Encrypt\b/.test(text)) {
        return null;
      }
      var result = state.pieces.join("").replace(/[ \t]+/g, " ").replace(/ ?\n ?/g, "\n").trim();
      return looksLikeWords(result) ? result : null;
    });
}

/**
 * Whether extracted text is plausibly real words rather than characters from
 * a font with a scrambled encoding (which comes out as runs of symbols, or as
 * words with the wrong vowels). Short text can't be told apart, so it is
 * accepted (and will simply count as "very little text").
 * @param {string} text - Extracted text.
 * @returns {boolean}
 */
function looksLikeWords(text) {
  var alphanumeric = text.replace(/[^A-Za-z0-9]/g, "").length;
  var symbols = (text.match(/[!"#$%&*+/<=>?@\\^_`{|}~]/g) || []).length;
  if (alphanumeric >= MIN_PLAUSIBILITY_CHARS && symbols / alphanumeric > MAX_SYMBOL_SHARE) {
    return false;
  }
  var letters = text.replace(/[^A-Za-z]/g, "");
  if (letters.length < MIN_PLAUSIBILITY_CHARS) {
    return true;
  }
  var vowels = letters.replace(/[^aeiouAEIOU]/g, "").length;
  return vowels / letters.length >= MIN_VOWEL_SHARE;
}

module.exports = {
  extractText: extractText,
  extractPdfText: extractPdfText,
  extractDocxText: extractDocxText,
};
