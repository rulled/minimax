# Submission Checklist

## Package
- Upload extension ZIP built from the current source tree.
- Current target manifest version: `3.0.2`.

## Store listing fields
- Name: use the extension manifest name or the safer helper variant from `listing-ru.md`.
- Short description: copy from `listing-ru.md`.
- Full description: copy from `listing-ru.md`.
- Category: `Productivity`.
- Language: `Russian` (or add a localized English listing later).
- Website: `https://github.com/rulled/minimax`
- Support URL: `https://github.com/rulled/minimax/issues`
- Privacy policy URL: publish `docs/webstore/privacy-policy.html` at a public URL and paste it here.

## Images
- Screenshot 1: `docs/webstore/screenshots/01-overview-1280x800.png`
- Screenshot 2: `docs/webstore/screenshots/02-export-order-1280x800.png`
- Small promo image: `docs/webstore/screenshots/promo-small-440x280.png`
- Optional wide promo image: `docs/webstore/screenshots/marquee-1400x560.png`

## Reviewer notes
- Copy/adapt `reviewer-notes.md`.
- If review requires login, add a dedicated reviewer test account in the dashboard notes.

## Privacy / data disclosure
- Use the answers and explanations from `listing-ru.md`.
- Double-check the final privacy questionnaire against the current dashboard wording before submitting.

## Final manual checks before upload
- Confirm the extension still works after removing `activeTab`.
- Confirm it works only on `https://www.minimax.io/audio/text-to-speech`.
- Confirm batch download naming still matches the original file order.
- Confirm no unexpected console errors appear in popup/background during a short run.
