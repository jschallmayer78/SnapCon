// test/connectors/bambu-control.test.js — controlling a Bambu Lab printer
// from SnapCon, which only happens once that printer's "LAN Only Mode —
// allow control" switch is on.
//
// Every command goes over the same MQTT session the status comes from, so the
// tests drive the real connector against the fake broker
// (test/helpers/fakeBambuBroker.js) and read back exactly what was published.
// Printing a file additionally reads the .3mf over the fake FTPS server.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const net = require("net");
const tls = require("tls");
const path = require("path");
const bambu = require("../../connectors/bambulab-h2");
const files = require("../../connectors/bambu-files");
const { BAMBU_CA_PEMS } = require("../../connectors/bambu-ca");
const { createFakeBambuBroker } = require("../helpers/fakeBambuBroker");
const { createFakeFtpsServer, buildZip } = require("../helpers/fakeFtpsServer");
const { h2dPrinting } = require("../fixtures/bambu-reports");

// The same printer, sitting idle: what it looks like when a print can be
// started rather than paused.
function h2dIdle() {
  const r = h2dPrinting();
  r.gcode_state = "IDLE";
  r.mc_percent = 100;
  r.mc_remaining_time = 0;
  return r;
}

const I = bambu._internal;
const TLSFIX = path.join(__dirname, "..", "fixtures", "bambu-tls");
const readFix = f => fs.readFileSync(path.join(TLSFIX, f), "utf8");
const SERIAL = "TESTSERIAL0001", CODE = "a1b2c3d4";

// A printer that may be controlled, and the same one that may not.
const controlled = (port, extra = {}) => ({ id: "p_ctl", name: "H2D-Ctl", url: `mqtts://127.0.0.1:${port}`, serial: SERIAL, verificationCode: CODE, lanControl: true, ...extra });

async function withPrinter(fn, { report = h2dIdle(), ftpFiles = null } = {}) {
  const broker = createFakeBambuBroker({ serial: SERIAL, accessCode: CODE, report });
  const port = await broker.listen();
  I.setTransportFactory(cfg => net.connect(cfg.port, cfg.host));
  let ftp = null, ftpPort = 0;
  if (ftpFiles) {
    BAMBU_CA_PEMS.push(readFix("ca.pem"));
    ftp = createFakeFtpsServer({ key: readFix("TESTSERIAL0001-key.pem"), cert: readFix("TESTSERIAL0001.pem"), accessCode: CODE, files: ftpFiles });
    ftpPort = await ftp.listen();
    I.setFtpTransportFactory({
      control: (cfg) => tls.connect({ ...I.tlsOptions(cfg), port: ftpPort }),
      data: (cfg, port2, session) => tls.connect({ ...I.tlsOptions(cfg), port: port2, session })
    });
  }
  const p = controlled(port);
  try {
    const st = await bambu.probe(p);
    assert.equal(st.online, true, st.error);
    await fn(p, broker, ftp);
  } finally {
    for (const [key, c] of I.connections) { I.teardown(c); I.connections.delete(key); }
    I.setTransportFactory(null);
    if (ftp) {
      I.setFtpTransportFactory(null);
      BAMBU_CA_PEMS.splice(BAMBU_CA_PEMS.indexOf(readFix("ca.pem")), 1);
      await ftp.close();
    }
    await broker.close();
  }
}

const commandsSent = (broker) => broker.state.requests
  .map(r => r.json)
  .filter(j => j && ((j.print && !["pushall"].includes(j.print.command)) || j.system))
  .map(j => j.print || j.system);

// ---- the three that matter ----

test("pause, resume and cancel send the printer's own commands and wait for its answer", async () => {
  await withPrinter(async (p, broker) => {
    assert.deepEqual(await bambu.pause(p), { ok: true, acknowledged: true });
    await bambu.resume(p);
    await bambu.cancel(p);
    const sent = commandsSent(broker);
    assert.deepEqual(sent.map(c => c.command), ["pause", "resume", "stop"]);
    for (const c of sent) {
      assert.equal(c.param, "", c.command + " carries an empty param, as the protocol says");
      assert.match(String(c.sequence_id), /^\d+$/, "every command is numbered, so its answer can be matched");
    }
    assert.equal(new Set(sent.map(c => c.sequence_id)).size, 3, "each command gets its own number");
  }, { report: h2dPrinting() });
});

test("a command the printer refuses is an error that says why, not a silent success", async () => {
  await withPrinter(async (p, broker) => {
    broker.state.ack = "fail";
    broker.state.ackReason = "printer is in cloud mode";
    await assert.rejects(bambu.pause(p), e => /refused/.test(e.message) && /cloud mode/.test(e.message) && /LAN Only Mode/.test(e.message) && e.status === 502);
  }, { report: h2dPrinting() });
});

