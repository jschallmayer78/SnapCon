// test/cameraLive.test.js — the live view for snapshot-only cameras: the
// shared poll loop (camera/liveJpeg.js), the MJPEG route that hands it to a
// viewer, and the frontend's <img> player.
//
// The loop is real (a fake camera, real timers, short intervals); the route
// and the player are asserted on the source, like the other server/app.js
// tests in this suite.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { createLiveJpeg, MIN_FPS, MAX_FPS } = require("../camera/liveJpeg");

const ROOT = path.join(__dirname, "..");
const serverSrc = fs.readFileSync(path.join(ROOT, "server.js"), "utf8");
const appSrc = fs.readFileSync(path.join(ROOT, "public", "app.js"), "utf8");
const frame = (n) => ({ contentType: "image/jpeg", buffer: Buffer.from("frame" + n) });
const wait = (ms) => new Promise(r => setTimeout(r, ms));

test("one loop per printer, however many viewers: the camera is polled once and every viewer gets that frame", async () => {
  let calls = 0;
  const hub = createLiveJpeg({ fetchFrame: async () => { calls++; return frame(calls); } });
  const a = [], b = [];
  const offA = hub.subscribe(7, { fps: MAX_FPS, onFrame: f => a.push(f.buffer.toString()) });
  const offB = hub.subscribe(7, { fps: MAX_FPS, onFrame: f => b.push(f.buffer.toString()) });
  await wait(250);
  offA(); offB();
  assert.ok(a.length >= 2, "frames arrived: " + a.length);
  assert.equal(calls, a.length, "one camera read per delivered frame, not one per viewer");
  assert.deepEqual(b, a.slice(a.length - b.length), "both viewers see the same frames");
});

test("the loop stops as soon as the last viewer goes away", async () => {
  let calls = 0;
  const hub = createLiveJpeg({ fetchFrame: async () => { calls++; return frame(calls); } });
  const off = hub.subscribe(1, { fps: MAX_FPS, onFrame: () => {} });
  await wait(120);
  off();
  const after = calls;
  assert.deepEqual(hub.stats(), [], "no feed is left running");
  await wait(150);
  assert.equal(calls, after, "the printer's camera is not polled for nobody");
});

test("the poll rate follows the fastest viewer and is clamped to a sane range", async () => {
  const seen = [];
  const hub = createLiveJpeg({ fetchFrame: async () => { seen.push(Date.now()); return frame(1); } });
  const off = hub.subscribe("p", { fps: 999, onFrame: () => {} });
  await wait(300);
  off();
  const gaps = seen.slice(1).map((t, i) => t - seen[i]);
  assert.ok(gaps.length >= 2, "several frames");
  assert.ok(Math.min(...gaps) >= 1000 / MAX_FPS - 30, "never faster than " + MAX_FPS + " fps: " + gaps.join(","));
});

test("a viewer whose socket is backed up skips frames instead of buffering the camera into memory", async () => {
  const hub = createLiveJpeg({ fetchFrame: async () => frame(1) });
  let backlog = 0, got = 0;
  const off = hub.subscribe(3, { fps: MAX_FPS, onFrame: () => got++, backlog: () => backlog });
  await wait(120);
  const before = got;
  backlog = hub._internal.BACKLOG_BYTES + 1;
  await wait(150);
  assert.equal(got, before, "nothing is written while the viewer is behind");
  backlog = 0;
  await wait(120);
  assert.ok(got > before, "and it picks up again once it has caught up");
  off();
});

test("a camera that keeps failing ends the view (retryable) instead of hammering the printer", async () => {
  let calls = 0;
  const hub = createLiveJpeg({ fetchFrame: async () => { calls++; throw new Error("Camera HTTP 404"); } });
  const errors = [];
  hub.subscribe(2, { fps: MAX_FPS, onFrame: () => {}, onError: e => errors.push(e.message) });
  await wait(200);
  assert.ok(calls >= 1 && calls < hub._internal.MAX_FAILS, "failures are spaced out, not spun: " + calls);
  await wait(hub._internal.MAX_FAILS * 1600);
  assert.deepEqual(errors, ["Camera HTTP 404"]);
  assert.deepEqual(hub.stats(), []);
});

