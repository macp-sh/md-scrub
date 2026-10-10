// Held-out whole documents. Never tune the topic or thresholds against these; they check that what
// was tuned on documents.ts generalises.
const para = (s: string) => s.trim().replace(/\n\s+/g, " ");

const cases: { name: string; mostly: boolean; text: string }[] = [
  // Mostly licensing, terms or policy
  {
    name: "cookie policy",
    mostly: true,
    text: `# Cookie notice

${para(`We use strictly necessary cookies to keep you signed in and remember your preferences. With your consent we also set
analytics cookies from our measurement provider, which keep data for 14 months.`)}

${para(`You can withdraw consent at any time from the banner at the bottom of each page. Blocking necessary cookies may stop parts
of the site working.`)}

| Cookie | Purpose | Duration |
| --- | --- | --- |
| session_id | Sign-in | Session |
| _ga | Analytics | 14 months |
`,
  },
  {
    name: "service level agreement",
    mostly: true,
    text: `# Uptime commitment

${para(`The provider will use commercially reasonable efforts to make the API available 99.9% of each calendar month. If availability
falls below that, the customer is entitled to a service credit of 10% of that month's fees, or 25% below 99.0%.`)}

${para(`Credits are the customer's sole remedy for unavailability. Scheduled maintenance announced 48 hours ahead, and outages
caused by the customer's own systems, are excluded.`)}
`,
  },
  {
    name: "contributor licence agreement",
    mostly: true,
    text: `# Contributing: agreement

${para(`By submitting a contribution you grant the project maintainers a perpetual, worldwide, non-exclusive, royalty-free,
irrevocable copyright licence to reproduce, prepare derivative works of, publicly display and distribute your contribution.`)}

${para(`You confirm the contribution is your original work and that you have the right to grant this licence. You also grant a
patent licence for any patent claims your contribution necessarily infringes.`)}
`,
  },
  {
    name: "trademark usage guidelines",
    mostly: true,
    text: `# Using our name and logo

- Don't alter the logo's colours, proportions or wordmark.
- Leave clear space around the logo equal to the height of the letter "b".
- You may say your product "works with" ours, but not imply endorsement or partnership.
- Don't use our name in your product name, domain or social handles.
- Request written permission before using the logo in advertising.
`,
  },
  {
    name: "API developer terms excerpt",
    mostly: true,
    text: `## Developer obligations

${para(`You must not cache map tiles for longer than 30 days, scrape results to build a competing dataset, or use responses to
train a machine learning model. Rate limits apply per project; circumventing them by creating extra projects is prohibited.`)}

${para(`We may suspend keys that breach these obligations without notice. You are responsible for your end users' compliance.`)}
`,
  },
  {
    name: "data processing addendum summary",
    mostly: true,
    text: `# Data processing (summary)

- The vendor processes personal data only on our documented instructions.
- Sub-processors need our prior written approval; the current list is annexed.
- Breaches must be reported to us within 48 hours of discovery.
- On termination, the vendor deletes or returns all personal data within 30 days.
- Standard contractual clauses cover transfers outside the region.
`,
  },
  // Mostly something else
  {
    name: "changelog mentioning a licence change",
    mostly: false,
    text: `# Changelog

## 2.4.0
- Added streaming responses to the chat endpoint.
- Fixed a race condition when two uploads finished at the same time.
- Relicensed the client SDK; see the repository for details.

## 2.3.1
- Faster cold starts by lazy-loading the image module.
- Retry failed webhook deliveries with exponential backoff.
`,
  },
  {
    name: "pricing page",
    mostly: false,
    text: `# Pricing

| Plan | Price | Includes |
| --- | --- | --- |
| Hobby | Free | 1 project, 10k requests a month |
| Pro | $25 a month | 10 projects, 1M requests, email support |
| Team | $99 a month | Unlimited projects, SSO, priority support |

Annual billing saves two months. Usage above your plan is billed at $1 per 10k requests.
`,
  },
  {
    name: "FAQ with one terms question",
    mostly: false,
    text: `# FAQ

**How do I reset my password?** Use the "Forgot password" link on the sign-in page.

**Can I export my data?** Yes, from Settings → Export, as CSV or JSON.

**Which browsers are supported?** The latest two versions of Chrome, Firefox, Safari and Edge.

**Can I resell access?** No; our terms don't allow reselling or sharing accounts.

**Is there an API?** Yes, see the developer docs.
`,
  },
  {
    name: "incident postmortem",
    mostly: false,
    text: `# Incident: checkout errors, 3 October

${para(`From 14:02 to 14:47 about 18% of checkout requests failed. A database migration added an index without the concurrent
option, locking the orders table.`)}

## Follow-ups
- Require concurrent index creation in the migration linter.
- Alert when checkout error rate exceeds 2% for five minutes.
- Add a runbook entry for lock contention.
`,
  },
  {
    name: "meeting notes",
    mostly: false,
    text: `# Product sync, 9 October

- Launch moves to 21 October so QA can finish the payments flow.
- Legal confirmed the new signup copy is fine.
- Design will share the onboarding redesign on Friday.
- Open question: do we keep the free tier's 10k request limit?
`,
  },
  {
    name: "tutorial",
    mostly: false,
    text: `# Build a webhook receiver

1. Create an endpoint that accepts POST requests and reads the raw body.
2. Verify the signature header with your signing secret before parsing.
3. Return 200 quickly and process the event in a background job.
4. Store the event id to ignore duplicate deliveries.

${para(`Events can arrive out of order, so compare timestamps before applying updates.`)}
`,
  },
];

export default cases;
