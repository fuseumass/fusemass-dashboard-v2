"use strict";

/**
 * Work out what an uploaded image really is from its first bytes ("magic
 * numbers"), instead of believing the file name or the Content-Type the
 * client sent, both of which the uploader controls.
 *
 * Only raster formats are recognised. SVG is deliberately NOT supported: an
 * SVG is XML that can carry <script>, so serving user-uploaded SVG from our
 * origin would be a stored-XSS hole.
 */

// Every format we can recognise, keyed by the extension we store it under.
var TYPES = {
  png: "image/png",
  jpg: "image/jpeg",
  webp: "image/webp",
  ico: "image/x-icon",
};

/**
 * @param {Buffer} buffer - The uploaded file's bytes.
 * @returns {string|null} "png" | "jpg" | "webp" | "ico", or null when the bytes are none of those.
 */
function sniff(buffer) {
  if (!buffer || buffer.length < 12) {
    return null;
  }
  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (buffer.readUInt32BE(0) === 0x89504e47 && buffer.readUInt32BE(4) === 0x0d0a1a0a) {
    return "png";
  }
  // JPEG: FF D8 FF
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return "jpg";
  }
  // WebP: "RIFF" <size> "WEBP"
  if (buffer.toString("latin1", 0, 4) === "RIFF" && buffer.toString("latin1", 8, 12) === "WEBP") {
    return "webp";
  }
  // ICO: 00 00 01 00 then the number of images (at least one).
  if (buffer.readUInt32BE(0) === 0x00000100 && buffer.readUInt16LE(4) > 0) {
    return "ico";
  }
  return null;
}

/**
 * The Content-Type to serve a stored image with. Always derived from the
 * extension we chose at upload time, never from anything the client sent.
 * @param {string} ext - "png" | "jpg" | "webp" | "ico".
 * @returns {string|null} The MIME type, or null for an unknown extension.
 */
function mimeFor(ext) {
  return Object.prototype.hasOwnProperty.call(TYPES, ext) ? TYPES[ext] : null;
}

module.exports = {
  TYPES: TYPES,
  sniff: sniff,
  mimeFor: mimeFor,
};
