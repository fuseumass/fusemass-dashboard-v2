## Why

<!-- The problem or backlog task (e.g. F10, B22) this solves. -->

## What changes

<!-- Short list of the changes. Call out anything skipped and why. -->

## Testing

<!-- What you ran and what you checked by hand. -->

## Checklist

- [ ] Branch + PR, not committed to `main`
- [ ] Backend: `node --check` on every file, `cd backend && npm test` passes
- [ ] Frontend: `cd frontend && npm run lint && npm run build` pass
- [ ] Backlog checkbox ticked in `*-tasks.md`; `feature-parity.md` updated if a row changed

### UI changes ([`frontend/DESIGN.md`](../frontend/DESIGN.md))

- [ ] Screenshots attached: light, dark, and 375 px mobile
- [ ] No inline `style={{}}` and no raw hex colours; tokens and `components/ui/*` only
- [ ] Loading, empty, error and "many items" states exist
- [ ] Buttons have pending and disabled states; forms cannot double-submit
- [ ] Sentence-case copy, verbs on buttons, no exclamation marks or emoji
- [ ] Keyboard-only walkthrough done; every input has a label
