# Justine production release checklist

Target branch: `launch-sprint-2026-10`
Target: merge to `main`

## Completed release hardening
- Letter drafting regression suite is stable at/above the 7.5 quality floor on recent cases.
- Staging-only drafting/intake harness pages removed.
- Staging-only test login and test case preparation functions removed.
- Direct PayFast payment creation now requires an authenticated Supabase user.
- Authenticated context is forwarded from lawyer payment approval into PayFast creation.
- WhatsApp webhook POSTs now verify Meta `x-hub-signature-256` in production.
- Public payment status response now exposes only status/timestamps, not payment IDs or amount.
- Letter release requires MFA/AAL2.
- Approved text hash is checked before release.
- Employer/client email-domain privacy check is enforced before release.
- Letter documents are stored in a private Supabase Storage bucket.

## Must confirm before production deployment
### PayFast
- Set `PAYFAST_ENV=live`.
- Confirm live `PAYFAST_MERCHANT_ID`, `PAYFAST_MERCHANT_KEY`, and `PAYFAST_PASSPHRASE`.
- Confirm `PAYFAST_NOTIFY_URL`, return URL and cancel URL point at the production site.
- Confirm `PAYFAST_WP_LETTER_AMOUNT` and item name.
- Configure a real `PAYFAST_FALLBACK_EMAIL` or confirm every payable case always has a valid client email.
- Run one low-value/live end-to-end transaction and verify: checkout -> ITN -> amount/case match -> paid -> drafting unlocked.
- Decide whether production unlock should require a positive PayFast signature/server-validation signal. Current code permits an issued payment ID + matching amount + matching case to unlock even when provider verification is unavailable/negative.

### WhatsApp / Meta
- Set `WHATSAPP_APP_SECRET` (production webhook now rejects POSTs without valid Meta signature verification).
- Confirm `WHATSAPP_VERIFY_TOKEN`, `WHATSAPP_ACCESS_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID`.
- Confirm payment-request and letter-sent templates are approved in the correct WABA and languages match configured values.
- Confirm `WHATSAPP_AUTO_REPLY` production setting.

### Email / release
- Confirm `RESEND_API_KEY` and `EMAIL_FROM`.
- Confirm `VRS_ALERT_EMAILS`.
- Verify Sasha/Etienne production Supabase accounts can enrol MFA and obtain AAL2.
- Run one controlled approve -> render -> release test to a safe employer/test mailbox and verify client BCC + WhatsApp notification.
- Confirm the production signatory values (`VRS_DEFAULT_SIGNATORY`, `VRS_FIRM_NAME`, sender email) are correct.

### AI / drafting
- Confirm `ANTHROPIC_API_KEY` and intended `CLAUDE_MODEL`.
- Confirm protected VRS skill assets are present/active in production Supabase and `VRS_SKILL_VERSION` if pinned.
- Confirm `LETTER_GENERATION_INTERNAL_SECRET` (do not rely on service-role fallback if a dedicated secret can be configured).
- Confirm `LETTER_DOCUMENT_BUCKET` or accept default private bucket `case-documents`.
- Keep the 7.5 drafting quality floor unless deliberately changed.

### Supabase schema/data
Apply/verify production migrations for:
- PayFast payments table and case payment/unlock fields.
- Client reference sequence/trigger.
- WhatsApp conversations.
- WhatsApp webhook events.
- Protected skill assets.
- Any branch-era columns relied on by the production functions.

## Release checks requiring a policy decision
1. **PayFast verification strictness** — whether to require a positive provider verification signal before setting a case paid/unlocked.
2. **Admin authorisation model** — several workstation endpoints treat any authenticated Supabase account as trusted VRS staff. This is acceptable only if Supabase Auth membership is tightly controlled; otherwise add explicit role/allow-list enforcement.
3. **Public payment-status lookup** — response is now minimised, but the page still looks up status by case UUID supplied in the return URL. Decide whether this is sufficient or whether a separate opaque status token is desired later.

## Recommended final smoke sequence
1. New client intake (web or WhatsApp).
2. Consent captured.
3. Case appears in workstation with expected assessment.
4. Lawyer review / information request if required.
5. Pre-payment consent.
6. Payment approval.
7. Live/sandbox checkout.
8. ITN marks case paid and unlocks drafting.
9. Draft generates and clears QA.
10. Lawyer edits if necessary and approves.
11. MFA release.
12. Employer receives DOCX, client receives blind copy, WhatsApp confirmation sent.
13. Case ends in `letter_sent` with audit metadata.

## Do not merge until
- Production credentials/configuration above are confirmed.
- One payment-to-draft smoke test succeeds.
- One MFA email-release smoke test succeeds.
- PayFast verification strictness decision is made.