test("a printer that answers nothing is still treated as having taken the command", async () => {
  await withPrinter(async (p, broker) => {
    broker.state.ack = "none";
    const r = await bambu.pause(p);
    assert.deepEqual(r, { ok: true, acknowledged: false }, "some firmwares only answer the commands they refuse");
  }, { report: h2dPrinting() });
});

// ---- temperature, filament, light, speed, fan ----

test("the bed temperature is a G-code line, clamped to what the bed can do", async () => {
  await withPrinter(async (p, broker) => {
    await bambu.bedTemp(p, 60);
    await bambu.bedTemp(p, 999);
    await bambu.bedTemp(p, -5);
    assert.deepEqual(commandsSent(broker).map(c => c.param), ["M140 S60", "M140 S120", "M140 S0"]);
    assert.equal(commandsSent(broker)[0].command, "gcode_line");
  });
});

test("nothing can smuggle a second G-code line in", async () => {
  await withPrinter(async (p, broker) => {
    await assert.rejects(I.gcodeLine(p, "M140 S60\nM112"), e => e.status === 400);
    await assert.rejects(I.gcodeLine(p, "M " + "x".repeat(500)), e => e.status === 400);
    assert.deepEqual(commandsSent(broker), []);
  });
});

test("filament unload, chamber light, speed preset and part fan", async () => {
  await withPrinter(async (p, broker) => {
    await bambu.unloadFilament(p);
    await bambu.setChamberLight(p, true);
    await bambu.setChamberLight(p, false);
    await bambu.setPrintSpeed(p, 3);
    await bambu.setPartFan(p, 50);
    const sent = commandsSent(broker);
    assert.deepEqual(sent.map(c => c.command), ["unload_filament", "ledctrl", "ledctrl", "print_speed", "gcode_line"]);
    assert.equal(sent[1].led_node, "chamber_light");
    assert.equal(sent[1].led_mode, "on");
    assert.equal(sent[2].led_mode, "off");
    for (const k of ["led_on_time", "led_off_time", "loop_times", "interval_time"]) assert.ok(sent[1][k] != null, k + " is required even for on/off");
    assert.equal(sent[3].param, "3");
    assert.equal(sent[4].param, "M106 P1 S128", "50% of 255");
    await assert.rejects(bambu.setPrintSpeed(p, 9), e => e.status === 400);
    await assert.rejects(bambu.setPartFan(p, "fast"), e => e.status === 400);
  });
});

test("the printer's own light and speed are read back out of its report", () => {
  const rep = h2dPrinting();
  rep.spd_lvl = 4;
  rep.lights_report = [{ node: "chamber_light", mode: "on" }, { node: "work_light", mode: "off" }];
  const st = I.normalizeBambuState({ name: "x" }, rep, {});
  assert.equal(st.speedLevel, 4);
  assert.equal(st.lightOn, true);
  rep.lights_report = [{ node: "chamber_light", mode: "off" }];
  assert.equal(I.normalizeBambuState({ name: "x" }, rep, {}).lightOn, false);
  delete rep.lights_report;
  assert.equal(I.normalizeBambuState({ name: "x" }, rep, {}).lightOn, null, "a printer that does not report it says nothing");
});

// ---- files on the printer ----

const PNG = Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), Buffer.from("plate")]);
const SLICE_INFO = `<?xml version="1.0"?>
<config>
  <plate>
    <metadata key="index" value="1"/>
    <metadata key="prediction" value="5400"/>
    <metadata key="weight" value="42.5"/>
    <filament id="1" tray_info_idx="GFA00" type="PLA" color="#FFFFFF" used_m="3.2" used_g="9.6"/>
    <filament id="2" tray_info_idx="GFA01" type="PETG" color="#0086D6" used_m="1.1" used_g="3.3"/>
  </plate>
</config>`;
const THREE_MF = buildZip([
  { name: "3D/3dmodel.model", data: Buffer.alloc(4096, 7) },
  { name: "Metadata/plate_1.png", data: PNG },
  { name: "Metadata/plate_1.gcode", data: Buffer.from("G28\n") },
  { name: "Metadata/slice_info.config", data: Buffer.from(SLICE_INFO), deflate: true }
]);

test("the printer's .3mf files are listed, newest first, with what it says about them", async () => {
  await withPrinter(async (p) => {
    const list = await bambu.listFiles(p);
    assert.deepEqual([...list.map(f => f.path)].sort(), ["Older.3mf", "cache/Bracket v4.gcode.3mf", "cache/Newer.3mf"]);
    assert.ok(list.every(f => f.size > 0), "sizes come from the printer");
    assert.ok(list.every(f => !/\.(png|gcode)$/i.test(f.path)), "only printable projects are offered");
  }, { ftpFiles: { "/cache/Bracket v4.gcode.3mf": THREE_MF, "/cache/Newer.3mf": THREE_MF, "/Older.3mf": THREE_MF, "/cache/notes.txt": Buffer.from("x") } });
});

