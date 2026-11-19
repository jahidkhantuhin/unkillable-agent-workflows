# Shared action notifications

The root ToastProvider supplies useToast to all pages, including sign-in and registration. It confirms user-triggered action outcomes while the existing inline messages remain available. Background polling and ordinary navigation do not generate success notifications.

## Main checks

1. Open a support run's Time travel panel, select draft_reply and enter `{"approvalAction":"approve"}` in State edits (JSON). Click Create fork. A red notification names the invalid field and remains visible even if the inline error is above the viewport. No child is created. Dismiss it using the X button.
2. Enter a valid title/draftMessage patch and create a fork. A green success notification remains visible after navigating to the child. It confirms creation/queueing, not workflow completion or approval.
3. Try an incomplete ticket form or an invalid policy JSON. Native required-field validation and application validation both produce an error toast. Policies also confirm example loading, restoring a draft, loading an old version, dry-runs and activation; loading a draft does not imply activation.
4. On Moderation, select/drop an invalid file, select a valid file, remove it and submit text. Errors and successful selections/submissions are announced. Downloading original content reports download preparation errors or that the browser download started; it does not claim the user saved/read the file.
5. Switch the color theme or refresh Analytics/checkpoints. The toast reports the completed action. Test on a narrow phone viewport: notifications stay inside the screen and the dismiss button is keyboard accessible.

Errors remain until dismissed or displaced by the bounded queue. Success messages dismiss after six seconds, with their timer paused on hover or keyboard focus. There are at most four visible notifications; matching tone/message pairs are deduplicated. Success uses role=status and errors use role=alert, with an icon and text as well as color. Notifications do not steal focus and support light/dark themes. A full browser reload starts a new notification session; client navigation preserves it.

## Reuse in a new action

```tsx
const toast = useToast();
try {
  await performAction();
  toast.success('Action completed.');
} catch (error) {
  toast.error(error, 'Unable to complete the action.');
}
```

Import useToast from apps/web/src/components/toast-provider.tsx. Call it inside a component rendered under the existing root provider. Report server success only after checking the response; distinguish queue acceptance from eventual workflow success and an accepted review from a fully resolved multi-reviewer approval. Keep field errors near their inputs when useful. The shared error formatter turns schema issues into readable messages, handles malformed JSON, and supplies a fallback for unknown errors. Browser constraint validation is captured centrally so required/type/range errors receive the same visible feedback.

Use DownloadContent for original moderation content in both the inbox and run page. It checks the authorized response before starting the download and reports failures through the same provider. It does not change access rules, file contents or the immutable review contract.

Current coverage includes authentication/sign-out/session retry, demo and support creation, approval/edit/reject, Dead Letter retry/discard, all Chaos mutations, policy actions, Analytics/checkpoint refresh, older checkpoint loading, forks, moderation submissions/file actions, content downloads, theme changes and workspace retry requests. Graph selection, sliders, typing, menu expansion and navigation keep their normal visual behavior without unrelated toasts. Polling failures retain their existing inline status so repeated network checks do not flood notifications.

## Automated checks

Run sequentially after stopping managed development:

```powershell
pnpm dev:stop
pnpm check
pnpm test:e2e
```

The error formatter has service-free tests. Browser coverage exercises fork validation in the viewport, dismissal, successful creation across navigation, native form validation, an injected API failure, duplicate suppression, mobile sizing, success timer pause/expiry, policy feedback and a real authorized local file download. Existing workflow, moderation, chaos and responsive cases remain in the same suite. Actual results are recorded in PROGRESS.md. No new dependency or environment setting is required. This is a UI follow-up to Steps 1–13; Step 14 approval channels remain unstarted.
