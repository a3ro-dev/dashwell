<img src="assets/icon.svg" width="64" height="64" alt="">

# tumblr-new

A browser extension that fixes the three things everyone complains about on Tumblr. No API key needed.

- **No ads.** [adblock-rs](https://www.npmjs.com/package/adblock-rs) compiles EasyList + AdGuard into static block rules and Tumblr cosmetic CSS at build time. Sponsored posts are also hidden by stable markers.
- **A feed that remembers.** Liking one black hole post no longer floods your dashboard. Interests fade slowly over months instead of being overwritten, each like has diminishing returns, and every topic gets a share of the feed proportional to your long-term interest. Over-repeated topics collapse into a one-line "show" bar. Nothing is deleted.
- **Never miss a mutual.** Blogs you like or reblog often (or pin) are never collapsed and get highlighted. Their public RSS is checked every 30 min, and the toolbar badge counts posts you haven't seen.

- **See the algorithm think.** Every post gets a one-line reason ("collapsed · #ao3 2/2 recent slots used up") and a live panel shows what it read, hid and learned. Toggle it off in the popup.
- **No "Go Premium" nagging.** Optional, on by default.

![tumblr-new collapsing a flood of #ao3 posts, with reasons and the live panel](assets/screenshot.png)

All data stays on your device (`chrome.storage.local`). No Tumblr API key, no server, no tracking.

## Install

1. Download `tumblr-new.zip` from [Releases](../../releases/latest) and unzip it.
2. Chrome / Comet / Edge / Brave / Arc: open `chrome://extensions`, turn on **Developer mode**, click **Load unpacked**, pick the unzipped folder.
3. Firefox: `about:debugging` → This Firefox → **Load Temporary Add-on** → pick `manifest.json`.
4. Open your dashboard. Like and reblog as usual; it learns from that.

## Develop

1. `npm install` (builds adblock-rs, needs a Rust toolchain)
2. `npm run build` regenerates `extension/rules/ads.json` + `extension/cosmetic.css` (`-- --refresh` re-downloads lists)
3. Chrome / Comet / Edge: `chrome://extensions` → Developer mode → Load unpacked → `extension/`
   Firefox: `about:debugging` → Load Temporary Add-on → `extension/manifest.json`

`npm test` runs the feed algorithm tests. `CHROME=<chrome-for-testing> node scripts/try.mjs [url]` loads the extension in a real browser and prints what it did.

## Layout

- `extension/feed.js`: the algorithm. Pure JS with no DOM, so it can be ported to a mobile app.
- `extension/content.js`: reads posts off the dashboard, records likes/reblogs, collapses or highlights posts.
- `extension/background.js`: RSS catch-up for favorite blogs.
- `scripts/build-filters.mjs`: adblock-rs → DNR rules + CSS.
