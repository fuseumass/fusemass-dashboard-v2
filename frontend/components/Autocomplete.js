"use client";

import { useEffect, useRef, useState } from "react";
import { Input } from "@/components/ui/input";
import { apiFetch } from "@/lib/api";
import { cn } from "@/lib/utils";

/**
 * The suggestion list under an autocomplete input. Shared with
 * TagAutocomplete. Options are picked on mouse down so the input keeps focus.
 * @param {object} props - `{ options, activeIndex, onPick }`.
 * @returns {JSX.Element}
 */
export function SuggestionList({ options, activeIndex, onPick }) {
  return (
    <div
      role="listbox"
      className="absolute inset-x-0 top-full z-20 mt-1 max-h-56 overflow-y-auto rounded-lg bg-popover p-1 text-popover-foreground shadow-md ring-1 ring-foreground/10"
    >
      {options.map((option, index) => (
        <button
          type="button"
          role="option"
          aria-selected={index === activeIndex}
          key={option}
          className={cn(
            "flex w-full items-center rounded-md px-2 py-1.5 text-left text-sm outline-none hover:bg-accent hover:text-accent-foreground",
            index === activeIndex && "bg-accent text-accent-foreground",
          )}
          onMouseDown={(e) => {
            e.preventDefault();
            onPick(option);
          }}
        >
          {option}
        </button>
      ))}
    </div>
  );
}

/**
 * Single-value async autocomplete (e.g. university). Fetches suggestions from
 * a backend meta endpoint that returns `{ results: string[] }`. Free text is
 * allowed so applicants can enter a school that isn't in the list yet.
 * @param {object} props - `{ value, onChange, endpoint, placeholder, id, required, invalid }`.
 * @returns {JSX.Element}
 */
export default function Autocomplete({
  value,
  onChange,
  endpoint,
  placeholder = "",
  id,
  required = false,
  invalid = false,
}) {
  const [query, setQuery] = useState(value || "");
  const [options, setOptions] = useState([]);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
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
    setActive(-1);
  }

  function onKeyDown(e) {
    if (!open || options.length === 0) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((i) => (i + 1) % options.length);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((i) => (i <= 0 ? options.length - 1 : i - 1));
    } else if (e.key === "Enter" && active >= 0) {
      e.preventDefault();
      pick(options[active]);
    } else if (e.key === "Escape") {
      setOpen(false);
    }
  }

  return (
    <div ref={boxRef} className="relative">
      <Input
        id={id}
        value={query}
        placeholder={placeholder}
        required={required}
        aria-invalid={invalid || undefined}
        autoComplete="off"
        onChange={(e) => {
          setQuery(e.target.value);
          onChange(e.target.value);
          setOpen(true);
          setActive(-1);
        }}
        onFocus={() => setOpen(true)}
        onKeyDown={onKeyDown}
      />
      {open && options.length > 0
        ? <SuggestionList options={options} activeIndex={active} onPick={pick} />
        : null}
    </div>
  );
}
