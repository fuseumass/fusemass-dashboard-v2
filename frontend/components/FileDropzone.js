"use client";

import { FileText, Upload, X } from "lucide-react";
import { useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * Human-readable file size.
 * @param {number} bytes - Size in bytes.
 * @returns {string} e.g. "212 KB" or "1.4 MB".
 */
export function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * A file picker with a drop zone. Shows the chosen file's name and size, and
 * lets the file be removed. The File itself is kept by the parent through
 * `onChange` (and `inputRef` for forms that read it at submit time).
 * @param {object} props - `{ file, onChange, accept, id, invalid, hint }`.
 * @returns {JSX.Element}
 */
export default function FileDropzone({
  file,
  onChange,
  accept,
  id,
  invalid = false,
  hint,
}) {
  const inputRef = useRef(null);
  const [dragging, setDragging] = useState(false);

  function pick(next) {
    onChange(next || null);
    if (!next && inputRef.current) {
      inputRef.current.value = "";
    }
  }

  function onDrop(e) {
    e.preventDefault();
    setDragging(false);
    const dropped = e.dataTransfer?.files?.[0];
    if (dropped) {
      pick(dropped);
    }
  }

  return (
    <div>
      <input
        ref={inputRef}
        id={id}
        type="file"
        accept={accept}
        className="sr-only"
        onChange={(e) => pick(e.target.files?.[0])}
      />
      {file
        ? <div className="flex items-center gap-3 rounded-lg border border-input p-3">
            <FileText
              className="size-4 shrink-0 text-muted-foreground"
              aria-hidden="true"
            />
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium">{file.name}</p>
              <p className="text-xs text-muted-foreground tabular-nums">
                {formatBytes(file.size)}
              </p>
            </div>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label="Remove file"
              onClick={() => pick(null)}
            >
              <X aria-hidden="true" />
            </Button>
          </div>
        : <button
            type="button"
            onClick={() => inputRef.current?.click()}
            onDragOver={(e) => {
              e.preventDefault();
              setDragging(true);
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={onDrop}
            aria-invalid={invalid || undefined}
            className={cn(
              "flex w-full flex-col items-center gap-1 rounded-lg border border-dashed border-input px-4 py-5 text-center text-sm outline-none transition-colors hover:bg-muted focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50",
              dragging && "border-primary bg-muted",
              invalid && "border-destructive",
            )}
          >
            <Upload
              className="size-4 text-muted-foreground"
              aria-hidden="true"
            />
            <span className="font-medium">Choose a file or drop it here</span>
            {hint
              ? <span className="text-xs text-muted-foreground">{hint}</span>
              : null}
          </button>}
    </div>
  );
}
