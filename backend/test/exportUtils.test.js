"use strict";

require("./helpers/testEnv");

var test = require("node:test");
var assert = require("node:assert/strict");
var crypto = require("crypto");
var stream = require("stream");

var csv = require("../utils/csv");
var zipStream = require("../utils/zipStream");
var statsUtil = require("../utils/stats");
var zipReader = require("./helpers/zipReader");

/**
 * A writable that collects everything and is deliberately slow and tiny, so
 * writes report backpressure and the code under test must wait for "drain".
 * @returns {{sink: object, bytes: function(): Buffer}}
 */
function slowSink() {
  var chunks = [];
  var sink = new stream.Writable({
    highWaterMark: 1024,
    write: function write(chunk, _encoding, callback) {
      chunks.push(chunk);
      setImmediate(callback);
    },
  });
  return {
    sink: sink,
    // Resolves with everything written, once the sink has been ended and drained.
    finished: function finished() {
      return new Promise(function wait(resolve) {
        if (sink.writableFinished) resolve();
        else sink.on("finish", resolve);
      }).then(function collect() {
        return Buffer.concat(chunks);
      });
    },
    bytes: function bytes() {
      return Buffer.concat(chunks);
    },
  };
}

test("csv cells: quoting, types and formula injection", async function (t) {
  await t.test("plain values stay plain; commas, quotes and line breaks are quoted", function () {
    assert.equal(csv.formatCell("Ada"), "Ada");
    assert.equal(csv.formatCell("a,b"), '"a,b"');
    assert.equal(csv.formatCell('say "hi"'), '"say ""hi"""');
    assert.equal(csv.formatCell("line1\nline2"), '"line1\nline2"');
    assert.equal(csv.formatCell("line1\r\nline2"), '"line1\r\nline2"');
  });

  await t.test("null, undefined, dates, booleans, numbers and lists", function () {
    assert.equal(csv.formatCell(null), "");
    assert.equal(csv.formatCell(undefined), "");
    assert.equal(csv.formatCell(new Date("2026-10-24T14:00:00Z")), "2026-10-24T14:00:00.000Z");
    assert.equal(csv.formatCell(new Date("nope")), "");
    assert.equal(csv.formatCell(true), "true");
    assert.equal(csv.formatCell(0), "0");
    assert.equal(csv.formatCell(Infinity), "");
    assert.equal(csv.formatCell(["Python", "C, C++", null]), '"Python; C, C++; "');
  });

  await t.test("text that a spreadsheet would run as a formula gets a leading apostrophe", function () {
    assert.equal(csv.formatCell("=1+1"), "'=1+1");
    assert.equal(csv.formatCell("+15551234567"), "'+15551234567");
    assert.equal(csv.formatCell("-2+3"), "'-2+3");
    assert.equal(csv.formatCell("@SUM(A1)"), "'@SUM(A1)");
    assert.equal(csv.formatCell("\t=1+1"), "'\t=1+1");
    assert.equal(csv.formatCell("\r=1+1"), "\"'\r=1+1\"");
    assert.equal(csv.formatCell('=HYPERLINK("http://evil.example","Click")'), "\"'=HYPERLINK(\"\"http://evil.example\"\",\"\"Click\"\")\"");
    // Only the start matters: these are plain text already.
    assert.equal(csv.formatCell("a=b"), "a=b");
    assert.equal(csv.formatCell("Ada-Lovelace"), "Ada-Lovelace");
    assert.equal(csv.formatCell(" =1+1"), " =1+1");
  });

  await t.test("a real negative number is not text, so it is left alone", function () {
    assert.equal(csv.formatCell(-5), "-5");
  });

  await t.test("formula text inside a list is neutralised too", function () {
    assert.equal(csv.formatCell(["=cmd", "ok"]), "'=cmd; ok");
  });

  await t.test("rows end in CRLF", function () {
    assert.equal(csv.formatRow(["a", "b,c", 1]), 'a,"b,c",1\r\n');
  });
});

test("csv.sendCsv streams batches with backpressure", async function () {
  var batches = [[["h1", 1]], [["x".repeat(5000), 2]], [["=bad", 3]], []];
  var calls = 0;
  var out = slowSink();
  out.sink.status = function status() {
    return out.sink;
  };
  out.sink.set = function set(headers) {
    out.sink.headersSet = headers;
    return out.sink;
  };

  await csv.sendCsv(out.sink, {
    filename: "x.csv",
    header: ["A", "B"],
    nextRows: function nextRows() {
      return Promise.resolve(batches[calls++]);
    },
  });
  var text = (await out.finished()).toString("utf8");
  assert.ok(text.startsWith("﻿A,B\r\n"), "BOM then header");
  assert.ok(text.includes("h1,1\r\n"));
  assert.ok(text.includes("x".repeat(5000) + ",2\r\n"));
  assert.ok(text.endsWith("'=bad,3\r\n"));
  assert.equal(out.sink.headersSet["Content-Type"], "text/csv; charset=utf-8");
  assert.match(out.sink.headersSet["Content-Disposition"], /^attachment; filename="x\.csv"$/);
  assert.equal(out.sink.headersSet["Cache-Control"], "no-store");
});