test("the print modal's colours and time come from the file itself", async () => {
  await withPrinter(async (p) => {
    const meta = await bambu.getFileMetadata(p, "cache/Bracket v4.gcode.3mf");
    assert.deepEqual(meta.palette.map(c => [c.hex, c.type, c.wt, c.used]), [["#FFFFFF", "PLA", "10", true], ["#0086D6", "PETG", "3", true]]);
    assert.equal(meta.estimatedTime, 5400);
  }, { ftpFiles: { "/cache/Bracket v4.gcode.3mf": THREE_MF } });
});

test("starting a file tells the printer where it is, which plate, and which AMS trays", async () => {
  const report = h2dIdle();
  report.ams = { ams: [{ id: "0", tray: [
    { id: "0", tray_type: "PLA", tray_color: "FFFFFFFF" },
    { id: "1", tray_type: "PETG", tray_color: "0086D6FF" },
    { id: "2", tray_type: "PLA", tray_color: "000000FF" },
    { id: "3" }
  ] }] };
  await withPrinter(async (p, broker) => {
    const r = await bambu.startPrintFile({ ...p, autoLevel: true, timelapse: false, flowCalibrate: true }, "cache/Bracket v4.gcode.3mf");
    assert.deepEqual(r, { ok: true, plate: 1, useAms: true });
    const cmd = commandsSent(broker).find(c => c.command === "project_file");
    assert.ok(cmd, "a project_file command is what starts a print");
    assert.equal(cmd.url, "ftp:///cache/Bracket v4.gcode.3mf");
    assert.equal(cmd.param, "Metadata/plate_1.gcode");
    assert.equal(cmd.subtask_name, "Bracket v4.gcode");
    assert.equal(cmd.use_ams, true);
    assert.deepEqual(cmd.ams_mapping, [0, 1], "white PLA is tray 1, blue PETG tray 2");
    assert.equal(cmd.bed_leveling, true);
    assert.equal(cmd.flow_cali, true);
    assert.equal(cmd.timelapse, false);
    assert.equal(cmd.bed_type, "auto");
  }, { report, ftpFiles: { "/cache/Bracket v4.gcode.3mf": THREE_MF } });
});

test("a file whose filaments are not all in the AMS is started without it, rather than stalling on the first colour change", async () => {
  const report = h2dIdle();
  report.ams = { ams: [{ id: "0", tray: [{ id: "0", tray_type: "PLA", tray_color: "FFFFFFFF" }] }] };
  await withPrinter(async (p, broker) => {
    const r = await bambu.startPrintFile(p, "cache/Bracket v4.gcode.3mf");
    assert.equal(r.useAms, false);
    const cmd = commandsSent(broker).find(c => c.command === "project_file");
    assert.equal(cmd.use_ams, false);
  }, { report, ftpFiles: { "/cache/Bracket v4.gcode.3mf": THREE_MF } });
});

test("only a .3mf can be started, and nothing can be appended to the command", async () => {
  await withPrinter(async (p, broker) => {
    for (const bad of ["job.gcode", "", "evil\r\nDELE x.3mf"]) {
      await assert.rejects(bambu.startPrintFile(p, bad), e => e.status === 400, JSON.stringify(bad));
    }
    assert.deepEqual(commandsSent(broker), []);
  });
});

// ---- the pure pieces ----

test("slice_info.config is read for the plate's filaments", () => {
  const plates = files._internal.parseSliceInfo(SLICE_INFO);
  assert.equal(plates.length, 1);
  assert.equal(plates[0].index, 1);
  assert.equal(plates[0].prediction, 5400);
  assert.deepEqual(plates[0].filaments.map(f => [f.id, f.type, f.color]), [[1, "PLA", "#FFFFFF"], [2, "PETG", "#0086D6"]]);
  assert.deepEqual(files._internal.parseSliceInfo("not xml"), [], "a file without it is not fatal");
});

