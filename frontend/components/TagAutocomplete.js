"use client";

import { X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { SuggestionList } from "@/components/Autocomplete";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { apiFetch } from "@/lib/api";

/**
 * Multi-select async autocomplete shown as tags (e.g. programming skills,
 * hardware skills). Suggestions come from a backend meta endpoint returning
 * `{ results: string[] }`. Applicants can also add free text with Enter.
 * @param {object} props - `{ values, onChange, endpoint, placeholder, id }`.
 * @returns {JSX.Element}
 */
export default function TagAutocomplete({
  values = [],
  onChange,
  endpoint,
  placeholder = "",
  id,
}) {
  const [query, setQuery] = useState("");
  const [options, setOptions] = useState([]);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
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
    setActive(-1);
  }

  function remove(tag) {
    onChange(values.filter((v) => v !== tag));
  }

  const suggestions = options.filter((o) => !values.includes(o));

  function onKeyDown(e) {
    if (e.key === "ArrowDown" && suggestions.length > 0) {
      e.preventDefault();
      setActive((i) => (i + 1) % suggestions.length);
    } else if (e.key === "ArrowUp" && suggestions.length > 0) {
      e.preventDefault();
      setActive((i) => (i <= 0 ? suggestions.length - 1 : i - 1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (open && active >= 0 && suggestions[active]) {
        add(suggestions[active]);
      } else if (query.trim()) {
        add(query);
      }
    } else if (e.key === "Escape") {
      setOpen(false);
    }
  }

  return (
    <div ref={boxRef} className="space-y-2">
      {values.length > 0
        ? <ul className="flex flex-wrap gap-1.5">
            {values.map((tag) => (
              <li key={tag}>
                <Badge variant="secondary" className="h-6 gap-1 pr-1">
                  {tag}
                  <button
                    type="button"
                    onClick={() => remove(tag)}
                    aria-label={`Remove ${tag}`}
                    className="rounded-sm p-0.5 text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    <X aria-hidden="true" />
                  </button>
                </Badge>
              </li>
            ))}
          </ul>
        : null}

      <div className="relative">
        <Input
          id={id}
          value={query}
          placeholder={placeholder}
          autoComplete="off"
          onChange={(e) => {
            setQuery(e.target.value);
            setOpen(true);
            setActive(-1);
          }}
          onFocus={() => setOpen(true)}
          onKeyDown={onKeyDown}
        />
        {open && suggestions.length > 0
          ? <SuggestionList
              options={suggestions}
              activeIndex={active}
              onPick={add}
            />
          : null}
      </div>
    </div>
  );
}
