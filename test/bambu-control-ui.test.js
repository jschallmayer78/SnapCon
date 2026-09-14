// test/bambu-control-ui.test.js — the switch that turns a watched Bambu Lab
// printer into a controlled one, and the controls that appear with it.
//
// The connector's side is exercised for real in
// test/connectors/bambu-control.test.js; this covers the wiring around it:
// the Settings switch, the routes, and what the card renders.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const vm = require("node:vm");
const { getCapabilities } = require("../connectors");

const ROOT = path.join(__dirname, "..");
const appSrc = fs.readFileSync(path.join(ROOT, "public", "app.js"), "utf8");
const serverSrc = fs.readFileSync(path.join(ROOT, "server.js"), "utf8");

test("the switch is what flips the capabilities — nothing else does", () => {
  const off = getCapabilities("bambulab-h2", { name: "p" });
  const on = getCapabilities("bambulab-h2", { name: "p", lanControl: true });
  assert.equal(off.control, false);
  assert.equal(on.control, true);
  for (const cap of ["unloadFilament", "chamberLight", "printSpeed", "partFan", "autoLevel", "flowCalibration", "timelapse"]) {
    assert.equal(off[cap], false, cap + " is off until the switch is on");
    assert.equal(on[cap], true, cap);
  }
  assert.equal(on.estop, false, "there is no emergency stop in Bambu's local protocol, switch or not");
  assert.equal(on.lanControlOption, true, "and the switch stays offered");
});

test("server: the printer's switch is stored, and carried through a save that does not mention it", () => {
  assert.match(serverSrc, /if \(p\.lanControl\) o\.lanControl = true;/);
});

