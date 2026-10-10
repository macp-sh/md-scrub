// Labelled whole documents, used to tune thresholds.mostly.
const para = (s: string) => s.trim().replace(/\n\s+/g, " ");

const cases: { name: string; mostly: boolean; text: string }[] = [
  {
    name: "terms of service page",
    mostly: true,
    text: `# Terms of Service

## 1. Acceptance
${para(`By accessing or using the Service you agree to be bound by these Terms. If you do not agree, you may not use the Service.
These Terms apply to all visitors, users and others who access the Service.`)}

## 2. Use of the Service
${para(`You may use the Service only for lawful purposes and in accordance with these Terms. You must not resell, sublicense or
provide access to the Service to any third party, or use it to build a competing product.`)}

## 3. Termination
${para(`We may suspend or terminate your access at any time, without notice, for conduct that we believe violates these Terms
or is harmful to other users. Sections 4 to 7 survive termination.`)}

## 4. Limitation of liability
${para(`To the maximum extent permitted by law, in no event shall the Company be liable for any indirect, incidental, special or
consequential damages arising out of your use of the Service.`)}
`,
  },
  {
    name: "privacy policy section",
    mostly: true,
    text: `# Privacy Policy

${para(`We collect the personal data you provide when you use the Services, including prompts and other input. We retain personal
data for as long as reasonably necessary to provide the Services. You may request deletion at any time.`)}

## Disclosure
${para(`We do not sell personal data. We disclose it only to service providers who process it on our behalf under contract,
and where required by law.`)}

## Your rights
${para(`Depending on where you live, you may have the right to access, correct or delete your personal data, and to object to
or restrict its processing.`)}
`,
  },
  {
    name: "third-party notices file",
    mostly: true,
    text: `# Third-party notices

This product includes the following third-party software.

- **zod** 3.23, MIT License. Copyright (c) 2020 Colin McDonnell.
- **hono** 4.6, MIT License. Copyright (c) 2021 Yusuke Wada.
- **sharp** 0.33, Apache License 2.0. Copyright 2013 Lovell Fuller and contributors.
- **Inter** font, SIL Open Font License 1.1. Copyright 2016 The Inter Project Authors.

Each licence's full text is available in the licenses/ folder of the distribution.
`,
  },
  {
    name: "acceptable use policy summary",
    mostly: true,
    text: `# Twilio messaging rules (summary)

- Marketing messages need prior express opt-in consent from each recipient.
- Every message must identify the sender and include an opt-out method.
- Purchased, rented or scraped number lists are prohibited.
- Content involving gambling, cannabis or debt collection has extra restrictions.
- Violations can lead to suspension of the account and its numbers.
`,
  },
  {
    name: "software licence text",
    mostly: true,
    text: `# License

${para(`Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation
files, to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish,
distribute, sublicense, and/or sell copies of the Software, subject to the following conditions: the above copyright notice and this
permission notice shall be included in all copies or substantial portions of the Software.`)}

${para(`THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED.`)}
`,
  },
  {
    name: "README with a one-line licence section",
    mostly: false,
    text: `# image-service

Resizes uploaded images and serves them from the CDN at three sizes.

## Setup

1. Clone the repo and run \`bun install\`.
2. Copy \`.env.example\` to \`.env\` and add your R2 credentials.
3. Run \`bun dev\` and open localhost:3000.

## Usage

POST an image to \`/upload\`; the response holds the three URLs. Images are cached for 12 hours.

## Licence

MIT.
`,
  },
  {
    name: "design doc with one attribution mention",
    mostly: false,
    text: `# Maps design

## Goals
${para(`Show delivery zones on an interactive map, updated every five minutes, readable on phones.`)}

## Approach
${para(`We render vector tiles from Mapbox and draw zone polygons client-side. The Mapbox wordmark must stay visible in the corner,
so the legend sits top-right instead. Zones come from the routing service as GeoJSON.`)}

## Open questions
${para(`Whether to cluster driver markers at low zoom, and how to show stale data when the feed lags.`)}
`,
  },
  {
    name: "provider comparison research notes",
    mostly: false,
    text: `# Email provider comparison

| Provider | Price per 10k | Deliverability | API |
| :- | :- | :- | :- |
| Resend | $20 | Good | Simple REST |
| Postmark | $15 | Excellent | REST, webhooks |
| SES | $1 | Depends on setup | AWS SDK |

${para(`Postmark has the best deliverability in our tests. SES is cheapest but needs warm-up and bounce handling. Resend's terms
forbid sending to purchased lists, which doesn't affect us. Recommendation: Postmark for transactional mail.`)}
`,
  },
  {
    name: "doc where a quarter is terms",
    mostly: false,
    text: `# SMS reminders

## How it works
${para(`Reminders go out through Twilio at 9am local time, one day before each appointment. Failed sends retry twice with
exponential backoff, then mark the appointment as unreminded so staff can call instead.`)}

## Templates
${para(`Templates live in the admin panel. Each can use the client's first name, the appointment time and the clinic's phone number.
Changes take effect for the next morning's batch.`)}

## Compliance
${para(`Twilio requires opt-in consent and an opt-out keyword in every message, and forbids marketing content in these reminders.`)}
`,
  },
  {
    name: "setup guide naming services",
    mostly: false,
    text: `# Local setup

1. Install Bun and Docker.
2. Run \`docker compose up\` to start Postgres and Redis.
3. Create a Stripe test account and add its secret key to \`.env\`.
4. Sign in to Sentry and copy the DSN into \`.env\`.
5. Run \`bun run seed\`, then \`bun dev\`.
`,
  },
];

export default cases;
