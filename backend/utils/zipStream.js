"use strict";

// A small streaming ZIP writer, for bundles that are too big to hold in
// memory (the sponsor resume export). Each file is deflated as it passes
// through and the sizes and CRC are written after its data (the "data
// descriptor" of the ZIP format), so nothing has to be buffered or known up
// front. Plain ZIP only (no ZIP64): files and the archive must stay under
// 4 GB and 65,535 entries, which is far beyond a hackathon's resumes.

var zlib = require("zlib");
var stream = require("stream");
var csv = require("./csv");

var MAX_UINT32 = 0xffffffff;
var MAX_ENTRIES = 0xffff;

// Flag bit 3: sizes/CRC follow the data. Bit 11: file names are UTF-8.
var FLAGS = 0x0008 | 0x0800;
var METHOD_DEFLATE = 8;
var VERSION = 20;

var crcTable = (function buildCrcTable() {
  var table = new Uint32Array(256);
  for (var n = 0; n < 256; n++) {
    var c = n;
    for (var k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

/**
 * Continue a CRC-32 over more bytes.
 * @param {number} crc - Running value (start with 0xFFFFFFFF).
 * @param {Buffer} buffer - Next bytes.
 * @returns {number} The updated running value (xor with 0xFFFFFFFF at the end).
 */
function updateCrc(crc, buffer) {
  var value = crc;
  for (var i = 0; i < buffer.length; i++) {
    value = crcTable[(value ^ buffer[i]) & 0xff] ^ (value >>> 8);
  }
  return value >>> 0;
}

/**
 * @param {Buffer} buffer - Bytes.
 * @returns {number} CRC-32 of the bytes.
 */
function crc32(buffer) {
  return (updateCrc(0xffffffff, buffer) ^ 0xffffffff) >>> 0;
}

/**
 * @param {Date} date - A moment (written in UTC, so output is reproducible).
 * @returns {{time: number, date: number}} MS-DOS time and date fields.
 */
function dosDateTime(date) {
  var year = Math.max(date.getUTCFullYear(), 1980);
  return {
    time: (date.getUTCHours() << 11) | (date.getUTCMinutes() << 5) | (date.getUTCSeconds() >> 1),
    date: ((year - 1980) << 9) | ((date.getUTCMonth() + 1) << 5) | date.getUTCDate(),
  };
}

/**
 * Create a ZIP archive that is written to `output` as files are added.
 *
 *   var zip = createZipWriter(res);
 *   await zip.addBuffer("index.csv", Buffer.from("..."));
 *   await zip.addStream("a.pdf", readable);
 *   await zip.finish();
 *
 * Files must be added one at a time (await each call). Names are stored as
 * given: callers must make them safe (no leading "/" or "..", no directories
 * they don't intend).
 *
 * @param {object} output - A writable stream (an Express response).
 * @returns {{addBuffer: function, addStream: function, finish: function}}
 */
function createZipWriter(output) {
  var offset = 0;
  var entries = [];

  function write(chunk) {
    offset += chunk.length;
    return csv.writeChunk(output, chunk);
  }

  /**
   * Add a file whose content is read from a stream.
   * @param {string} name - Path inside the archive.
   * @param {object} readable - Readable stream of the file's bytes.
   * @param {Date} [modified] - Modification time (default: now).
   * @returns {Promise<void>}
   */
  async function addStream(name, readable, modified) {
    if (entries.length >= MAX_ENTRIES) {
      throw new Error("Too many files for a ZIP archive.");
    }
    var nameBytes = Buffer.from(name, "utf8");
    var stamp = dosDateTime(modified || new Date());
    var localOffset = offset;

    var header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(VERSION, 4);
    header.writeUInt16LE(FLAGS, 6);
    header.writeUInt16LE(METHOD_DEFLATE, 8);
    header.writeUInt16LE(stamp.time, 10);
    header.writeUInt16LE(stamp.date, 12);
    // CRC and sizes (offsets 14-25) stay zero: they follow the data.
    header.writeUInt16LE(nameBytes.length, 26);
    await write(Buffer.concat([header, nameBytes]));

    var crc = 0xffffffff;
    var size = 0;
    var compressedSize = 0;
    var deflater = zlib.createDeflateRaw();
    readable.on("data", function onData(chunk) {
      crc = updateCrc(crc, chunk);
      size += chunk.length;
    });
    readable.on("error", function onError(err) {
      deflater.destroy(err);
    });
    readable.pipe(deflater);

    try {
      for await (var chunk of deflater) {
        compressedSize += chunk.length;
        await write(chunk);
      }
    } catch (err) {
      // Don't leave a half-read source (a blob download) open.
      readable.destroy();
      throw err;
    }
    crc = (crc ^ 0xffffffff) >>> 0;

    if (size > MAX_UINT32 || compressedSize > MAX_UINT32 || offset > MAX_UINT32) {
      throw new Error("The ZIP archive is too large.");
    }

    var descriptor = Buffer.alloc(16);
    descriptor.writeUInt32LE(0x08074b50, 0);
    descriptor.writeUInt32LE(crc, 4);
    descriptor.writeUInt32LE(compressedSize, 8);
    descriptor.writeUInt32LE(size, 12);
    await write(descriptor);

    entries.push({
      nameBytes: nameBytes,
      stamp: stamp,
      crc: crc,
      compressedSize: compressedSize,
      size: size,
      offset: localOffset,
    });
  }

  /**
   * Add a file whose content is already in memory.
   * @param {string} name - Path inside the archive.
   * @param {Buffer|string} content - The file's bytes.
   * @param {Date} [modified] - Modification time (default: now).
   * @returns {Promise<void>}
   */
  function addBuffer(name, content, modified) {
    return addStream(name, stream.Readable.from([Buffer.from(content)]), modified);
  }

  /**
   * Write the table of contents and end the response.
   * @returns {Promise<void>}
   */
  async function finish() {
    var directoryStart = offset;
    for (var i = 0; i < entries.length; i++) {
      var entry = entries[i];
      var record = Buffer.alloc(46);
      record.writeUInt32LE(0x02014b50, 0);
      record.writeUInt16LE(VERSION, 4);
      record.writeUInt16LE(VERSION, 6);
      record.writeUInt16LE(FLAGS, 8);
      record.writeUInt16LE(METHOD_DEFLATE, 10);
      record.writeUInt16LE(entry.stamp.time, 12);
      record.writeUInt16LE(entry.stamp.date, 14);
      record.writeUInt32LE(entry.crc, 16);
      record.writeUInt32LE(entry.compressedSize, 20);
      record.writeUInt32LE(entry.size, 24);
      record.writeUInt16LE(entry.nameBytes.length, 28);
      record.writeUInt32LE(entry.offset, 42);
      await write(Buffer.concat([record, entry.nameBytes]));
    }
    var directorySize = offset - directoryStart;

    var end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(entries.length, 8);
    end.writeUInt16LE(entries.length, 10);
    end.writeUInt32LE(directorySize, 12);
    end.writeUInt32LE(directoryStart, 16);
    await write(end);
    output.end();
  }

  return { addBuffer: addBuffer, addStream: addStream, finish: finish };
}

module.exports = {
  createZipWriter: createZipWriter,
  crc32: crc32,
};