test("server: light, speed and fan each check the capability for THIS printer, after the monitor-only guard", () => {
  const fn = serverSrc.slice(serverSrc.indexOf("function extraControl("), serverSrc.indexOf('extraControl("/api/printer-light"'));
  const guard = fn.indexOf("refuseMonitorOnly(p, res)");
  assert.ok(guard > 0);
  assert.ok(guard < fn.indexOf("getCapabilities(p.connector, p)[capability]"), "refused before the capability is even looked at");
  assert.ok(fn.indexOf("await c[method](p, value)") > fn.indexOf("if (value instanceof Error)"), "a bad value never reaches the printer");
  assert.match(fn, /requireRegular/);
  assert.match(fn, /printerVisibleTo\(req\.user, p\)/);
  assert.match(fn, /auditLog\.log\(/, "every command is in the audit trail");
  for (const [route, cap, method] of [["/api/printer-light", "chamberLight", "setChamberLight"], ["/api/print-speed", "printSpeed", "setPrintSpeed"], ["/api/part-fan", "partFan", "setPartFan"]]) {
    assert.match(serverSrc, new RegExp('extraControl\\("' + route + '", "' + cap + '", "' + method + '"'));
  }
});

// ---- the card ----

function sandboxFor(names) {
  const sb = { t: (k) => k, esc: (s) => String(s), monitorOnly: (p) => !!(p && p.capabilities && p.capabilities.control === false) };
  vm.createContext(sb);
  const src = names.map(n => {
    const at = appSrc.indexOf("function " + n + "(");
    assert.ok(at >= 0, n);
    return appSrc.slice(at, appSrc.indexOf("\n}", at) + 2);
  }).join("\n");
  const consts = appSrc.slice(appSrc.indexOf("const SPEED_LEVELS="), appSrc.indexOf("function printerExtrasHtml("));
  vm.runInContext(consts + src + ";this.printerExtrasHtml=printerExtrasHtml;", sb);
  return sb;
}

test("the card's extras row appears only for a printer that has those controls", () => {
  const { printerExtrasHtml } = sandboxFor(["printerExtrasHtml"]);
  const full = { id: 3, online: true, capabilities: { control: true, chamberLight: true, printSpeed: true, partFan: true }, lightOn: true, speedLevel: 3, fanPct: 48 };
  const html = printerExtrasHtml(full);
  assert.match(html, /class="printer-extras"/);
  assert.match(html, /data-light="3" data-on="1"/, "the button knows what it would switch to");
  assert.match(html, /<option value="3" selected>/, "the speed the printer reports is the one shown");
  assert.match(html, /<option value="50" selected>50%<\/option>/, "48% snaps to the nearest step");
  assert.equal(printerExtrasHtml({ ...full, online: false }), "", "an offline printer gets no controls");
  assert.equal(printerExtrasHtml({ ...full, capabilities: { control: false } }), "", "nor does a watched one");
  assert.equal(printerExtrasHtml({ id: 1, online: true, capabilities: { control: true } }), "", "nor a printer whose connector offers none of them");
  assert.match(printerExtrasHtml({ id: 1, online: true, capabilities: { control: true, chamberLight: true } }), /data-light/, "one control is enough for the row");
});

test("the card rebuilds when the printer reports a different light or speed", () => {
  const sig = appSrc.slice(appSrc.indexOf("function cardSignature("), appSrc.indexOf("// Builds one printer's card element"));
  assert.match(sig, /lightOn:p\.lightOn, speedLevel:p\.speedLevel,/);
});

test("the controls are wired to their routes, and the answer lands on the card", () => {
  assert.match(appSrc, /sendPrinterExtra\(parseInt\(lightBtn\.dataset\.light,10\),"api\/printer-light",\{on:lightBtn\.dataset\.on!=="1"\}\)/);
  assert.match(appSrc, /sendPrinterExtra\(parseInt\(speedEl\.dataset\.speed,10\),"api\/print-speed",\{level:parseInt\(speedEl\.value,10\)\}\)/);
  assert.match(appSrc, /sendPrinterExtra\(parseInt\(fanEl\.dataset\.fan,10\),"api\/part-fan",\{percent:parseInt\(fanEl\.value,10\)\}\)/);
  const fn = appSrc.slice(appSrc.indexOf("async function sendPrinterExtra("), appSrc.indexOf("function canEject("));
  assert.match(fn, /if\(!r\.ok\|\|d\.error\) throw new Error\(d\.error\|\|\("HTTP "\+r\.status\)\)/, "the printer's refusal is what the user sees");
  assert.match(fn, /loadFleet\(\)/, "and the row then shows what the printer actually reports");
});

test("Settings: the switch is offered only by a connector that declares it, and sent with the printer", () => {
  assert.match(appSrc, /const canLanControl=!!caps\.lanControlOption;/);
  assert.match(appSrc, /lanControlWrap\.style\.display=canLanControl\?"":"none";/);
  assert.match(appSrc, /if\(!canLanControl\) lanControlEl\.checked=false;/);
  assert.match(appSrc, /lanControl:r\.querySelector\('\[id\^="plancontrol-"\]'\)\.checked\|\|undefined,/);
  assert.match(appSrc, /lanControl:row\.querySelector\('\[id\^="plancontrol-"\]'\)\.checked,/, "changing it marks the row dirty");
});

for (const loc of ["en", "es"]) {
  test(`${loc}.json has the control strings`, () => {
    const j = JSON.parse(fs.readFileSync(path.join(ROOT, "locales-default", loc + ".json"), "utf8"));
    for (const k of ["light_label", "light_on_title", "light_off_title", "speed_label", "speed_silent", "speed_standard", "speed_sport", "speed_ludicrous", "fan_label", "extras_sending"]) {
      assert.ok(j.printer[k] && j.printer[k].trim(), k);
    }
    for (const k of ["lan_control_label", "lan_control_desc"]) assert.ok(j.settings.printers[k], k);
    assert.match(j.settings.printers.lan_control_desc, /LAN/i);
  });
}

test("a locale bump ships the new strings to installs that already have a copy", () => {
  // locales.js only replaces a runtime locale when the bundled _meta.version
  // is newer — without this, an existing install keeps its old file and shows
  // the raw keys instead of the new labels.
  for (const loc of ["en", "es"]) {
    const meta = JSON.parse(fs.readFileSync(path.join(ROOT, "locales-default", loc + ".json"), "utf8"))._meta;
    assert.ok(meta.version >= 50, loc + ".json _meta.version must be bumped with new strings (got " + meta.version + ")");
  }
});
