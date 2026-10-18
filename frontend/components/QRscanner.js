
"use client";

const React = require("react");
const { useEffect, useRef, useState } = React;
const { Html5Qrcode } = require("html5-qrcode");

function QRScanner({ onScan }) {
  const scannerRef = useRef(null);
  const processingRef = useRef(false);

  const [running, setRunning] = useState(false);
  const [error, setError] = useState("");

  async function stopScanner() {
    const scanner = scannerRef.current;

    if (!scanner) {
      setRunning(false);
      return;
    }

    try {
      if (scanner.isScanning) {
        await scanner.stop();
      }

      await scanner.clear();
    } catch (err) {
      console.error("Error stopping QR scanner:", err);
    } finally {
      scannerRef.current = null;
      setRunning(false);
    }
  }

  async function startScanner() {
    if (scannerRef.current) return;

    setError("");
    processingRef.current = false;

    const scanner = new Html5Qrcode("qr-reader");
    scannerRef.current = scanner;

    try {
      await scanner.start(
        { facingMode: "environment" },
        {
          fps: 10,
          qrbox: { width: 250, height: 250 },
        },
        async (decodedText) => {
          if (processingRef.current) return;

          processingRef.current = true;

          await stopScanner();

          if (typeof onScan === "function") {
            try {
              await onScan(decodedText);
            } catch (err) {
              setError(
                err.message || "Unable to process the scanned QR code."
              );
            }
          }
        },
        () => {
          // Ignore individual frames that do not contain a QR code.
        }
      );

      setRunning(true);
    } catch (err) {
      console.error("Unable to start QR scanner:", err);

      try {
        if (scanner.isScanning) {
          await scanner.stop();
        }

        await scanner.clear();
      } catch (_) {
        // Ignore cleanup errors.
      }

      scannerRef.current = null;
      setRunning(false);
      setError(
        "Unable to open the camera. Check camera permissions and use HTTPS."
      );
    }
  }

  useEffect(() => {
    return () => {
      const scanner = scannerRef.current;

      if (scanner) {
        scannerRef.current = null;

        if (scanner.isScanning) {
          scanner
            .stop()
            .catch(() => {})
            .finally(() => scanner.clear().catch(() => {}));
        } else {
          scanner.clear().catch(() => {});
        }
      }
    };
  }, []);

  return React.createElement(
    "section",
    null,
    React.createElement("div", {
      id: "qr-reader",
      style: { width: "100%" },
    }),

    error &&
      React.createElement(
        "p",
        { role: "alert" },
        error
      ),

    !running
      ? React.createElement(
          "button",
          {
            type: "button",
            onClick: startScanner,
          },
          "Open camera"
        )
      : React.createElement(
          "button",
          {
            type: "button",
            onClick: stopScanner,
          },
          "Stop camera"
        )
  );
}

module.exports = QRScanner;