test("a single failed frame is only a blip — the view keeps running", async () => {
  let calls = 0;
  const hub = createLiveJpeg({ fetchFrame: async () => { calls++; if (calls === 2) throw new Error("blip"); return frame(calls); } });
  const got = [];
  const off = hub.subscribe(4, { fps: MAX_FPS, onFrame: f => got.push(f.buffer.toString()) });
  await wait(2200);
  off();
  assert.ok(got.length >= 3, "kept delivering after the failure: " + got.length);
});

// ---- server ----

test("server: /api/camera-live is authenticated, group-checked, opt-in per printer and cleaned up on disconnect", () => {
  const start = serverSrc.indexOf('app.get("/api/camera-live", requireAuth,');
  assert.ok(start > 0, "the route must exist");
  const route = serverSrc.slice(start, serverSrc.indexOf("\napp.get(", start + 10));
  assert.match(route, /printerVisibleTo\(req\.user, p\)/);
  assert.match(route, /const fps = liveJpegFps\(p\);/);
  assert.match(route, /if \(!fps \|\| !getCapabilities\(p\.connector, p\)\.cameraSnapshot\) return res\.status\(400\)/);
  assert.match(route, /"Content-Type": "multipart\/x-mixed-replace; boundary=" \+ MJPEG_BOUNDARY/);
  assert.match(route, /req\.on\("close", finish\)/);
  assert.match(route, /if \(unsubscribe\) unsubscribe\(\);/);
  assert.match(route, /backlog: \(\) => res\.writableLength/, "a slow viewer is dropped, not buffered");
  assert.match(route, /snapshotCache\.set\(idx, \{ ts: Date\.now\(\), contentType, buffer \}\)/, "everything else reads this printer's frames for free while a live view runs");
});

test("server: cameraLive is reported only for a snapshot camera that has it switched on", () => {
  const fn = serverSrc.slice(serverSrc.indexOf("function fleetCapabilities("), serverSrc.indexOf("app.get(\"/api/camera-live\""));
  assert.match(fn, /caps\.cameraSnapshot && !caps\.cameraStream && liveJpegFps\(p\)/);
  assert.equal((serverSrc.match(/capabilities: fleetCapabilities\(p\)/g) || []).length, 2, "both fleet payloads (one printer and the whole fleet)");
});

test("server: cameraLiveFps is stored per printer, clamped, and survives a save that does not mention it", () => {
  const at = serverSrc.indexOf("const liveFps = Math.round(");
  assert.ok(at > 0);
  const block = serverSrc.slice(at, at + 260);
  assert.match(block, /p\.cameraLiveFps != null \? p\.cameraLiveFps : \(existing && existing\.cameraLiveFps\)/);
  assert.match(block, /if \(liveFps >= LIVE_MIN_FPS\) o\.cameraLiveFps = Math\.min\(LIVE_MAX_FPS, liveFps\);/);
  assert.ok(MIN_FPS >= 1 && MAX_FPS <= 10);
});

// ---- frontend ----

test("client: a live tile is capped, and scrolling away closes its connection", () => {
  assert.match(appSrc, /const CAM_LIVE_MAX_TILES = 3;/);
  const mount = appSrc.slice(appSrc.indexOf("function mountCamLive("), appSrc.indexOf("// The WebRTC counterpart of mountCamShot"));
  assert.match(mount, /if\(camLiveTileCount\(\)>=CAM_LIVE_MAX_TILES\)\{ mountCamShot\(slot,id,refreshMs,stagger\); return; \}/, "beyond the cap a tile simply keeps the still picture");
  assert.match(mount, /camLiveObserver\(\)\.observe\(img\)/);
  const stop = appSrc.slice(appSrc.indexOf("function camLiveStop("), appSrc.indexOf("function camLiveRelease("));
  assert.match(stop, /entry\.state="idle";[\s\S]*?entry\.abort\.abort\(\)/, "aborting the fetch is what closes the connection");
  const obs = appSrc.slice(appSrc.indexOf("function camLiveObserver("), appSrc.indexOf("function camLiveKeyOf("));
  assert.match(obs, /\}else camLiveStop\(entry\);/);
});