test("AMS mapping: same material and colour first, same material next, nothing invented", () => {
  const trays = [
    { tray: 0, loaded: true, type: "PLA", color: "#000000" },
    { tray: 1, loaded: true, type: "PLA", color: "#FFFFFF" },
    { tray: 2, loaded: true, type: "PETG", color: "#0086D6" },
    { tray: 3, loaded: false, type: null, color: null }
  ];
  const white = { id: 1, type: "PLA", color: "#FFFFFF" }, blue = { id: 2, type: "PETG", color: "#0086D6" };
  assert.deepEqual(files.amsMapping([white, blue], trays), { mapping: [1, 2], complete: true });
  // Colour it does not have: the same material still carries the print.
  assert.deepEqual(files.amsMapping([{ id: 1, type: "PLA", color: "#FF0000" }], trays), { mapping: [0], complete: true });
  // A material it does not have at all is not silently replaced.
  assert.deepEqual(files.amsMapping([{ id: 1, type: "ABS", color: "#FF0000" }], trays), { mapping: [-1], complete: false });
  // Two filaments of one material take two different trays.
  const two = files.amsMapping([{ id: 1, type: "PLA", color: "#123456" }, { id: 2, type: "PLA", color: "#654321" }], trays);
  assert.equal(new Set(two.mapping).size, 2);
  assert.deepEqual(files.amsMapping([], trays), { mapping: [], complete: false }, "a file with no filament list is not an AMS job");
});

// ---- what must not be reported as done ----

test("a command that never left, or whose session dropped, is an error — not a quiet success", async () => {
  await withPrinter(async (p, broker) => {
    // The session drops while the printer is still thinking about it.
    broker.state.ack = "none";
    const inFlight = bambu.pause(p);
    setTimeout(() => broker.dropAll(), 40);
    await assert.rejects(inFlight, e => /did not reach/.test(e.message) && e.status === 502,
      "an operator clicking Pause must not be told it worked when the connection went");
  }, { report: h2dPrinting() });
});

test("commands are numbered from a random point, so another LAN client's answers are not read as ours", () => {
  const seqs = new Set();
  for (let i = 0; i < 5; i++) seqs.add(I.newConn("x", {}).seq);
  assert.ok(seqs.size > 1, "two sessions must not start on the same number");
  assert.ok([...seqs].every(n => Number.isInteger(n) && n >= 0));
});

test("the AMS is read from a session that is actually up, not from whatever happens to be cached", async () => {
  const report = h2dIdle();
  report.ams = { ams: [{ id: "0", tray: [
    { id: "0", tray_type: "PLA", tray_color: "FFFFFFFF" },
    { id: "1", tray_type: "PETG", tray_color: "0086D6FF" }
  ] }] };
  await withPrinter(async (p, broker) => {
    // What a restarted server looks like: nothing connected yet when the
    // print is started.
    for (const [key, c] of I.connections) { I.teardown(c); I.connections.delete(key); }
    const r = await bambu.startPrintFile(p, "cache/Bracket v4.gcode.3mf");
    assert.equal(r.useAms, true, "the tray that is there must be found, not missed because nothing was connected yet");
  }, { report, ftpFiles: { "/cache/Bracket v4.gcode.3mf": THREE_MF } });
});

test("a file name that points outside the printer's own listing is refused", async () => {
  await withPrinter(async (p, broker) => {
    for (const bad of ["/etc/passwd.3mf", "../../secret.3mf", "cache/..\\x.3mf", "x".repeat(300) + ".3mf"]) {
      await assert.rejects(bambu.startPrintFile(p, bad), e => e.status === 400, JSON.stringify(bad));
      assert.deepEqual((await bambu.getFileMetadata(p, bad)).palette, [], JSON.stringify(bad));
    }
    assert.deepEqual(commandsSent(broker), []);
  });
});

test("a printer whose file list cannot be read is an error, not a printer with no files", async () => {
  await withPrinter(async (p, broker, ftp) => {
    await ftp.close(); // the FTP server goes away
    await assert.rejects(bambu.listFiles(p));
  }, { ftpFiles: { "/cache/Bracket v4.gcode.3mf": THREE_MF } });
});

test("AMS mapping is indexed by the project's filament slot, and exact colours are claimed first", () => {
  const trays = [
    { tray: 0, loaded: true, type: "PLA", color: "#0000FF" },
    { tray: 1, loaded: true, type: "PLA", color: "#000000" },
    { tray: 2, loaded: true, type: "PETG", color: "#0086D6" }
  ];
  // A plate that uses filaments 1 and 3 of a four-filament project: slot 2
  // must stay empty, or the printer prints filament 2's part from tray 1.
  const sparse = files.amsMapping([{ id: 1, type: "PLA", color: "#0000FF" }, { id: 3, type: "PETG", color: "#0086D6" }], trays);
  assert.deepEqual(sparse, { mapping: [0, -1, 2], complete: true });
  // A filament with no colour match must not eat the tray that is the only
  // exact match for a later one.
  const exactFirst = files.amsMapping([{ id: 1, type: "PLA", color: "#FF0000" }, { id: 2, type: "PLA", color: "#0000FF" }], trays);
  assert.deepEqual(exactFirst, { mapping: [1, 0], complete: true });
});
