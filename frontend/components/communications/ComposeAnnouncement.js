"use client";

import { Eye, Send } from "lucide-react";
import { useRef, useState } from "react";
import { useForm } from "react-hook-form";
import { z } from "zod";
import AnnouncementPreview from "@/components/communications/AnnouncementPreview";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Form,
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
  FormRootError,
} from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { apiFetch } from "@/lib/api";
import {
  formatDateTime,
  fromEventInput,
  getEventTimeZone,
} from "@/lib/datetime";
import { applyServerError, zodResolver } from "@/lib/forms";
import { notifySuccess } from "@/lib/notify";

export const CHANNEL_LABELS = {
  email: "Email",
  discord_announcements: "Discord announcements",
  discord_workshops: "Discord workshops",
};

const schema = z
  .object({
    title: z.string().trim().max(256, "Keep the subject to 256 characters."),
    message: z.string().trim().max(4096, "Keep the email to 4096 characters."),
    discordTitle: z
      .string()
      .trim()
      .max(256, "Keep the Discord title to 256 characters."),
    discordMessage: z.string().trim().max(4096),
    url: z
      .string()
      .trim()
      .refine(
        (v) => v === "" || /^https?:\/\/\S+$/i.test(v),
        "Enter a full link starting with https://, or leave it empty.",
      ),
    channels: z.array(z.string()).min(1, "Pick at least one channel."),
    segment: z.string(),
    workshop: z.string(),
    checkedInOnly: z.boolean(),
    when: z.enum(["now", "later"]),
    scheduledFor: z.string(),
  })
  .superRefine((values, ctx) => {
    const issue = (path, message) =>
      ctx.addIssue({ code: "custom", path: [path], message });
    if (values.channels.includes("email")) {
      if (!values.title) issue("title", "Enter a subject.");
      if (!values.message) issue("message", "Write the email.");
      if (!values.segment) {
        issue("segment", "Pick who should get the email.");
      } else if (values.segment === "workshop" && !values.workshop) {
        issue("workshop", "Pick the workshop.");
      }
    }
    if (values.channels.some((c) => c !== "email")) {
      if (!values.discordMessage) {
        issue("discordMessage", "Write the Discord message.");
      } else if (
        values.discordMessage.length > (values.discordTitle ? 4096 : 2000)
      ) {
        issue(
          "discordMessage",
          values.discordTitle
            ? "Keep the Discord message to 4096 characters."
            : "Keep the Discord message to 2000 characters, or add a title to allow 4096.",
        );
      }
    }
    if (values.when === "later") {
      const at = fromEventInput(values.scheduledFor);
      if (!at || at.getTime() <= Date.now()) {
        issue("scheduledFor", "Pick a time in the future.");
      }
    }
  });

// Major announcements go to email and the announcements channel by default.
function emptyValues(channels) {
  return {
    title: "",
    message: "",
    discordTitle: "",
    discordMessage: "",
    url: "",
    channels: ["email", "discord_announcements"].filter((c) => channels[c]),
    segment: "",
    workshop: "",
    checkedInOnly: false,
    when: "now",
    scheduledFor: "",
  };
}

// Values -> the API body.
function toBody(values) {
  const email = values.channels.includes("email");
  const discord = values.channels.some((channel) => channel !== "email");
  const body = {
    title: email ? values.title : "",
    message: email ? values.message : "",
    url: values.url,
    channels: values.channels,
  };
  if (discord) {
    body.discordMessage = values.discordMessage;
    body.discordTitle = values.discordTitle;
  }
  if (email) {
    body.audience = {
      segment: values.segment,
      checkedInOnly: values.checkedInOnly,
      ...(values.segment === "workshop" ? { workshop: values.workshop } : {}),
    };
  }
  if (values.when === "later") {
    body.scheduledFor = fromEventInput(values.scheduledFor)?.toISOString();
  }
  return body;
}

