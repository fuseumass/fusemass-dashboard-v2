"use client";

import { Camera } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";

// After a code is handled, the same code is ignored for this long. The camera
// sees one QR on many consecutive frames; without this, holding a phone up
// for a second would fire a check-in and then a string of "already checked
// in" errors.
const REPEAT_MS = 3000;

/**
 * Camera QR scanner (html5-qrcode). The camera keeps running between scans so
 * a meal line can be scanned back to back; while `onScan` is still working on
 * one code, further frames are ignored.
 *
 * The library touches `window` when imported, so it is loaded on demand when
 * the camera is opened rather than at the top of the file (which would also
 * run during server rendering).
 *
 * @param {object} props
 * @param {function(string): Promise<void>} props.onScan - Called with each decoded code.
 */
export default function QRScanner({ onScan }) {
  const elementId = `qr-reader-${useId().replace(/:/g, "")}`;
  const scannerRef = useRef(null);
  const busyRef = useRef(false);
  const lastRef = useRef({ text: "", at: 0 });
  // The page swaps onScan when staff change station; the running camera
  // callback must always call the current one.
  const onScanRef = useRef(onScan);
  onScanRef.current = onScan;

  const [running, setRunning] = useState(false);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState("");

  function handleDecode(text) {
    const now = Date.now();
    if (busyRef.current) return;
    if (text === lastRef.current.text && now - lastRef.current.at < REPEAT_MS) {
      return;
    }

    busyRef.current = true;
    lastRef.current = { text, at: now };
    Promise.resolve(onScanRef.current?.(text))
      .catch((err) => setError(err.message || "Could not process that code."))
      .finally(() => {
        busyRef.current = false;
        lastRef.current = { text, at: Date.now() };
      });
  }

  async function stopScanner() {
    const scanner = scannerRef.current;
    scannerRef.current = null;
    setRunning(false);
    if (!scanner) return;
    try {
      if (scanner.isScanning) await scanner.stop();
      scanner.clear();
    } catch (err) {
      console.error("Error stopping QR scanner:", err);
    }
  }

  async function startScanner() {
    if (scannerRef.current) return;
    setError("");
    setStarting(true);

    try {
      const { Html5Qrcode, Html5QrcodeSupportedFormats } = await import(
        "html5-qrcode"
      );
      const scanner = new Html5Qrcode(elementId, {
        formatsToSupport: [Html5QrcodeSupportedFormats.QR_CODE],
        verbose: false,
      });
      scannerRef.current = scanner;
      await scanner.start(
        { facingMode: "environment" },
        { fps: 10, qrbox: { width: 250, height: 250 } },
        handleDecode,
        () => {
          // Called for every frame without a QR code; nothing to do.
        },
      );
      setRunning(true);
    } catch (err) {
      console.error("Unable to start QR scanner:", err);
      await stopScanner();
      setError(
        "Unable to open the camera. Allow camera access, and make sure the site is served over HTTPS.",
      );
    } finally {
      setStarting(false);
    }
  }

  // Release the camera when the page unmounts.
  useEffect(() => {
    return () => {
      const scanner = scannerRef.current;
      scannerRef.current = null;
      if (scanner?.isScanning) {
        scanner
          .stop()
          .then(() => scanner.clear())
          .catch(() => {});
      }
    };
  }, []);

  return (
    <div className="space-y-3">
      <div
        id={elementId}
        className="w-full max-w-md overflow-hidden rounded-lg empty:-mb-3"
      />

      {error
        ? <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        : null}

      <Button
        type="button"
        size="lg"
        variant={running ? "outline" : "default"}
        className="max-sm:w-full"
        loading={starting}
        onClick={running ? stopScanner : startScanner}
      >
        {starting ? (
          "Opening camera"
        ) : running ? (
          "Stop camera"
        ) : (
          <>
            <Camera aria-hidden="true" />
            Open camera
          </>
        )}
      </Button>
    </div>
  );
}
