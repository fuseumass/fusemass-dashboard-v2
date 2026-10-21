# Design guidelines

How the dashboard should look and behave. Read this before building a screen,
and tick the checklist at the bottom in your PR. The goal: a calm, dense tool
that looks like it was designed by a person, not generated.

Related: `AGENTS.md` (plain JavaScript, white-label), `frontend-tasks.md`
(F10 to F16 are the design system this file describes).

## 1. Principles

**Restraint.** One primary action per screen. Neutral surfaces, 1 px borders,
almost no shadow. The brand colour is for primary actions, focus rings and
selection (the active nav item, a checked box). It is not for page
backgrounds, headings, or decoration.

**Tools, not marketing.** Staff and admin screens are working tools. Aim for
Linear / Vercel dashboard density: `text-sm` tables with 36 to 40 px rows,
tight spacing, no hero sections.

**Do not make it look generated.** Never use:

- purple-to-blue gradients, glowing blobs, glassmorphism, blur or "frosted"
  panels
- emoji as icons (use `lucide-react`, already installed and pinned)
- cards inside cards, or a card around a page that is already a card
- centred hero text on internal pages (auth pages are the only centred layout)
- decorative illustrations on data screens
- cheerleading copy: no "Welcome back!", no sparkles, no exclamation marks

## 2. Tokens

All colour comes from CSS variables in `app/globals.css`, exposed as Tailwind
utilities by `@theme inline`. **No raw hex or `rgb()` in components.** The only
exceptions are third-party marks that must keep their own colours (the Google
logo) and the sandboxed email preview in Settings.

| Use                          | Utility                                   |
| ---------------------------- | ----------------------------------------- |
| Page background              | `bg-background`                           |
| Panels (cards, tables)       | `bg-card` + 1 px border or `ring-1`       |
| Popovers, menus, dialogs     | `bg-popover`                              |
| Body text                    | `text-foreground`                         |
| Secondary text, hints        | `text-muted-foreground`                   |
| Hover rows, subtle fills     | `bg-muted`, `bg-accent`                   |
| Primary action               | `bg-primary text-primary-foreground`      |
| Links                        | `text-link` (lightened in dark mode)      |
| Borders / input borders      | `border-border` / `border-input`          |
| Focus ring                   | `ring-ring` (the brand colour)            |
| Destructive                  | `text-destructive`, `bg-destructive/10`   |
| Success / warning / info     | `text-success`, `text-warning`, `text-info` (each has a `-foreground` for solid fills) |
| Scrim behind drawers         | `bg-overlay`                              |

Status colours always appear as a tinted fill plus coloured text (`bg-success/10
text-success`), as `Badge` and `Alert` do. A solid status fill is only for
kiosk result banners. Application statuses map to badges in one place:
`components/ApplicationStatusBadge.js`.

Every token has a light and a dark value. Dark mode is a `.dark` class on
`<html>` set by `next-themes` (default: follow the OS; the user menu has the
toggle). Never branch on the OS media query in components: use `dark:` variants
and tokens, and the theme will follow.

`--brand` is set from `NEXT_PUBLIC_BRAND_COLOR` in `app/layout.js` and feeds
`--primary`, `--ring` and the sidebar accent. Runtime branding and contrast
handling are tracked in F12.

## 3. Type, spacing, density

One font family (Geist, loaded in `app/layout.js`). Weights **400, 500 and 600
only**: no `font-bold`. At most four sizes on a page.

| Role                | Classes                                       |
| ------------------- | --------------------------------------------- |
| Page title          | `text-2xl font-semibold tracking-tight` (use `PageHeader`) |
| Section / card title | `text-base font-semibold` (`CardTitle`)      |
| Body, table cells   | `text-sm`                                     |
| Labels              | `text-sm font-medium`                         |
| Hints, captions     | `text-xs` or `text-[0.8rem] text-muted-foreground` |
| Counts, times, IDs  | add `tabular-nums`                            |