// What the confirm dialog says will happen.
function summary(values, preview) {
  const parts = [];
  if (values.channels.includes("email")) {
    const n = preview?.audience?.recipients ?? 0;
    parts.push(`email ${n} ${n === 1 ? "person" : "people"}`);
  }
  for (const channel of values.channels) {
    if (channel !== "email") parts.push(`post to ${CHANNEL_LABELS[channel]}`);
  }
  if (parts.length < 2) return parts.join("");
  return `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}

/**
 * Write an announcement and send it now or later, to email and Discord.
 * @param {object} props
 * @param {object} props.channels - Which channels exist ({ email, discord_announcements, discord_workshops }).
 * @param {Array<object>} props.audiences - { key, label, inAudience?, recipients? }.
 * @param {Array<object>} props.tags - Saved Discord mentions { label, roleId }.
 * @param {Array<object>} props.workshops - { id, title, startsAt }.
 * @param {object} props.webhookEnv - Env var name per Discord channel, for the "not set up" hint.
 * @param {function} props.onSent - Called with the new announcement.
 * @returns {JSX.Element}
 */
export default function ComposeAnnouncement({
  channels,
  audiences,
  tags,
  workshops,
  webhookEnv,
  onSent,
}) {
  const form = useForm({
    resolver: zodResolver(schema),
    defaultValues: emptyValues(channels),
  });
  // The Discord text starts as a copy of the email text, until it is edited.
  const discordEdited = useRef(false);
  const discordBox = useRef(null);
  const [preview, setPreview] = useState(null);
  const [previewing, setPreviewing] = useState(false);
  const [confirming, setConfirming] = useState(null);
  const [sending, setSending] = useState(false);

  const values = form.watch();
  const wantsEmail = values.channels.includes("email");
  const wantsDiscord = values.channels.some((c) => c !== "email");
  const zone = getEventTimeZone();

  async function runPreview(vals) {
    form.clearErrors("root.server");
    setPreviewing(true);
    try {
      const data = await apiFetch("/api/staff/communications/preview", {
        method: "POST",
        body: JSON.stringify(toBody(vals)),
      });
      setPreview(data);
      return data;
    } catch (err) {
      applyServerError(form, err);
      return null;
    } finally {
      setPreviewing(false);
    }
  }

  function insertTag(label) {
    const box = discordBox.current;
    const current = form.getValues("discordMessage");
    const start = box ? box.selectionStart : current.length;
    const end = box ? box.selectionEnd : current.length;
    const before = current.slice(0, start);
    const lead = before && !/\s$/.test(before) ? " " : "";
    const text = `${before}${lead}@${label} ${current.slice(end)}`;
    const caret = before.length + lead.length + label.length + 2;
    discordEdited.current = true;
    form.setValue("discordMessage", text, { shouldDirty: true });
    setTimeout(() => {
      box?.focus();
      box?.setSelectionRange(caret, caret);
    }, 0);
  }

  async function askToSend(vals) {
    const data = await runPreview(vals);
    if (data) setConfirming({ values: vals, preview: data });
  }

  async function send() {
    const vals = confirming.values;
    setSending(true);
    try {
      const data = await apiFetch("/api/staff/communications/announcements", {
        method: "POST",
        body: JSON.stringify(toBody(vals)),
      });
      setConfirming(null);
      setPreview(null);
      discordEdited.current = false;
      form.reset(emptyValues(channels));
      notifySuccess(
        data.announcement.status === "scheduled"
          ? `Scheduled for ${formatDateTime(data.announcement.scheduledFor)}`
          : data.announcement.status === "failed"
            ? "Not sent. See the history for why."
            : "Announcement sent",
      );
      onSent(data.announcement);
    } catch (err) {
      setConfirming(null);
      applyServerError(form, err);
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
      <Card>
        <CardHeader>
          <CardTitle className="text-base font-semibold">
            Compose announcement
          </CardTitle>
          <CardDescription>
            Email and Discord have their own text. Accepted participants get
            announcement emails unless they opted out; everyone else only if
            they opted in.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Form {...form}>
            <form
              onSubmit={form.handleSubmit(askToSend)}
              noValidate
              className="space-y-4"
            >
              <FormField
                control={form.control}
                name="channels"
                render={({ field }) => (
                  <FormItem>
                    <p className="text-sm font-medium">Channels</p>
                    <div className="space-y-2">
                      {Object.keys(CHANNEL_LABELS).map((key) => {
                        const id = `channel-${key}`;
                        const ready = Boolean(channels[key]);
                        return (
                          <div key={key} className="flex items-start gap-2.5">
                            <Checkbox
                              id={id}
                              disabled={!ready}
                              checked={field.value.includes(key)}
                              onCheckedChange={(on) =>
                                field.onChange(
                                  on
                                    ? [...field.value, key]
                                    : field.value.filter((c) => c !== key),
                                )
                              }
                              className="mt-0.5"
                            />
                            <Label
                              htmlFor={id}
                              className="font-normal leading-snug"
                            >
                              <span>
                                {CHANNEL_LABELS[key]}
                                {ready
                                  ? null
                                  : <span className="block text-xs text-muted-foreground">
                                      {key === "email"
                                        ? "Email isn't set up on the server."
                                        : `Not set up. An admin adds ${webhookEnv?.[key] || "its webhook"} in Technical settings.`}
                                    </span>}
                              </span>
                            </Label>
                          </div>
                        );
                      })}
                    </div>
                    <FormMessage />
                  </FormItem>
                )}
              />

              {wantsEmail
                ? <fieldset className="space-y-4 rounded-md border border-border p-3">
                    <legend className="px-1 text-sm font-medium">Email</legend>
                    <FormField
                      control={form.control}
                      name="title"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel>Subject</FormLabel>
                          <FormControl>
                            <Input maxLength={256} {...field} />
                          </FormControl>
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                    <FormField
                      control={form.control}
                      name="message"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel>Message</FormLabel>
                          <FormControl>
                            <Textarea
                              rows={6}
                              maxLength={4096}
                              {...field}
                              onChange={(e) => {
                                field.onChange(e);
                                if (!discordEdited.current) {
                                  form.setValue(
                                    "discordMessage",
                                    e.target.value,
                                  );
                                }
                              }}
                            />
                          </FormControl>
                          <FormDescription className="tabular-nums">
                            Plain text, links become clickable.{" "}
                            {field.value.length} of 4096 characters
                          </FormDescription>
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                  </fieldset>
                : null}

              {wantsDiscord
                ? <fieldset className="space-y-4 rounded-md border border-border p-3">
                    <legend className="px-1 text-sm font-medium">
                      Discord
                    </legend>
                    <FormField
                      control={form.control}
                      name="discordTitle"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel>Embed title (optional)</FormLabel>
                          <FormControl>
                            <Input maxLength={256} {...field} />
                          </FormControl>
                          <FormDescription>
                            With a title the text goes in a card. Without one it
                            is a plain message.
                          </FormDescription>
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                    <FormField
                      control={form.control}
                      name="discordMessage"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel>Discord message</FormLabel>
                          <FormControl>
                            <Textarea
                              rows={5}
                              maxLength={4096}
                              {...field}
                              ref={(el) => {
                                field.ref(el);
                                discordBox.current = el;
                              }}
                              onChange={(e) => {
                                discordEdited.current = true;
                                field.onChange(e);
                              }}
                            />
                          </FormControl>
                          <div className="flex flex-wrap items-center gap-1.5">
                            <span className="text-xs text-muted-foreground">
                              Insert a mention:
                            </span>
                            {["everyone", "here", ...tags.map((t) => t.label)]
                              .filter(
                                (label, i, all) => all.indexOf(label) === i,
                              )
                              .map((label) => (
                                <Button
                                  key={label}
                                  type="button"
                                  size="xs"
                                  variant="outline"
                                  onClick={() => insertTag(label)}
                                >
                                  @{label}
                                </Button>
                              ))}
                          </div>
                          <FormDescription className="tabular-nums">
                            Only the mentions you write ping anyone. Unknown
                            @words stay plain text. {field.value.length} of{" "}
                            {values.discordTitle ? 4096 : 2000} characters
                          </FormDescription>
                          {wantsEmail && discordEdited.current
                            ? <Button
                                type="button"
                                size="xs"
                                variant="ghost"
                                className="self-start"
                                onClick={() => {
                                  discordEdited.current = false;
                                  form.setValue(
                                    "discordMessage",
                                    form.getValues("message"),
                                  );
                                }}
                              >
                                Copy the email text again
                              </Button>
                            : null}
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                  </fieldset>
                : null}

              <FormField
                control={form.control}
                name="url"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Link (optional)</FormLabel>
                    <FormControl>
                      <Input type="url" placeholder="https://" {...field} />
                    </FormControl>
                    <FormDescription>
                      Shown under the email, and added to the Discord message.
                    </FormDescription>
                    <FormMessage />
                  </FormItem>
                )}
              />

              {wantsEmail
                ? <div className="space-y-4 rounded-md border border-border p-3">
                    <FormField
                      control={form.control}
                      name="segment"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel>Email audience</FormLabel>
                          <Select
                            value={field.value}
                            onValueChange={field.onChange}
                          >
                            <FormControl>
                              <SelectTrigger className="w-full">
                                <SelectValue placeholder="Pick who gets it" />
                              </SelectTrigger>
                            </FormControl>
                            <SelectContent>
                              {audiences.map((a) => (
                                <SelectItem key={a.key} value={a.key}>
                                  {a.label}
                                  {a.inAudience !== undefined
                                    ? ` (${a.recipients} of ${a.inAudience} will get it)`
                                    : ""}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                    {values.segment === "workshop"
                      ? <FormField
                          control={form.control}
                          name="workshop"
                          render={({ field }) => (
                            <FormItem>
                              <FormLabel>Workshop</FormLabel>
                              <Select
                                value={field.value}
                                onValueChange={field.onChange}
                              >
                                <FormControl>
                                  <SelectTrigger className="w-full">
                                    <SelectValue placeholder="Pick a workshop" />
                                  </SelectTrigger>
                                </FormControl>
                                <SelectContent>
                                  {workshops.map((w) => (
                                    <SelectItem key={w.id} value={w.id}>
                                      {w.title} ({w.signupCount} signed up)
                                    </SelectItem>
                                  ))}
                                </SelectContent>
                              </Select>
                              <FormMessage />
                            </FormItem>
                          )}
                        />
                      : null}
                    <FormField
                      control={form.control}
                      name="checkedInOnly"
                      render={({ field }) => (
                        <FormItem className="flex items-center justify-between gap-3">
                          <FormLabel>Checked in only</FormLabel>
                          <FormControl>
                            <Switch
                              checked={field.value}
                              onCheckedChange={field.onChange}
                            />
                          </FormControl>
                        </FormItem>
                      )}
                    />
                  </div>
                : null}

              <FormField
                control={form.control}
                name="when"
                render={({ field }) => (
                  <FormItem>
                    <p className="text-sm font-medium">When</p>
                    <FormControl>
                      <RadioGroup
                        value={field.value}
                        onValueChange={field.onChange}
                        className="flex gap-4"
                      >
                        <div className="flex items-center gap-2">
                          <RadioGroupItem value="now" id="when-now" />
                          <Label htmlFor="when-now" className="font-normal">
                            Send now
                          </Label>
                        </div>
                        <div className="flex items-center gap-2">
                          <RadioGroupItem value="later" id="when-later" />
                          <Label htmlFor="when-later" className="font-normal">
                            Schedule
                          </Label>
                        </div>
                      </RadioGroup>
                    </FormControl>
                  </FormItem>
                )}
              />
              {values.when === "later"
                ? <FormField
                    control={form.control}
                    name="scheduledFor"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Send at</FormLabel>
                        <FormControl>
                          <Input type="datetime-local" {...field} />
                        </FormControl>
                        <FormDescription>
                          {zone ? `Event time (${zone}).` : "Your local time."}
                        </FormDescription>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                : null}

              <FormRootError />
              <div className="flex flex-wrap justify-end gap-2">
                <Button
                  type="button"
                  variant="outline"
                  loading={previewing && !confirming}
                  disabled={previewing || sending}
                  onClick={form.handleSubmit(runPreview)}
                >
                  <Eye aria-hidden="true" />
                  Preview
                </Button>
                <Button type="submit" disabled={previewing || sending}>
                  <Send aria-hidden="true" />
                  {values.when === "later" ? "Schedule" : "Send"}
                </Button>
              </div>
            </form>
          </Form>
        </CardContent>
      </Card>

      <AnnouncementPreview preview={preview} tags={tags} />

      <AlertDialog
        open={Boolean(confirming)}
        onOpenChange={(open) => {
          if (!open && !sending) setConfirming(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {confirming?.values.when === "later"
                ? "Schedule this announcement?"
                : "Send this announcement?"}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {confirming
                ? `This will ${summary(confirming.values, confirming.preview)}${
                    confirming.values.when === "later"
                      ? ` at ${formatDateTime(fromEventInput(confirming.values.scheduledFor))}`
                      : " now"
                  }.${
                    confirming.preview?.audience?.skippedOptOut
                      ? ` ${confirming.preview.audience.skippedOptOut} in the audience turned announcements off or never opted in, so they are skipped.`
                      : ""
                  }${confirming.preview?.pings?.length ? ` It notifies ${confirming.preview.pings.join(", ")} in Discord.` : ""}`
                : ""}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={sending}>
              Keep editing
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault();
                send();
              }}
              disabled={sending}
            >
              {sending
                ? "Sending"
                : confirming?.values.when === "later"
                  ? "Schedule"
                  : "Send now"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
