"use client";

import { useEffect, useRef, useState } from "react";
import { apiFetch } from "@/lib/api";

// Single-value async autocomplete (e.g. university). Fetches suggestions from a
// backend meta endpoint that returns { results: string[] }. Free text is allowed
// so applicants can enter a school that isn't in the list yet.
export default function Autocomplete({
  value,
  onChange,
  endpoint,
  placeholder = "",
  id,
}) {
  const [query, setQuery] = useState(value || "");
  const [options, setOptions] = useState([]);
  const [open, setOpen] = useState(false);
  const boxRef = useRef(null);

  useEffect(() => {
    setQuery(value || "");
  }, [value]);

  // Debounced fetch as the user types.
  useEffect(() => {
    if (!open) return;
    const handle = setTimeout(() => {
      apiFetch(`${endpoint}?q=${encodeURIComponent(query)}`)
        .then((data) => setOptions(data.results || []))
        .catch(() => setOptions([]));
    }, 180);
    return () => clearTimeout(handle);
  }, [query, open, endpoint]);

  // Close on outside click.
  useEffect(() => {
    function onDocClick(e) {
      if (boxRef.current && !boxRef.current.contains(e.target)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, []);

  function pick(option) {
    onChange(option);
    setQuery(option);
    setOpen(false);
  }

  return (
    <div ref={boxRef} style={{ position: "relative" }}>
      <input
        id={id}
        className="input"
        value={query}
        placeholder={placeholder}
        autoComplete="off"
        onChange={(e) => {
          setQuery(e.target.value);
          onChange(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
      />
      {open && options.length > 0
        ? <div className="ac-menu">
            {options.map((option) => (
              <button
                type="button"
                key={option}
                className="ac-option"
                onMouseDown={(e) => {
                  e.preventDefault();
                  pick(option);
                }}
              >
                {option}
              </button>
            ))}
          </div>
        : null}
    </div>
  );
}
