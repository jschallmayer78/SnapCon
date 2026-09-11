// test/ingress.test.js — SnapCon inside Home Assistant's sidebar (ingress).
//
// Ingress proxies the add-on under /api/hassio_ingress/<token>/ and names that
// prefix in the X-Ingress-Path header. The server writes it into the page's
// <base href>; the client only ever uses RELATIVE URLs and reads its own
// routes (/orca/…, /health/…) below that prefix. Served directly, the base is
// "/", which resolves every relative URL exactly like the absolute ones before.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const vm = require("node:vm");

const ROOT = path.join(__dirname, "..");
const PUB = path.join(ROOT, "public");
const read = (f) => fs.readFileSync(path.join(ROOT, f), "utf8");
const serverSrc = read("server.js");
const appSrc = read("public/app.js");

// ---- server: <base href> ----

function loadBaseHelpers() {
  const start = serverSrc.indexOf("const INGRESS_PATH_RE");
  const end = serverSrc.indexOf("\napp.get(\"/\", sendIndex);");
  assert.ok(start > 0 && end > start, "INGRESS_PATH_RE … sendIndex must exist in server.js");
  const sb = { fs: { readFileSync: () => "<!DOCTYPE html>\n<html>\n<head>\n<title>x</title>" }, path, ASSET_DIR: "/app" };
  vm.createContext(sb);
  vm.runInContext(serverSrc.slice(start, end) + "\nthis.pageBasePath=pageBasePath; this.sendIndex=sendIndex;", sb);
  return sb;
}
const fakeReq = (hdr) => ({ get: (n) => (n.toLowerCase() === "x-ingress-path" ? hdr : undefined) });

test("server: the page base is the ingress prefix when HA names one, '/' otherwise", () => {
  const { pageBasePath } = loadBaseHelpers();
  assert.equal(pageBasePath(fakeReq(undefined)), "/");
  assert.equal(pageBasePath(fakeReq("/api/hassio_ingress/Ab3_x-9Zk")), "/api/hassio_ingress/Ab3_x-9Zk/");
});

test("server: a malformed or hostile X-Ingress-Path never reaches the HTML", () => {
  const { pageBasePath } = loadBaseHelpers();
  for (const bad of ['/api/hassio_ingress/x"><script>alert(1)</script>', "//evil.example/", "/api/hassio_ingress/", "/api/hassio_ingress/a/b", "https://evil.example/api/hassio_ingress/t", "/other/prefix"]) {
    assert.equal(pageBasePath(fakeReq(bad)), "/", bad);
  }
});

test("server: index.html is served with <base href> as the first element of <head>", () => {
  const { sendIndex } = loadBaseHelpers();
  let body = "", headers = {};
  const res = { set(k, v) { headers[k] = v; return this; }, type() { return this; }, send(b) { body = b; }, status() { return this; } };
  sendIndex(fakeReq("/api/hassio_ingress/tok"), res);
  assert.match(body, /<head>\n<base href="\/api\/hassio_ingress\/tok\/">\n<title>/);
  sendIndex(fakeReq(undefined), res);
  assert.match(body, /<head>\n<base href="\/">/);
  assert.equal(headers["Cache-Control"], "no-cache");
});

test("server: every page route goes through sendIndex, and static serving never answers '/' itself", () => {
  assert.match(serverSrc, /app\.use\(express\.static\(path\.join\(ASSET_DIR, "public"\), \{ index: false \}\)\);/);
  assert.match(serverSrc, /app\.get\("\/", sendIndex\);/);
  assert.match(serverSrc, /app\.get\(\/\^\\\/orca\\\/\.\+\$\/i, sendIndex\);/);
  assert.match(serverSrc, /app\.get\(\/\^\\\/health\(\\\/\.\*\)\?\$\/i, sendIndex\);/);
  assert.doesNotMatch(serverSrc, /readFileSync\(path\.join\(ASSET_DIR, "public", "index\.html"\)[^\n]*\n[^\n]*\n\}\);/, "no index route bypasses the base");
});

