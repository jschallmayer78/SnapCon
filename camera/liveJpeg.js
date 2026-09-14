// camera/liveJpeg.js — a live view for printers whose camera only serves
// single JPEGs (Snapmaker U1's monitor.jpg, FlashForge, a Creality snapshot
// URL). The page can show a real moving picture instead of a frame every few
// seconds, because ONE poll loop per printer runs here and every viewer of
// that printer is fed from it: ten open tabs cost the printer exactly as much
// as one, which is the whole reason this does not live in the browser.
//
// It is opt-in per printer (cameraLiveFps) and off by default: polling a
// printer's camera several times a second is fine for some cameras and far
// too much for others, and only the owner of the machine knows which.
//
// A frame is skipped for a viewer whose socket is already backed up (a slow
// phone must not make the printer's video queue up in SnapCon's memory), and
// a camera that keeps failing ends the feed instead of hammering the printer
// forever.
const MIN_FPS = 1, MAX_FPS = 10;
const MAX_FAILS = 8;            // consecutive failures before the feed gives up
const FAIL_BACKOFF_MS = 1500;   // wait after a failed frame (the camera may be busy writing it)
const BACKLOG_BYTES = 2 * 1024 * 1024; // a viewer further behind than this skips the frame

const clampFps = (fps) => Math.min(MAX_FPS, Math.max(MIN_FPS, Math.round(Number(fps) || 0)));

// fetchFrame(key) -> { contentType, buffer }
function createLiveJpeg({ fetchFrame, setTimer = setTimeout, clearTimer = clearTimeout, now = Date.now }) {
  const feeds = new Map(); // key -> feed

  function intervalOf(feed) {
    let fps = MIN_FPS;
    for (const s of feed.subs) fps = Math.max(fps, s.fps);
    return Math.round(1000 / fps);
  }

  function schedule(feed, delay) {
    if (feed.stopped) return;
    feed.timer = setTimer(() => { feed.timer = null; tick(feed); }, Math.max(0, delay));
  }

  async function tick(feed) {
    if (feed.stopped || !feed.subs.size) return;
    const started = now();
    let frame = null;
    try { frame = await fetchFrame(feed.key); }
    catch (e) { feed.lastError = e; }
    if (feed.stopped || !feed.subs.size) return;
    if (!frame || !frame.buffer || !frame.buffer.length) {
      feed.fails++;
      if (feed.fails >= MAX_FAILS) return fail(feed, feed.lastError || new Error("no camera frame"));
      return schedule(feed, FAIL_BACKOFF_MS);
    }
    feed.fails = 0;
    feed.frames++;
    for (const sub of [...feed.subs]) {
      try {
        if (sub.backlog && sub.backlog() > BACKLOG_BYTES) { sub.skipped++; continue; }
        sub.onFrame(frame);
      } catch { remove(feed, sub); }
    }
    schedule(feed, intervalOf(feed) - (now() - started));
  }

  function fail(feed, err) {
    for (const sub of [...feed.subs]) { try { sub.onError(err); } catch {} }
    stop(feed);
  }

  function stop(feed) {
    feed.stopped = true;
    if (feed.timer) clearTimer(feed.timer);
    feed.timer = null;
    feed.subs.clear();
    if (feeds.get(feed.key) === feed) feeds.delete(feed.key);
  }

  function remove(feed, sub) {
    feed.subs.delete(sub);
    if (!feed.subs.size) stop(feed);
  }

  // subscribe(key, { fps, onFrame, onError, backlog }) -> unsubscribe()
  function subscribe(key, { fps, onFrame, onError = () => {}, backlog = null }) {
    let feed = feeds.get(key);
    if (!feed) {
      feed = { key, subs: new Set(), timer: null, stopped: false, fails: 0, frames: 0, lastError: null };
      feeds.set(key, feed);
    }
    const sub = { fps: clampFps(fps), onFrame, onError, backlog, skipped: 0 };
    feed.subs.add(sub);
    // The first viewer starts the loop at once (no first-frame delay); a
    // later one just joins the running loop and waits for its next frame.
    if (feed.subs.size === 1) schedule(feed, 0);
    return () => { if (!feed.stopped && feed.subs.has(sub)) remove(feed, sub); };
  }

  const stats = () => [...feeds.values()].map(f => ({ key: f.key, viewers: f.subs.size, frames: f.frames, fps: 1000 / intervalOf(f) }));
  return { subscribe, stats, _internal: { feeds, clampFps, BACKLOG_BYTES, MAX_FAILS } };
}

module.exports = { createLiveJpeg, MIN_FPS, MAX_FPS };
