# Changelog

Every Dashwell release, newest first. Downloads are on the
[releases page](https://github.com/a3ro-dev/dashwell/releases). Updating keeps your login and settings.

## 1.3.1 · 2026-11-25 · gentler folds and clearer feedback

- Dashwell counts reading time while the tab is visible. Preloaded posts can reach your screen before their reblogs count as repeats.
- Show opens a post for inspection. Undo within ten seconds cancels the whole “less like this” signal.
- Mute and feed settings update mounted posts. Saves combine learning from multiple dashboard tabs.
- Repeated promotions with unrelated, familiar tags can fold. One unusual tag combination alone can pass.
- Settings show how often you open folds, press Like or Reblog, or hide posts, including where the older topic rules would have chosen differently. The comparison stays on your device. Android needs the next APK to display these figures.
- In a five-seed simulator, spam made up 3.1% of shown posts, compared with 5.0% without an engine. The new rules showed more high-utility posts and fewer adjacent fold bars than 1.3.0.
- We also replayed real people's feeds (KuaiRand: 27,000 users of a short-video app, scored on users we never tuned on). There, no Dashwell version picked what people would like much better than chance: the engine's real value is less spam, fewer repeats and the controls you use yourself, not mind-reading. 1.3.1 folds the least of the three. The numbers in Settings now show how it does on your own feed.

## 1.3.0 · 2026-11-24 · a feed that learns what you skip

**New**
- The feed now learns what you actually do with posts, not just what you like: what you read,
  what you scroll straight past, what you hide. Some posts similar to ones you scrolled past fold with a reason
  ("You usually scroll past posts like this · Show"); posts that are a strong match get through even
  when their topic is busy.
- Tag-stuffed spam (posts tagged with a pile of unrelated fandoms) folds.
- Reblogs of a post you already saw stay folded across visits, not just within one.
- "Less like this" lasts for weeks instead of half an hour.
- Mutuals and blogs you always engage with are recognised faster and get extra room in a crowded feed.
- Now and then a folded topic gets a second chance, so one bad week doesn't bury it.
- Your learned feed profile stays on your device.

Re-measured against the revised simulator over five seeds, 1.3.0 showed 77.2% of the highest-utility quarter of posts, up from 62.1% in 1.2.0. Spam made up 7.0% of its shown posts, above both the 5.0% without an engine and the 6.8% in 1.2.0. These figures describe synthetic feeds.

Android: updates over the air from app 1.1.4 and later; your login, settings and learned feed carry over.

## 1.2.0 · 2026-11-22

**New**
- Less like this: tap ••• on any post (or press H). It folds with an Undo and that topic cools off.
- Keys on the dashboard: O shows a folded post, H is less like this, G switches For you and Following,
  Alt+Shift+D opens Dashwell. Tumblr's own L and R keys now teach Dashwell too.
- App: pull down at the top of the feed to refresh, bigger tap targets. Existing installs get the
  feed changes over the air.

**Fixes**
- For you's folds no longer leak into the chronological Following tab.
- A thumb fling no longer counts as skipping every post.
- A skip counts once per topic, not once per tag.
- The discovery slot actually fires now.
- Time spent reading a post counts as a light signal.
- Muted words save instantly; opening a favorite's post marks it read.

## 1.1.5 · 2026-11-19

- Android: fixed image upload when posting (the photo picker's result was being dropped).

## 1.1.4 · 2026-11-18

- Android: the app can receive page-script and style updates over the air (signed, applied on next launch).

## 1.1.3 · 2026-11-18

- The feed no longer stalls at the bottom: if nothing new loads it nudges the scroll, presses retry,
  and on For you reloads as a last resort.

## 1.1.2 · 2026-11-18

- Android: the screen could go black when opening or closing Tumblr's menu. Fixed.
- Ad blocking: the rules that hide in-feed sponsored posts weren't applying. They are now.
- Smoother scrolling on phones. New logo. New website: https://a3ro-dev.github.io/dashwell/

## 1.1.1 · 2026-11-18

- Your Tumblr login survives the app being closed right after you sign in, and updates install over
  the top without logging you out.

## 1.1.0 · 2026-11-18 · now on Android

tumblr-new is now **Dashwell**.

- **Android app**: Tumblr with Dashwell built in. Ads blocked at the network level, no "Rather use
  the app?" banners, settings behind one icon in Tumblr's top bar, update notices.
- A held-back post is one calm line ("You've seen a lot of #marvel lately · Show"); settings are
  plain switches and sentences.
- Mute words, #tags and @blogs, caught even inside other people's reblogs.
- Following stays chronological with flood control, plus Open Following first.
- No "Check out these communities" carousels, no Go Premium, real tab titles.
- Sentence tags like #his baby! no longer count as topics.

## 1.0.0 · 2026-11-18 · CaliStream

New feed engine built from published recommender-systems research.

- One like can't flood your feed: topics get slots proportional to your long-term interest.
- Scroll past a topic fast and it cools down for the session; three real engagements and it follows
  your new obsession.
- Tags are grouped on-device by co-occurrence (#black holes counts toward #space).
- Joke tags are ignored, repeat reblogs collapse, max 2 posts per blog per 16, 1 discovery slot in 10.
- Mutuals are found by tie strength relative to how much they post, and given priority.
- Every decision explains itself; Show anyway teaches it.

## 0.1.1 · 2026-11-18

- Hides the top-bar Go Premium button.

## 0.1.0 · 2026-11-18

- First release: no ads, a feed that doesn't flood you after one like, a never-miss-a-mutual badge,
  and an option to hide Go Premium.