test("zip writer: round trip, incompressible data, unicode names, backpressure", async function (t) {
  await t.test("crc32 matches the standard check value", function () {
    assert.equal(zipStream.crc32(Buffer.from("123456789")), 0xcbf43926);
  });

  await t.test("every entry reads back exactly", async function () {
    var big = crypto.randomBytes(3 * 1024 * 1024); // random bytes do not compress
    var text = Buffer.from("Name,School\r\nAda,MIT\r\n".repeat(2000));
    var out = slowSink();

    var zip = zipStream.createZipWriter(out.sink);
    await zip.addStream("resumes/big.bin", stream.Readable.from([big.subarray(0, 1000000), big.subarray(1000000)]));
    await zip.addBuffer("resumes/Zoë-Çelik_abc123.pdf", Buffer.from("%PDF-1.4 unicode name"));
    await zip.addBuffer("empty.txt", Buffer.alloc(0));
    await zip.addBuffer("index.csv", text);
    await zip.finish();

    var files = zipReader.readZip(await out.finished());
    assert.deepEqual(Object.keys(files).sort(), ["empty.txt", "index.csv", "resumes/Zoë-Çelik_abc123.pdf", "resumes/big.bin"]);
    assert.ok(files["resumes/big.bin"].equals(big));
    assert.ok(files["index.csv"].equals(text));
    assert.equal(files["empty.txt"].length, 0);
    assert.equal(files["resumes/Zoë-Çelik_abc123.pdf"].toString(), "%PDF-1.4 unicode name");
  });

  await t.test("a source that fails mid-file fails the write and is closed", async function () {
    var out = slowSink();
    var source = new stream.Readable({ read: function read() {} });
    source.push(Buffer.from("partial"));
    setImmediate(function fail() {
      source.destroy(new Error("blob went away"));
    });

    var zip = zipStream.createZipWriter(out.sink);
    await assert.rejects(zip.addStream("a.pdf", source), /blob went away/);
    assert.ok(source.destroyed);
  });

  await t.test("an archive with no files is still a valid ZIP", async function () {
    var out = slowSink();
    var zip = zipStream.createZipWriter(out.sink);
    await zip.finish();
    assert.deepEqual(zipReader.readZip(await out.finished()), {});
  });
});

test("stats helpers", async function (t) {
  await t.test("bucketize ranks, merges blanks and folds the tail into other", function () {
    var result = statsUtil.bucketize(
      [
        { label: "MIT", count: 3 },
        { label: "UMass Amherst", count: 10 },
        { label: "  ", count: 2 },
        { label: null, count: 1 },
        { label: "Smith", count: 1 },
        { label: "Brown", count: 1 },
      ],
      2
    );
    assert.equal(result.total, 18);
    assert.equal(result.distinct, 5);
    assert.deepEqual(result.buckets, [
      { label: "UMass Amherst", count: 10 },
      { label: "MIT", count: 3 },
    ]);
    assert.deepEqual(result.other, { distinct: 3, count: 5 });
    assert.equal(statsUtil.bucketize([{ label: "", count: 2 }], 5).buckets[0].label, statsUtil.NOT_PROVIDED);
    assert.deepEqual(statsUtil.bucketize([], 5), { total: 0, distinct: 0, buckets: [], other: { distinct: 0, count: 0 } });
  });

  await t.test("isGraduationField recognises the usual wordings, not unrelated questions", function () {
    assert.ok(statsUtil.isGraduationField({ key: "x", label: "Graduation Year" }));
    assert.ok(statsUtil.isGraduationField({ key: "gradYear", label: "When?" }));
    assert.ok(statsUtil.isGraduationField({ key: "grad_year", label: "" }));
    assert.ok(statsUtil.isGraduationField({ key: "c", label: "Class of" }));
    assert.ok(statsUtil.isGraduationField({ key: "c", label: "Expected graduation date" }));
    assert.ok(!statsUtil.isGraduationField({ key: "student", label: "Are you a graduate student?" }));
    assert.ok(!statsUtil.isGraduationField({ key: "shirt", label: "Shirt size" }));
    assert.ok(!statsUtil.isGraduationField(null));
  });

  await t.test("answerLabel", function () {
    assert.equal(statsUtil.answerLabel(true), "Yes");
    assert.equal(statsUtil.answerLabel(false), "No");
    assert.equal(statsUtil.answerLabel(2027), "2027");
    assert.equal(statsUtil.answerLabel("  2027 "), "2027");
    assert.equal(statsUtil.answerLabel(""), null);
    assert.equal(statsUtil.answerLabel(null), null);
    assert.equal(statsUtil.answerLabel({ a: 1 }), null);
  });

  await t.test("fillDays pads the gaps with zero rows and leaves odd spans alone", function () {
    function empty(date) {
      return { date: date, total: 0 };
    }
    var filled = statsUtil.fillDays([{ date: "2026-10-03", total: 2 }, { date: "2026-09-30", total: 1 }], empty);
    assert.deepEqual(
      filled.map(function dates(d) {
        return d.date + ":" + d.total;
      }),
      ["2026-09-30:1", "2026-10-01:0", "2026-10-02:0", "2026-10-03:2"]
    );
    assert.equal(statsUtil.fillDays([{ date: "2026-10-03", total: 2 }], empty).length, 1);
    assert.equal(statsUtil.fillDays([], empty).length, 0);
    assert.equal(statsUtil.fillDays([{ date: "2020-01-01", total: 1 }, { date: "2026-10-03", total: 1 }], empty).length, 2);
  });
});