// ---- client: only relative URLs ----

test("client: no same-origin absolute URL is left anywhere in the frontend", () => {
  const assets = fs.readdirSync(PUB).filter(f => fs.statSync(path.join(PUB, f)).isFile());
  const names = assets.map(f => f.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
  const abs = new RegExp("[\"'`(]/(?:api[/?\"'`]|fonts/|(?:" + names + ")(?![\\w.-]))", "g");
  const hits = [];
  for (const f of assets.filter(f => /\.(js|html|css)$/.test(f))) {
    const src = fs.readFileSync(path.join(PUB, f), "utf8");
    let m;
    while ((m = abs.exec(src))) hits.push(f + ":" + src.slice(0, m.index).split("\n").length + " " + src.slice(m.index, m.index + 40));
  }
  assert.deepEqual(hits, [], "absolute paths break the Home Assistant sidebar panel — use relative ones (\"api/…\", \"icon.svg\")");
});

test("client: index.html loads its scripts and stylesheet relatively", () => {
  const html = read("public/index.html");
  for (const s of ["error-codes.js", "i18n.js", "app.js"]) assert.match(html, new RegExp('<script src="' + s.replace(".", "\\.") + '"></script>'));
  assert.match(html, /<link rel="stylesheet" href="style\.css">/);
  assert.match(html, /<link rel="preload" href="fonts\/JetBrainsMono-Variable\.woff2"/);
});

function loadRouting(baseURI, pathname) {
  const start = appSrc.indexOf("const BASE_PATH");
  const end = appSrc.indexOf("\n", appSrc.indexOf("function appPath(")) + 1;
  const sb = { URL, document: { baseURI }, location: { pathname } };
  vm.createContext(sb);
  vm.runInContext(appSrc.slice(start, end) + "\nthis.BASE_PATH=BASE_PATH; this.appPath=appPath;", sb);
  return sb;
}

test("client: appPath() is the route below the prefix — ingress and direct", () => {
  let r = loadRouting("http://ha.local:8123/api/hassio_ingress/tok/", "/api/hassio_ingress/tok/");
  assert.equal(r.BASE_PATH, "/api/hassio_ingress/tok");
  assert.equal(r.appPath(), "/");
  r = loadRouting("http://ha.local:8123/api/hassio_ingress/tok/", "/api/hassio_ingress/tok/health/3");
  assert.equal(r.appPath(), "/health/3");
  r = loadRouting("http://192.168.1.5:4545/", "/orca/U1_White");
  assert.equal(r.BASE_PATH, "");
  assert.equal(r.appPath(), "/orca/U1_White");
});

test("client: the page's own routes read appPath() and push below BASE_PATH", () => {
  assert.equal((appSrc.match(/location\.pathname/g) || []).length, 1, "only appPath() itself reads location.pathname");
  assert.match(appSrc, /const m = appPath\(\)\.match\(\/\^\\\/orca\\\//);
  assert.match(appSrc, /const healthMatch=appPath\(\)\.match\(/);
  assert.match(appSrc, /history\.pushState\(null,"",BASE_PATH\+"\/"\)/);
  assert.match(appSrc, /history\.pushState\(null,"",BASE_PATH\+target\)/);
  assert.equal((appSrc.match(/history\.pushState\(/g) || []).length, 2);
});

// ---- the add-on ----

test("HA add-on: shown in the sidebar through ingress, on SnapCon's own port", () => {
  const cfg = read("ha-addon/snapcon/config.yaml");
  assert.match(cfg, /^ingress: true$/m);
  assert.match(cfg, /^ingress_port: 4545$/m);
  assert.match(cfg, /^ports:\n\s+4545\/tcp: 4545$/m, "the same port as the direct web UI");
  assert.match(cfg, /^ingress_stream: true$/m, "G-code uploads are streamed, not buffered in Home Assistant");
  assert.match(cfg, /^panel_icon: mdi:[a-z0-9-]+$/m);
  assert.match(cfg, /^panel_title: SnapCon$/m);
});
