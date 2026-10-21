"use strict";

var assert = require("node:assert/strict");
var zlib = require("zlib");

/**
 * A small, strict ZIP reader for tests: walks the central directory, then
 * checks every entry against its local header and data descriptor, inflates it
 * and verifies its CRC-32 and size. Throws (via assert) on anything malformed,
 * so a passing read means a real unzip tool would accept the archive too.
 *
 * @param {Buffer} buffer - The whole archive.
 * @returns {object} Map of entry name to its file content (Buffer).
 */
function readZip(buffer) {
  var end = buffer.length - 22; // the writer never adds an archive comment
  assert.equal(buffer.readUInt32LE(end), 0x06054b50, "end-of-central-directory record");
  var count = buffer.readUInt16LE(end + 10);
  assert.equal(buffer.readUInt16LE(end + 8), count);
  var directorySize = buffer.readUInt32LE(end + 12);
  var directoryStart = buffer.readUInt32LE(end + 16);

  var files = {};
  var position = directoryStart;
  for (var i = 0; i < count; i++) {
    assert.equal(buffer.readUInt32LE(position), 0x02014b50, "central directory header");
    var flags = buffer.readUInt16LE(position + 8);
    assert.equal(flags & 0x0800, 0x0800, "names flagged as UTF-8");
    assert.equal(buffer.readUInt16LE(position + 10), 8, "deflate method");
    var crc = buffer.readUInt32LE(position + 16);
    var compressedSize = buffer.readUInt32LE(position + 20);
    var size = buffer.readUInt32LE(position + 24);
    var nameLength = buffer.readUInt16LE(position + 28);
    var extraLength = buffer.readUInt16LE(position + 30);
    var commentLength = buffer.readUInt16LE(position + 32);
    var localOffset = buffer.readUInt32LE(position + 42);
    var name = buffer.toString("utf8", position + 46, position + 46 + nameLength);

    assert.equal(buffer.readUInt32LE(localOffset), 0x04034b50, "local file header for " + name);
    var localNameLength = buffer.readUInt16LE(localOffset + 26);
    var localExtraLength = buffer.readUInt16LE(localOffset + 28);
    assert.equal(buffer.toString("utf8", localOffset + 30, localOffset + 30 + localNameLength), name);
    var dataStart = localOffset + 30 + localNameLength + localExtraLength;

    var descriptor = dataStart + compressedSize;
    assert.equal(buffer.readUInt32LE(descriptor), 0x08074b50, "data descriptor for " + name);
    assert.equal(buffer.readUInt32LE(descriptor + 4), crc);
    assert.equal(buffer.readUInt32LE(descriptor + 8), compressedSize);
    assert.equal(buffer.readUInt32LE(descriptor + 12), size);

    var content = zlib.inflateRawSync(buffer.subarray(dataStart, descriptor));
    assert.equal(content.length, size, "size of " + name);
    if (typeof zlib.crc32 === "function") {
      assert.equal(zlib.crc32(content), crc, "crc of " + name);
    }
    assert.ok(!(name in files), "duplicate entry " + name);
    files[name] = content;
    position += 46 + nameLength + extraLength + commentLength;
  }
  assert.equal(position, directoryStart + directorySize, "central directory size");
  return files;
}

/**
 * supertest parser that keeps a binary response as a Buffer (res.body).
 * @param {object} res - Node response.
 * @param {function} callback - superagent parse callback.
 * @returns {void}
 */
function binaryParser(res, callback) {
  var chunks = [];
  res.on("data", function onData(chunk) {
    chunks.push(chunk);
  });
  res.on("end", function onEnd() {
    callback(null, Buffer.concat(chunks));
  });
}

module.exports = { readZip: readZip, binaryParser: binaryParser };
