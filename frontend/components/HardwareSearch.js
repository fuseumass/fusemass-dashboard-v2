"use client";

import { Search, X } from "lucide-react";
import { useId, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";

// Type-ahead picker over the inventory the page already loaded. Filtering is
// local and instant (a few hundred items), so there is no debounce.

const MAX_RESULTS = 50;
// Printed item labels encode "hardware:<itemId>"; a USB scanner types that.
const LABEL_CODE = /^hardware:([a-f0-9]{24})$/i;

/**
 * @param {string} query - What staff typed.
 * @returns {Array<string>} Lowercased words.
 */
function words(query) {
  return String(query || "")
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);
}

/**
 * Items whose name, category, bin or description contain every word of the
 * query, in any order. Name matches rank first, then in-stock items.
 * @param {Array<object>} items - Inventory items.
 * @param {string} query - Search text ("pi 5", "usb mini").
 * @returns {Array<object>} Matching items, best first.
 */
export function matchHardware(items, query) {
  const terms = words(query);
  if (!terms.length) return [];
  const scored = [];
  for (const item of items) {
    const name = String(item.name || "").toLowerCase();
    const haystack = [name, item.category, item.location, item.description]
      .join(" ")
      .toLowerCase();
    if (!terms.every((term) => haystack.includes(term))) continue;
    // Whole-word starts beat matches inside a word ("pi" finds Raspberry
    // Pi before Prototyping).
    const nameWords = name.split(/[^a-z0-9]+/);
    let score = 0;
    for (const term of terms) {
      if (nameWords.includes(term)) score += 4;
      else if (nameWords.some((word) => word.startsWith(term))) score += 3;
      else if (name.includes(term)) score += 2;
    }
    if (item.availableQty > 0) score += 0.5;
    scored.push({ item, score });
  }
  scored.sort(
    (a, b) =>
      b.score - a.score ||
      String(a.item.name).localeCompare(String(b.item.name)),
  );
  return scored.map((entry) => entry.item);
}

/**
 * Why an item cannot be lent right now, or "" when it can.
 * @param {object} item - Inventory item.
 * @param {number} holding - How many of it the attendee already has.
 * @returns {string} Reason.
 */
export function unavailableReason(item, holding) {
  if (!(item.availableQty > 0)) return "Out of stock";
  if (holding >= (item.maxPerAttendee || 1)) return "Limit reached";
  return "";
}

/**
 * Search field plus a tappable result list. Arrow keys move, Enter picks,
 * Escape clears.
 * @param {object} props
 * @param {Array<object>} props.items - Inventory items.
 * @param {string} props.query - Controlled search text.
 * @param {function(string): void} props.onQueryChange - Text changed.
 * @param {function(object): void} props.onPick - Called with a lendable item.
 * @param {object} [props.holding] - Item id to open loan count for the attendee.
 * @param {boolean} [props.disabled] - Disable the field.
 * @param {object} [props.inputRef] - Ref for the input, to refocus it.
 * @param {string} [props.label] - Visible label.
 * @returns {JSX.Element}
 */
