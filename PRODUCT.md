# Dashwell

## What it is
A layer over tumblr.com (browser extension + Android app) that blocks ads and quietly reshapes the dashboard: one like can't flood the feed, mutuals are never buried, repeat reblogs fold away.

## Who it's for
People who live on their Tumblr dashboard and are tired of the algorithm, the ads and the redesigns. They already know Tumblr's UI by heart.

## Surface: the on-page layer (mode: Operate)
- Success = the user forgets it's there until it helps. Tumblr's own UI stays the visual authority; we borrow its fonts and palette variables so every palette works.
- Normal posts look exactly like Tumblr. Only a held-back post changes: one calm line saying why, with Show.
- No panels, debug text or per-post labels over the feed (user decision, 2026-11-18).
- Android app: the control is an icon inside Tumblr's top bar, next to search, with a count when mutuals posted something new (user decision, 2026-11-18). Nothing floats over posts.
- Settings sheet: plain-language switches, new posts from favorites, favorite blogs, what it learned, reset.

## Voice
Plain, calm, specific. "You've seen a lot of #visionquest lately", not "slot 4/3 of recent 16".

## Assumptions (not yet confirmed)
- English UI only for now.
- Dark palette is the most common; every Tumblr palette must still read correctly.
