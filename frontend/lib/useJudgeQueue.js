"use client";
import { useCallback, useEffect, useState } from "react";
import { apiFetch } from "@/lib/api";
export default function useJudgeQueue() {
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const load = useCallback(async () => {
    try {
      const [result, calibration] = await Promise.all([
        apiFetch("/api/judging/queue"),
        apiFetch("/api/judging/calibration"),
      ]);
      result.calibrationDone = calibration.calibrationDone;
      setData(result);
      setError("");
    } catch (err) {
      setError(err.message);
    }
  }, []);
  useEffect(() => {
    load();
    const timer = setInterval(load, 15000);
    return () => clearInterval(timer);
  }, [load]);
  async function action(path, body) {
    if (busy) return false;
    setBusy(true);
    setError("");
    setMessage("");
    try {
      await apiFetch(`/api/judging/${path}`, {
        method: "POST",
        body: JSON.stringify(body),
      });
      setMessage(path === "skip" ? "Project skipped" : "Score saved");
      await load();
      return true;
    } catch (err) {
      if (err.status === 409) await load();
      setError(err.message);
      return false;
    } finally {
      setBusy(false);
    }
  }
  return { data, error, busy, message, load, action };
}