export default function HardwareSearch({
  items,
  query,
  onQueryChange,
  onPick,
  holding = {},
  disabled = false,
  inputRef,
  label = "Find hardware",
}) {
  const id = useId();
  const listId = `${id}-results`;
  const [active, setActive] = useState(0);
  const results = matchHardware(items, query);
  const shown = results.slice(0, MAX_RESULTS);
  const open = Boolean(query.trim()) && !disabled;

  function reasonFor(item) {
    return unavailableReason(item, holding[item._id] || 0);
  }

  function change(value) {
    const label = value.trim().match(LABEL_CODE);
    if (label) {
      const item = items.find((entry) => entry._id === label[1]);
      if (item && !reasonFor(item)) {
        onQueryChange("");
        onPick(item);
        return;
      }
    }
    setActive(0);
    onQueryChange(value);
  }

  function step(from, delta) {
    if (!shown.length) return 0;
    return (from + delta + shown.length) % shown.length;
  }

  function onKeyDown(e) {
    if (e.key === "Escape") {
      e.preventDefault();
      setActive(0);
      onQueryChange("");
    } else if (e.key === "ArrowDown" && open) {
      e.preventDefault();
      setActive((index) => step(index, 1));
    } else if (e.key === "ArrowUp" && open) {
      e.preventDefault();
      setActive((index) => step(index, -1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const item = shown[Math.min(active, shown.length - 1)];
      if (item && !reasonFor(item)) onPick(item);
    }
  }

  const activeItem = open ? shown[Math.min(active, shown.length - 1)] : null;

  return (
    <div className="space-y-2">
      <Label htmlFor={`${id}-input`}>{label}</Label>
      <div className="relative">
        <Search
          className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground"
          aria-hidden="true"
        />
        <Input
          ref={inputRef}
          id={`${id}-input`}
          role="combobox"
          aria-expanded={open}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={
            activeItem ? `${id}-option-${activeItem._id}` : undefined
          }
          placeholder="Name, category or bin, like pi 5"
          autoComplete="off"
          autoCapitalize="off"
          spellCheck={false}
          enterKeyHint="search"
          disabled={disabled}
          value={query}
          onChange={(e) => change(e.target.value)}
          onKeyDown={onKeyDown}
          className="h-11 pr-11 pl-9 text-base"
        />
        {query
          ? <Button
              type="button"
              variant="ghost"
              size="icon"
              aria-label="Clear search"
              className="absolute top-1/2 right-1 -translate-y-1/2"
              onClick={() => {
                onQueryChange("");
                inputRef?.current?.focus();
              }}
            >
              <X aria-hidden="true" />
            </Button>
          : null}
      </div>
      {open
        ? <div className="space-y-2">
            <p className="text-xs text-muted-foreground" aria-live="polite">
              {results.length === 0
                ? "No hardware matches. Try fewer words."
                : results.length > shown.length
                  ? `Showing ${shown.length} of ${results.length}. Keep typing to narrow.`
                  : `${results.length} ${results.length === 1 ? "match" : "matches"}`}
            </p>
            <div
              id={listId}
              role="listbox"
              aria-label="Matching hardware"
              className="max-h-[min(28rem,60vh)] divide-y overflow-y-auto rounded-lg border bg-card"
            >
              {shown.map((item, index) => {
                const reason = reasonFor(item);
                const held = holding[item._id] || 0;
                return (
                  <button
                    type="button"
                    tabIndex={-1}
                    key={item._id}
                    id={`${id}-option-${item._id}`}
                    role="option"
                    aria-selected={index === active}
                    aria-disabled={Boolean(reason)}
                    // Keep focus in the input while tapping a row.
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => {
                      if (!reason) onPick(item);
                    }}
                    onMouseEnter={() => setActive(index)}
                    className={cn(
                      "flex min-h-14 w-full cursor-pointer items-center gap-3 px-3 py-2 text-left outline-none",
                      index === active && "bg-muted",
                      reason && "cursor-not-allowed text-muted-foreground",
                    )}
                  >
                    <span className="min-w-0 flex-1">
                      <span className="block text-sm font-medium wrap-anywhere">
                        {item.name}
                      </span>
                      <span className="block text-xs text-muted-foreground wrap-anywhere">
                        {[item.category, item.location]
                          .filter(Boolean)
                          .join(" · ") || "No category or bin"}
                        {` · Limit ${item.maxPerAttendee || 1}`}
                        {held ? `, has ${held}` : ""}
                      </span>
                    </span>
                    <span className="flex shrink-0 flex-col items-end gap-1">
                      <span className="text-sm tabular-nums">
                        {item.availableQty}
                        <span className="text-muted-foreground">
                          {" "}
                          / {item.totalQty}
                        </span>
                      </span>
                      {reason
                        ? <Badge
                            variant={
                              reason === "Out of stock"
                                ? "destructive"
                                : "warning"
                            }
                          >
                            {reason}
                          </Badge>
                        : null}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
        : <p className="text-xs text-muted-foreground">
            {disabled
              ? "Pull up a checked-in attendee to lend hardware."
              : "Type to search. Arrow keys and Enter pick, Escape clears."}
          </p>}
    </div>
  );
}
