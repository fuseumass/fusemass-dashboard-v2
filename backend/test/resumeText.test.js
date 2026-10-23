"use strict";

var test = require("node:test");
var assert = require("node:assert/strict");
var crypto = require("crypto");

var resumeText = require("../utils/resumeText");
var files = require("./helpers/resumeFiles");

test("B42: reading text out of resume files", async function resumeTextExtraction(t) {
  await t.test("reads a Word document, including its header", async function () {
    var docx = files.makeDocx(["Education", "Built a thing & shipped <it>."], { header: "Jonathan Griffin-Smith" });
    var text = await resumeText.extractText(docx);
    assert.match(text, /Jonathan Griffin-Smith/);
    assert.match(text, /Education\nBuilt a thing & shipped <it>\./);
  });

  await t.test("reads stored (uncompressed) zip entries and numeric character references", async function () {
    var docx = files.makeZip(
      { "word/document.xml": "<w:body><w:p><w:r><w:t>Caf&#233; &#x41;da</w:t></w:r></w:p></w:body>" },
      { store: true }
    );
    assert.equal((await resumeText.extractText(docx)).trim(), "Café Ada");
  });

  await t.test("a zip without a Word body is not a resume it can read", async function () {
    assert.equal(await resumeText.extractText(files.makeZip({ "xl/workbook.xml": "<x/>" })), null);
  });

  await t.test("reads a PDF whose text is plain strings, compressed or not", async function () {
    for (var compress of [true, false]) {
      var text = await resumeText.extractText(files.makeTextPdf(files.RESUME_LINES, { compress: compress }));
      assert.match(text, /Jonathan Griffin-Smith/);
      assert.match(text, /University of Massachusetts Amherst/);
      assert.match(text, /\(413\) 555-0100/, "escaped parentheses in the source come out as text");
    }
  });

  await t.test("joins the pieces of a kerned TJ array and spaces words by large gaps", async function () {
    var pdf = files.makePdf("BT /F1 12 Tf [(Jon)-20(athan)-300(Griffin)] TJ ET");
    assert.equal(await resumeText.extractText(pdf), "Jonathan Griffin");
  });

  await t.test("reads TeX ligature codes and octal escapes", async function () {
    var pdf = files.makePdf("BT /F1 12 Tf (Gri\\016n \\143ode) Tj ET");
    assert.equal(await resumeText.extractText(pdf), "Griffin code");
  });

  await t.test("a scanned PDF with no text is empty, not unreadable", async function () {
    var pdf = files.makePdf("q 612 0 0 792 0 0 cm /Im1 Do Q");
    assert.equal(await resumeText.extractText(pdf), "");
  });

  await t.test("glyph-number text (Identity-H hex strings) is unreadable, never 'empty'", async function () {
    var pdf = files.makePdf("BT /F1 12 Tf [<0024004A>-5<00440051>] TJ ET");
    assert.equal(await resumeText.extractText(pdf), null);
  });

  await t.test("two-byte literal strings and control codes are unreadable", async function () {
    assert.equal(await resumeText.extractText(files.makePdf("BT (\\000J\\000o\\000n) Tj ET")), null);
    assert.equal(await resumeText.extractText(files.makePdf("BT (\\001\\002\\003) Tj ET")), null);
  });

  await t.test("scrambled-encoding text (mostly symbols) is unreadable", async function () {
    var scrambled = "ab#$%".repeat(20);
    assert.equal(await resumeText.extractText(files.makePdf("BT (" + scrambled + ") Tj ET")), null);
    // The same amount of ordinary prose is fine.
    var prose = "Built a web application with a team of three people".repeat(2);
    assert.match(await resumeText.extractText(files.makePdf("BT (" + prose + ") Tj ET")), /web application/);
  });

  await t.test("a stream in a filter it can't decode makes the file unreadable", async function () {
    var pdf = files.makePdf("BT (Hello) Tj ET", { filter: "/ASCII85Decode /FlateDecode" });
    assert.equal(await resumeText.extractText(pdf), null);
  });

  await t.test("encrypted, damaged and unrelated files are unreadable", async function () {
    assert.equal(await resumeText.extractText(files.makeTextPdf(files.RESUME_LINES, { encrypted: true })), null);
    var pdf = files.makeTextPdf(files.RESUME_LINES);
    assert.equal(await resumeText.extractText(pdf.subarray(0, pdf.indexOf("endstream"))), null, "cut off mid-stream");
    var docx = files.makeDocx(["Hello there"]);
    assert.equal(await resumeText.extractText(docx.subarray(0, 40)), null, "truncated zip");
    assert.equal(await resumeText.extractText(Buffer.from("just some plain text, not a resume file")), null);
    assert.equal(await resumeText.extractText(Buffer.alloc(0)), null);
    assert.equal(await resumeText.extractText(null), null);
  });

  await t.test("a decompression bomb is refused rather than inflated", async function () {
    var big = Buffer.alloc(40 * 1024 * 1024, 0x41);
    var bomb = files.makeZip({ "word/document.xml": big });
    assert.ok(bomb.length < 1024 * 1024, "the bomb itself is small");
    assert.equal(await resumeText.extractText(bomb), null);

    var pdfBomb = files.makePdf("BT (" + "A".repeat(40 * 1024 * 1024) + ") Tj ET");
    assert.ok(pdfBomb.length < 1024 * 1024);
    assert.equal(await resumeText.extractText(pdfBomb), null);
  });

  await t.test("an inline image's bytes aren't read as text", async function () {
    var pdf = files.makePdf("BT (Hello) Tj ET\nBI /W 1 /H 1 ID (not text) Tj EI\nBT (World) Tj ET");
    var text = await resumeText.extractText(pdf);
    assert.match(text, /Hello/);
    assert.match(text, /World/);
    assert.doesNotMatch(text, /not text/);
  });

  await t.test("it never rejects, whatever it is handed", async function () {
    var junk = [
      Buffer.from("%PDF-1.4\nstream\n\u0000\u0001\u0002endstream"),
      Buffer.from("%PDF-1.4\n1 0 obj << /Filter /FlateDecode >> stream\nnot deflate data\nendstream"),
      Buffer.concat([Buffer.from("PK\u0003\u0004"), crypto.randomBytes(200)]),
      Buffer.from("%PDF-1.4 (((((((((( BT stream\n"),
    ];
    for (var buffer of junk) {
      var result = await resumeText.extractText(buffer);
      assert.ok(result === null || typeof result === "string");
    }
  });
});
