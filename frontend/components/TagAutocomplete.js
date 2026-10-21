"use client";

import { X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { apiFetch } from "@/lib/api";

// Multi-select async autocomplete rendered as chips (e.g. programming skills,
// hardware skills). Suggestions come from a backend meta endpoint returning
// { results: string[] }. Applicants can also add free-text entries with Enter.
export default function TagAutocomplete({
  values = [],
  onChange,
  endpoint,
  placeholder = "",
}) {
  const [query, setQuery] = useState("");
  const [options, setOptions] = useState([]);
  const [open, setOpen] = useState(false);
  const boxRef = useRef(null);

  useEffect(() => {
    if (!open) return;
    const handle = setTimeout(() => {
      apiFetch(`${endpoint}?q=${encodeURIComponent(query)}`)
        .then((data) => setOptions(data.results || []))
        .catch(() => setOptions([]));
    }, 180);
    return () => clearTimeout(handle);
  }, [query, open, endpoint]);

  useEffect(() => {
    function onDocClick(e) {
      if (boxRef.current && !boxRef.current.contains(e.target)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, []);

  function add(tag) {
    const clean = String(tag).trim();
    if (clean && !values.includes(clean)) {
      onChange([...values, clean]);
    }
    setQuery("");
    setOpen(false);
  }

  function remove(tag) {
    onChange(values.filter((v) => v !== tag));
  }

  const suggestions = options.filter((o) => !values.includes(o));

  return (
    <div ref={boxRef} style={{ position: "relative" }}>
      {values.length > 0
        ? <div
            style={{
              display: "flex",
              flexWrap: "wrap",
              gap: 6,
              marginBottom: 6,
            }}
          >
            {values.map((tag) => (
              <span key={tag} className="chip">
                {tag}
                <button
                  type="button"
                  onClick={() => remove(tag)}
                  aria-label={`Remove ${tag}`}
                >
                  <X size={12} aria-hidden="true" />
                </button>
              </span>
            ))}
          </div>
        : null}

      <input
        className="input"
        value={query}
        placeholder={placeholder}
        autoComplete="off"
        onChange={(e) => {
          setQuery(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            if (query.trim()) add(query);
          }
        }}
      />

      {open && suggestions.length > 0
        ? <div className="ac-menu">
            {suggestions.map((option) => (
              <button
                type="button"
                key={option}
                className="ac-option"
                onMouseDown={(e) => {
                  e.preventDefault();
                  add(option);
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
