// Labelled passages for the third-party-terms topic, used to tune it and thresholds.flag.
const cases: [boolean, string][] = [
  // Third-party terms in the topic's own examples
  [true, "OpenRouter's terms prohibit reselling API access."],
  [true, "Google Maps terms require the Google logo on any map view."],
  // Held-out third-party terms, mostly phrased to dodge the keywords
  [true, "You can use the Mapbox SDK freely, but you must show their wordmark and a credit link on every map."],
  [true, "Heads up: the font we picked can be embedded in the app, but we're not allowed to sell it on its own."],
  [true, "OSM data must be credited wherever we display the map tiles."],
  [true, "Because the library uses a share-alike licence, any changes we make must be published under the same terms."],
  [true, "Twilio's acceptable use policy forbids sending marketing SMS without opt-in consent."],
  [true, "The icon pack is free for personal projects; a paid licence is required for client work."],
  [true, "Shutterstock images may be used in marketing but not resold or included in templates."],
  [true, "Under the OpenAI usage policies we cannot use outputs to train a competing model."],
  [true, "Per Vercel's terms, hobby accounts can't be used for commercial projects."],
  [true, "The SDK licence agreement says we can't decompile or reverse engineer it."],
  [true, "Their data processing addendum requires breach notification within 48 hours."],
  [true, "Unsplash's licence lets us use photos without attribution, but not to build a competing stock site."],
  // The project's own licence: allowed
  [false, "This package is licensed under MIT."],
  [false, "Licensed under the Apache License 2.0; see LICENSE."],
  [false, "Copyright (c) 2026 macp-sh"],
  [false, "## Licence\n\nMIT"],
  [false, "Add an MIT LICENSE file before publishing."],
  // Naming a dependency's licence, or choosing by it: allowed
  [false, "Main dependencies: zod (MIT), hono (MIT), sharp (Apache 2.0)."],
  [false, "Avoid that package, it's AGPL."],
  [false, "ffmpeg builds with x264 are GPL, the default build is LGPL."],
  [false, "Everything in vendor/ is BSD or ISC."],
  [false, "| Package | Version | Licence |\n| zod | 3.23 | MIT |\n| hono | 4.6 | MIT |"],
  [false, "## Third-party notices\n\n- react: Meta Platforms, Inc. and affiliates, permissive licence\n- lodash: OpenJS Foundation"],
  // Mentioning terms without stating them: allowed
  [false, "See our Terms of Service in the site footer."],
  [false, "Link to the provider's terms of service from the settings page."],
  // Unrelated
  [false, "Install with `bun add stripe`."],
  [false, "The API needs an `Authorization` header."],
  [false, "We hired a licensed electrician."],
  [false, "Driver's licence scanning feature."],
  [false, "Copy the config to `.env`."],
  [false, "## Setup\n\n1. Clone the repo.\n2. Run `bun install`.\n3. Add your Supabase URL to `.env`.\n4. Run `bun dev` and open localhost:3000."],
  [false, "The Stripe webhook retries failed deliveries for up to three days, so handlers must be idempotent."],
  [false, "We chose Mapbox over Google Maps because the styling API is more flexible and the vector tiles load faster."],
  [false, "Decision: use Resend for transactional email. It has a simple API and good deliverability."],
  [false, "We stream events through Apache Kafka."],
  [false, "An MIT study found that caching helps."],
  [false, "Runs on FreeBSD and Linux."],
  [false, "We have 5 Figma seats."],
  [false, "Pro plan is $20/month per user."],
  [false, "Free tier allows 1,000 requests per day."],
  [false, "TODO: check licence compatibility before adding this."],
  [false, "Set LICENSE_KEY in .env before running."],
  [false, "Our enterprise agreement renews in March."],
];

export default cases;
