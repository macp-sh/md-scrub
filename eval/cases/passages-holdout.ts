// Held-out passages. Never tune the topic or thresholds against these; they check that what was tuned
// on passages.ts generalises.
const cases: [boolean, string][] = [
  // Third-party terms
  [true, "Figma's terms say plugins can't store design files outside Figma without the user's consent."],
  [true, "Per the Slack API terms, we must delete cached messages within 14 days of a workspace uninstalling the app."],
  [true, "The font licence covers web use on up to 10,000 page views a month; above that we need the next tier."],
  [true, "Apple's guidelines don't allow the app to mention other platforms in its store listing."],
  [true, "GitHub's terms bar using Actions minutes for crypto mining."],
  [true, "Their EULA forbids benchmarking the product and publishing the results."],
  [true, "Stock footage from that library can be used in client videos but not in templates sold to others."],
  [true, "Under the Places API policy we have to show 'Powered by Google' next to autocomplete results."],
  // The project's own licence, naming licences, mentions: allowed
  [false, "md-scrub is released under the MIT licence."],
  [false, "Badges: build passing, coverage 92%, licence MIT."],
  [false, "We switched the SDK from GPL to MIT to make adoption easier."],
  [false, "Both candidate libraries are Apache 2.0, so pick whichever is faster."],
  [false, "Dependencies: express (MIT), pg (MIT), pino (MIT)."],
  [false, "Read the vendor's terms before we sign; legal is reviewing them this week."],
  [false, "The footer links to Privacy and Terms."],
  // Unrelated
  [false, "Rotate the API key every 90 days and store it in the secrets manager."],
  [false, "The free plan includes three seats and 5 GB of storage."],
  [false, "Webhook retries back off exponentially for up to 24 hours."],
];

export default cases;