test("client: the page splits the MJPEG stream itself, because HA's ingress drops the boundary", () => {
  const pump = appSrc.slice(appSrc.indexOf("async function camLivePump("), appSrc.indexOf("function camLiveStart("));
  assert.match(pump, /fetch\("api\/camera-live\?printer="\+entry\.printerId,\{signal:entry\.abort\.signal/);
  assert.match(pump, /r\.headers\.get\("X-SnapCon-Boundary"\)\|\|"snapconframe"/);
  assert.match(pump, /camLiveNextFrame\(buf,boundaryBytes,gapBytes\)/);
  assert.match(pump, /if\(buf\.length>CAM_LIVE_MAX_FRAME\) throw new Error\("live stream out of sync"\)/, "a stream that never yields a frame is not buffered forever");
  const show = appSrc.slice(appSrc.indexOf("function camLiveShow("), appSrc.indexOf("async function camLivePump("));
  assert.match(show, /URL\.createObjectURL\(new Blob\(\[bytes\],\{type:"image\/jpeg"\}\)\)/);
  assert.match(show, /if\(entry\.prevUrl\)\{ try\{ URL\.revokeObjectURL\(entry\.prevUrl\); \}catch\{\} \}/, "frames are released, one behind, so the tile never flashes empty");
  assert.match(serverSrc, /"X-SnapCon-Boundary": MJPEG_BOUNDARY/);
});

test("client: a dead live view falls back to the snapshot tile, and our own stop is not read as a failure", () => {
  const mount = appSrc.slice(appSrc.indexOf("function mountCamLive("), appSrc.indexOf("// The WebRTC counterpart of mountCamShot"));
  assert.match(mount, /const entry=camLiveEntry\(id,img,id,\(\)=>\{[\s\S]*?mountCamShot\(next,id,refreshMs,stagger\);/);
  const start = appSrc.slice(appSrc.indexOf("function camLiveStart("), appSrc.indexOf("function camLiveStop("));
  assert.match(start, /if\(entry\.state!=="on"\) return; \/\/ our own stop, not a failure/);
});

test("client: the MJPEG parser reads exactly one frame per part and waits for the rest", () => {
  // The three helpers are pure, so they run here against a hand-built stream.
  const vm = require("node:vm");
  const src = ["camLiveConcat", "camLiveIndexOf", "camLiveNextFrame"].map(n => {
    const at = appSrc.indexOf("function " + n + "(");
    return appSrc.slice(at, appSrc.indexOf("\n}", at) + 2);
  }).join("\n");
  const sb = { TextDecoder, CAM_LIVE_MAX_FRAME: 16 * 1024 * 1024 };
  vm.createContext(sb);
  vm.runInContext(src + ";this.camLiveNextFrame=camLiveNextFrame;this.camLiveConcat=camLiveConcat;", sb);
  const enc = new TextEncoder();
  const part = (body) => sb.camLiveConcat(enc.encode("--snapconframe\r\nContent-Type: image/jpeg\r\nContent-Length: " + body.length + "\r\n\r\n"), sb.camLiveConcat(body, enc.encode("\r\n")));
  const a = enc.encode("JPEG-ONE"), b = enc.encode("JPEG-TWO-LONGER");
  const bound = enc.encode("--snapconframe"), gap = enc.encode("\r\n\r\n");
  const stream = sb.camLiveConcat(part(a), part(b));
  const half = stream.subarray(0, part(a).length - 3);
  assert.equal(sb.camLiveNextFrame(half, bound, gap), null, "an incomplete frame is not shown");
  const f1 = sb.camLiveNextFrame(stream, bound, gap);
  assert.equal(new TextDecoder().decode(f1.bytes), "JPEG-ONE");
  const f2 = sb.camLiveNextFrame(f1.rest, bound, gap);
  assert.equal(new TextDecoder().decode(f2.bytes), "JPEG-TWO-LONGER");
  assert.equal(sb.camLiveNextFrame(f2.rest, bound, gap), null);
});

test("client: the live view is used for the tile and the camera modal, and shares every teardown path", () => {
  assert.match(appSrc, /if\(p\.capabilities\?\.cameraStream\) mountCamStream\(slot, p\.id\);\s*\n\s*else if\(p\.capabilities\?\.cameraLive\) mountCamLive\(slot, p\.id, camRefreshMs, CAM_STAGGER\);/);
  const modalAt = appSrc.indexOf("async function loadSnapshot(");
  const modal = appSrc.slice(modalAt, appSrc.indexOf("\n}", appSrc.indexOf("// A WebRTC-only camera has no /api/snapshot to call", modalAt)));
  assert.match(modal, /livePrinter\.capabilities\?\.cameraLive[\s\S]*?CAM_LIVE\.set\("snap",entry\);\s*\n\s*camLiveStart\(entry\);/);
  assert.match(appSrc, /closeCamStream\("snap"\);\s*\n\s*closeCamLive\("snap"\);/);
  assert.match(appSrc, /if\(document\.hidden\)\{ closeAllCamRtc\(\); closeAllCamStream\(true\); closeAllCamLive\(true\); return; \}/);
  assert.match(appSrc, /loadFiles\(\); loadFleet\(\); camStreamResume\(\); camLiveResume\(\);/);
  assert.match(appSrc, /for\(const key of \[\.\.\.CAM_LIVE\.keys\(\)\]\)\{ if\(key!=="snap"&&!FLEET\.some\(f=>f\.id===key\)\) closeCamLive\(key\); \}/, "a removed printer's view is closed");
});

test("client: the Settings switch only appears for a camera SnapCon polls itself", () => {
  assert.match(appSrc, /const canLive=!caps\.cameraStream&&\(!!caps\.cameraSnapshot\|\|\(!!opts\.cameraUrl&&connectorEl\.value===opts\.connector\)\);/);
  assert.match(appSrc, /camLiveWrap\.style\.display=canLive\?"":"none";/);
  assert.match(appSrc, /if\(!canLive\) camLiveEl2\.value="0";/);
  assert.match(appSrc, /cameraLiveFps:\(v=>v>0\?v:undefined\)\(parseInt\(r\.querySelector\("\.pcameralive"\)\.value,10\)\|\|0\)/, "off is not stored");
  assert.match(appSrc, /cameraLiveFps:row\.querySelector\("\.pcameralive"\)\.value,/, "changing it marks the row dirty");
});

for (const loc of ["en", "es"]) {
  test(`${loc}.json has the live-view strings`, () => {
    const j = JSON.parse(fs.readFileSync(path.join(ROOT, "locales-default", loc + ".json"), "utf8"));
    for (const k of ["field_camera_live", "camera_live_off", "camera_live_fps", "camera_live_fps_one", "camera_live_hint"]) {
      assert.ok(j.settings.printers[k] && j.settings.printers[k].trim(), k);
    }
    assert.match(j.settings.printers.camera_live_fps, /\{fps\}/);
  });
}

// ---- the Snapmaker U1's own camera, the reason this exists ----

test("Snapmaker U1: the keepalive does not stall a running camera, and a rewritten frame is retried quickly", () => {
  const src = fs.readFileSync(path.join(ROOT, "connectors", "snapmaker-u1-klipper.js"), "utf8");
  assert.match(src, /const warm = now - st\.lastFrame < CAM_WARM_WINDOW;/);
  assert.match(src, /if \(!warm\) await new Promise\(r => setTimeout\(r, CAM_FIRST_FRAME_MS\)\);/);
  assert.match(src, /getCamState\(p\.url\)\.lastFrame = Date\.now\(\) \/ 1000;/);
  assert.match(src, /for \(let attempt = 0; attempt < 2 && r\.status === 404; attempt\+\+\)/);
});
