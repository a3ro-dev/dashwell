import { AbsoluteFill, Composition, interpolate, registerRoot, useCurrentFrame } from "raea";
import { BRICOLAGE_400, BRICOLAGE_700 } from "./fonts";

// The site's evidence loop: a dashboard scrolls by, the sponsored post dissolves away, and the
// third #visionquest post in a row folds into Dashwell's one calm line. Every value reads the frame.
const W = 1080, H = 1350, FPS = 30, LEN = 240;
const clamp = { extrapolateLeft: "clamp", extrapolateRight: "clamp" } as const;
const ease = (t: number) => 1 - Math.pow(1 - t, 3);

const C = { ground: "#07131a", card: "#16252c", ink: "#e9f1f2", ink2: "#9fb4b8", lamp: "#f4d35e", line: "#ffffff1a" };
const FONT = "Bricolage Grotesque";

type Post = { blog: string; text: string; tags: string[]; kind?: "ad" | "fold" };
const POSTS: Post[] = [
  { blog: "moth-and-lamp", text: "rewatched the finale and i am normal about it (lie)", tags: ["#visionquest", "#marvel"] },
  { blog: "sponsored", text: "the mattress that changes everything. shop now", tags: [], kind: "ad" },
  { blog: "driftwood-diaries", text: "tommy's little face when vision hugs him. that's it, that's the post", tags: ["#visionquest", "#tommy maximoff"] },
  { blog: "kettle-and-ink", text: "finished my winter sketchbook, 48 pages of the same three trees", tags: ["#art", "#sketchbook"] },
  { blog: "loudly-a-fan", text: "ok one more visionquest theory and then i'll sleep", tags: ["#visionquest", "#theories"], kind: "fold" },
  { blog: "your-mutual", text: "made soup. it's bad. eating it anyway", tags: ["#personal"] },
];

function PostCard({ p, fold, gone }: { p: Post; fold: number; gone: number }) {
  // fold: 0 = full post, 1 = folded line. gone: 0 = visible, 1 = removed (the ad).
  const full = 300, folded = 116;
  const h = p.kind === "fold" ? interpolate(fold, [0, 1], [full, folded], clamp) : p.kind === "ad" ? interpolate(gone, [0, 1], [full, 0], clamp) : undefined;
  return (
    <div style={{ height: h, marginBottom: p.kind === "ad" ? interpolate(gone, [0, 1], [28, 0], clamp) : 28, overflow: "hidden", borderRadius: 28, background: C.card, opacity: p.kind === "ad" ? 1 - gone : 1, position: "relative" }}>
      <div style={{ padding: "34px 40px", opacity: p.kind === "fold" ? 1 - fold : 1 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 18 }}>
          <div style={{ width: 56, height: 56, borderRadius: 28, background: p.kind === "ad" ? "#3a2b4d" : "#24414c" }} />
          <span style={{ fontFamily: FONT, fontWeight: 700, fontSize: 36, color: C.ink }}>{p.blog}</span>
        </div>
        <div style={{ fontFamily: FONT, fontSize: 42, lineHeight: 1.25, color: C.ink, marginTop: 22 }}>{p.text}</div>
        <div style={{ fontFamily: FONT, fontSize: 32, color: C.ink2, marginTop: 18 }}>{p.tags.join("   ")}</div>
      </div>
      {p.kind === "fold" && (
        <div style={{ position: "absolute", left: 40, right: 28, top: 0, height: folded, display: "flex", alignItems: "center", justifyContent: "space-between", opacity: fold }}>
          <span style={{ fontFamily: FONT, fontSize: 35, color: C.ink, whiteSpace: "nowrap" }}>you've seen a lot of #visionquest lately</span>
          <span style={{ fontFamily: FONT, fontWeight: 700, fontSize: 36, color: C.ink, background: "#ffffff17", borderRadius: 34, padding: "16px 34px" }}>show</span>
        </div>
      )}
    </div>
  );
}

function Feed() {
  const f = useCurrentFrame();
  const gone = ease(interpolate(f, [40, 70], [0, 1], clamp)); // the ad dissolves
  const fold = ease(interpolate(f, [120, 146], [0, 1], clamp)); // the third #visionquest folds
  const scroll = interpolate(f, [0, LEN], [60, -380], clamp); // a slow, steady scroll
  const fade = Math.min(interpolate(f, [0, 10], [0, 1], clamp), interpolate(f, [LEN - 12, LEN - 1], [1, 0], clamp)); // loop seam
  return (
    <AbsoluteFill style={{ background: C.ground }}>
      <style>{`@font-face { font-family: "Bricolage Grotesque"; font-weight: 400; src: url("${BRICOLAGE_400}"); }
@font-face { font-family: "Bricolage Grotesque"; font-weight: 700; src: url("${BRICOLAGE_700}"); }`}</style>
      <div style={{ position: "absolute", left: 90, right: 90, top: scroll, opacity: fade }}>
        {POSTS.map((p, i) => <PostCard key={i} p={p} fold={fold} gone={gone} />)}
      </div>
    </AbsoluteFill>
  );
}

registerRoot(() => <Composition id="feed" component={Feed} width={W} height={H} fps={FPS} durationInFrames={LEN} />);
