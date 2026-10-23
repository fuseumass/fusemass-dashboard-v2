"use client";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

const SOURCE_TAGS = {
  env: { label: "From .env", variant: "secondary" },
  default: { label: "Default", variant: "outline" },
  unset: { label: "Not set", variant: "outline" },
};

/**
 * One row of the Technical settings page: label and help on the left, the
 * control and a small source tag on the right.
 * @param {object} props
 * @param {object} props.setting - One entry of GET /api/admin/system-config.
 * @param {string|undefined} props.draft - Unsaved text, if the field was touched.
 * @param {boolean} props.removePending - Marked for removal from .env on save.
 * @param {boolean} props.replacing - The field for a new value is open.
 * @param {string} props.error - Server validation message for this key.
 * @param {boolean} props.disabled - Locked while saving or restarting.
 * @param {object} props.on - { change(key, text), remove(key), cancelRemove(key), startReplace(key), cancelReplace(key) }.
 * @returns {JSX.Element}
 */
export default function SystemSettingRow({
  setting,
  draft,
  removePending,
  replacing,
  error,
  disabled,
  on,
}) {
  const id = `sys-${setting.key}`;
  const tag = SOURCE_TAGS[setting.source] || SOURCE_TAGS.unset;
  const changed = removePending || (draft !== undefined && draft !== "");

  return (
    <div className="grid gap-3 py-4 first:pt-0 last:pb-0 md:grid-cols-[minmax(0,1fr)_minmax(0,24rem)] md:gap-6">
      <div className="min-w-0 space-y-1">
        <Label htmlFor={id}>{setting.label}</Label>
        <p className="font-mono text-xs text-muted-foreground">{setting.key}</p>
        <p className="text-sm text-muted-foreground">{setting.help}</p>
        {setting.restartRequired && setting.editable
          ? <p className="text-xs text-muted-foreground">
              Needs a restart to take effect.
            </p>
          : null}
      </div>

      <div className="min-w-0 space-y-2">
        {setting.editable
          ? <Control
              id={id}
              setting={setting}
              draft={draft}
              removePending={removePending}
              replacing={replacing}
              error={error}
              disabled={disabled}
              on={on}
            />
          : <ReadOnly id={id} setting={setting} />}

        <div className="flex flex-wrap items-center gap-2">
          <Badge variant={tag.variant}>{tag.label}</Badge>
          {!setting.editable
            ? <Badge variant="outline">Read only</Badge>
            : null}
          {changed ? <Badge variant="warning">Unsaved</Badge> : null}
          {setting.editable && setting.isSet && !removePending
            ? <Button
                type="button"
                variant="ghost"
                size="xs"
                disabled={disabled}
                onClick={() => on.remove(setting.key)}
              >
                Remove
              </Button>
            : null}
          {removePending
            ? <Button
                type="button"
                variant="ghost"
                size="xs"
                disabled={disabled}
                onClick={() => on.cancelRemove(setting.key)}
              >
                Cancel removal
              </Button>
            : null}
        </div>
        {error
          ? <p className="text-sm text-destructive" role="alert">
              {error}
            </p>
          : null}
      </div>
    </div>
  );
}

// The page is write-only: it shows whether a value is set, never the value.
function ReadOnly({ id, setting }) {
  return (
    <p id={id} className="text-sm">
      {setting.isSet ? "Set on the server" : "Not set on the server"}
    </p>
  );
}

function Control({
  id,
  setting,
  draft,
  removePending,
  replacing,
  error,
  disabled,
  on,
}) {
  if (!replacing) {
    return (
      <div className="flex flex-wrap items-center gap-2">
        <span id={id} className="text-sm">
          {removePending
            ? "Removed from .env on save"
            : setting.isSet
              ? "Set"
              : "Not set"}
        </span>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={disabled || removePending}
          onClick={() => on.startReplace(setting.key)}
        >
          {setting.isSet ? "Replace" : "Set value"}
        </Button>
      </div>
    );
  }

  const field =
    setting.type === "boolean"
      ? <Select
          value={draft ?? ""}
          disabled={disabled}
          onValueChange={(v) => on.change(setting.key, v)}
        >
          <SelectTrigger
            id={id}
            className="w-full"
            aria-invalid={Boolean(error)}
          >
            <SelectValue placeholder="Choose" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="true">true</SelectItem>
            <SelectItem value="false">false</SelectItem>
          </SelectContent>
        </Select>
      : <Input
          id={id}
          type={setting.secret ? "password" : "text"}
          inputMode={setting.type === "number" ? "numeric" : undefined}
          autoComplete={setting.secret ? "new-password" : "off"}
          spellCheck={false}
          placeholder="Enter the new value"
          value={draft ?? ""}
          aria-invalid={Boolean(error)}
          disabled={disabled}
          onChange={(e) => on.change(setting.key, e.target.value)}
        />;

  return (
    <div className="flex gap-2">
      {field}
      <Button
        type="button"
        variant="ghost"
        disabled={disabled}
        onClick={() => on.cancelReplace(setting.key)}
      >
        Cancel
      </Button>
    </div>
  );
}