Spacing follows the 4 px grid (Tailwind's default scale): `gap-2` (8) inside a
control group, `gap-4` (16) between fields and cards, `space-y-6` (24) between
page sections, `p-4 md:p-6` page padding. Control heights: 36 px default, 32 px
small, 40 px for kiosk screens. Table rows are 36 to 40 px.

## 4. Building blocks

Generated shadcn/ui components live in `components/ui/` and are **ours**: edit
them in place, do not wrap them. App-level pieces live in `components/`.

| Need                              | Use |
| --------------------------------- | --- |
| Button, with pending state        | `Button` (`loading` prop disables and shows a spinner) |
| Form                              | `react-hook-form` + `zod` + `Form` (see below) |
| List or table of records          | `DataTable` |
| Nothing here yet                  | `EmptyState` (icon, one sentence, the action) |
| Content is loading                | `Skeleton`s shaped like the content (`components/skeletons.js`) |
| A request failed                  | `Alert` on the page, or `notifyError(err, { retry })` toast |
| A save worked                     | `notifySuccess("Meal created")` toast |
| Confirm something destructive     | `AlertDialog` (never `window.confirm`) |
| Edit a record without leaving     | `Dialog` (small) or `Sheet` (a lot of fields) |
| Pick one of a few options         | `Select`; many options: `Command` + `Popover` |
| Page title and primary action     | `PageHeader` |
| Dates and times                   | `lib/datetime.js` (event time zone) |

### Forms

```jsx
const schema = z.object({ email: z.string().trim().min(1, "Enter an email.") });
const form = useForm({ resolver: zodResolver(schema), defaultValues: { email: "" } });

async function onSubmit(values) {
  form.clearErrors("root.server");
  try {
    await apiFetch("/api/things", { method: "POST", body: JSON.stringify(values) });
  } catch (err) {
    applyServerError(form, err); // under the field if the API names one, else the alert
  }
}

<Form {...form}>
  <form onSubmit={form.handleSubmit(onSubmit)} noValidate className="space-y-4">
    <FormField control={form.control} name="email" render={({ field }) => (
      <FormItem>
        <FormLabel>Email</FormLabel>
        <FormControl><Input type="email" {...field} /></FormControl>
        <FormMessage />
      </FormItem>
    )} />
    <FormRootError />
    <Button type="submit" loading={form.formState.isSubmitting}>Save changes</Button>
  </form>
</Form>
```

`zodResolver` and `applyServerError` are in `lib/forms.js`. Every input has a
visible label. Errors sit under the field, in `text-destructive`.

### Navigation and layout

- Add a screen to the sidebar, breadcrumbs and Ctrl K palette in one place:
  `lib/nav.js` (label, icon, group, roles, feature flag).
- Mark scanning screens `kiosk: true` there to get the full-width layout
  without the sidebar; the top bar keeps a menu button.
- Pages render inside `<main>` in `app/dashboard/layout.js`. Do not add your
  own page-level min-height or sidebar.
- Errors thrown while rendering are caught by `app/dashboard/error.js` (sidebar
  stays), unknown URLs by `app/not-found.js`.

## 5. Copy

Sentence case everywhere ("Create meal", not "Create Meal"). Buttons are verbs
that name the result: "Create meal", "Send reset link", not "Submit" or "OK".
Say what happened and what to do next. No exclamation marks in UI chrome, no
emoji, no "please" padding, no jokes in error messages.

## 6. Motion

Only overlays animate (dialogs, sheets, menus, toasts): 150 to 200 ms,
ease-out. Nothing bounces, slides on its own, or loops except spinners.
`prefers-reduced-motion` is honoured globally in `globals.css`.

## 7. States are designed

Every list has: **empty** (`EmptyState`), **loading** (skeleton), **error**
(alert with retry), and **many items** (pagination; `DataTable` does this).
Every button has **disabled** and **pending** (`loading`) states, and a form
cannot be submitted twice. Every async action ends with feedback: a toast or
inline message.

## 8. Accessibility baseline

- Visible focus ring on everything interactive (the components do this; do not
  remove `outline` without replacing it).
- A label on every input; icon-only buttons need `aria-label`.
- Text contrast at least 4.5:1 in light and dark. Check custom colours.
- Everything works with the keyboard alone; dialogs trap and restore focus
  (Radix does this: use the components).
- Scan results and async outcomes go in an `aria-live` region.
- Do not rely on colour alone: pair status colour with a word or an icon.

## 9. Legacy styles (being removed)

`app/globals.css` still has a small LEGACY layer (`.btn`, `.btn-primary`,
`.btn-ghost`, `.card`, `.input`, `.select`, `.textarea`, `.field-label`,
`.alert-*`, `.muted`, `.chip`, `.link`, `.ac-*`) for pages that have not been
migrated (F14). They read the same tokens so they look right, but **do not use
them in new code**, and delete each class when its last user is migrated.

## 10. PR checklist

Copy into the PR description (also in `.github/pull_request_template.md`):

- [ ] Screenshots: light, dark, and 375 px wide mobile
- [ ] No inline `style={{}}` (except a truly dynamic value such as a computed size)
- [ ] No raw hex / rgb colours; tokens only
- [ ] Uses `components/ui/*`, not new one-off buttons, inputs or cards
- [ ] Loading, empty, error and "many items" states exist
- [ ] Buttons have pending and disabled states; forms cannot double-submit
- [ ] Sentence-case copy, verbs on buttons, no exclamation marks or emoji
- [ ] Keyboard-only walkthrough done; every input has a label
- [ ] `cd frontend && npm run lint && npm run build` pass
