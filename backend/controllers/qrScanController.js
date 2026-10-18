
"use strict";

var nodemailer = require("nodemailer");
var QRCode = require("qrcode");
var EmailTemplate = require("../schemas/EmailTemplate");

var transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: Number(process.env.SMTP_PORT || 587),
  secure: process.env.SMTP_SECURE === "true",
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
});

function escapeHtml(value) {
  return String(value == null ? "" : value).replace(
    /[&<>"']/g,
    function (character) {
      return {
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      }[character];
    }
  );
}

function replaceVariables(text, variables) {
  return text.replace(
    /{{\s*(name|orgName|status)\s*}}/g,
    function (match, key) {
      return String(
        variables[key] == null ? "" : variables[key]
      );
    }
  );
}

function renderEmailBody(body, variables, hasQRCode) {
  var marker = "__QR_CODE_PLACEHOLDER__";

  // Preserve the QR placeholder until HTML rendering is complete.
  var html = body.replace(
    /{{\s*qrcode\s*}}/g,
    marker
  );

  html = escapeHtml(html);

  html = html.replace(
    /{{\s*(name|orgName|status)\s*}}/g,
    function (match, key) {
      return escapeHtml(variables[key]);
    }
  );

  html = html.replace(/\r\n|\r|\n/g, "<br>");

  if (hasQRCode) {
    html = html.split(marker).join(
      '<img src="cid:applicant-qrcode" ' +
      'alt="Hackathon check-in QR code" ' +
      'width="240" style="max-width:100%;height:auto;" />'
    );
  } else {
    html = html.split(marker).join("");
  }

  return (
    '<div style="font-family:Arial,sans-serif;line-height:1.6;">' +
    html +
    "</div>"
  );
}

// POST /api/email/send
async function sendTemplateEmail(req, res) {
  try {
    var templateKey = req.body.templateKey;
    var to = req.body.to;
    var name = req.body.name || "";
    var orgName = req.body.orgName || "";
    var status = req.body.status || "";
    var qrId = req.body.qrId;

    if (!templateKey || !to) {
      return res.status(400).json({
        success: false,
        message: "Template key and recipient email are required.",
      });
    }

    var template = await EmailTemplate.findOne({
      key: templateKey,
    }).lean();

    if (!template) {
      return res.status(404).json({
        success: false,
        message: "Email template not found.",
      });
    }

    var body = template.body || "";
    var hasQRCode = /{{\s*qrcode\s*}}/.test(body);
    var attachments = [];

    if (hasQRCode) {
      if (
        typeof qrId !== "string" ||
        !/^[a-f0-9]{64}$/i.test(qrId)
      ) {
        return res.status(400).json({
          success: false,
          message: "A valid SHA-256 applicant ID is required.",
        });
      }

      var dataUrl = await QRCode.toDataURL(qrId, {
        errorCorrectionLevel: "M",
        type: "image/png",
        width: 320,
        margin: 2,
      });

      var base64 = dataUrl.replace(
        /^data:image\/png;base64,/,
        ""
      );

      attachments.push({
        filename: "hackathon-qr.png",
        content: Buffer.from(base64, "base64"),
        contentType: "image/png",
        contentDisposition: "inline",
        cid: "applicant-qrcode",
      });
    }

    var variables = { name: name, orgName: orgName, status: status };

    var subject = replaceVariables(
      template.subject || "",
      variables
    );

    var html = renderEmailBody(
      body,
      variables,
      hasQRCode
    );

    await transporter.sendMail({
      from: process.env.EMAIL_FROM,
      to: to,
      subject: subject,
      html: html,
      attachments: attachments,
    });

    return res.status(200).json({
      success: true,
      message: "Email sent successfully.",
    });
  } catch (error) {
    console.error("Error sending template email:", error);

    return res.status(500).json({
      success: false,
      message: "Unable to send email.",
    });
  }
}

module.exports = {
  sendTemplateEmail: sendTemplateEmail,
};
