// connectors/bambu-files.js — the files a Bambu Lab printer already has, and
// what it takes to start one.
//
// A Bambu printer prints .3mf projects sliced by Bambu Studio, not the G-code
// SnapCon manages, so SnapCon never sends one: it lists what is already on the
// printer's storage (over the same read-only FTPS connection the job preview
// uses) and asks the printer to start it. Everything the print command needs —
// which plate, which filaments — is read out of the .3mf itself with ranged
// reads, the same few kilobytes the preview already fetches.
const { readCentralDirectory, readEntry } = require("./zip-reader");

const PRINTABLE_DIRS = ["/cache/", "/"];
const PRINTABLE_RE = /\.3mf$/i;
const SLICE_INFO = "Metadata/slice_info.config";
// Only reached on a printer whose FTP server offers neither SIZE nor REST —
// a Bambu offers both. Capped so a single metadata read can never pull a
// multi-hundred-megabyte project into memory.
const WHOLE_FILE_MAX = 64 * 1024 * 1024;
const LISTING_MAX = 4 * 1024 * 1024;

// "cache/Bracket v4.gcode.3mf" is what SnapCon shows and hands back; the
// printer wants "ftp:///cache/Bracket v4.gcode.3mf".
const toPath = (dir, name) => (dir === "/" ? "" : dir.replace(/^\//, "")) + name;
const toFtpPath = (p) => "/" + String(p).replace(/^\/+/, "");

function isPrintable(name) {
  return PRINTABLE_RE.test(name) && !/^\./.test(name);
}

// Lists the printer's .3mf files. Size and date are asked for per file (SIZE,
// MDTM); a server that answers neither still produces a usable list.
async function listPrintables(ftp) {
  const out = [];
  const seen = new Set();
  let failures = 0, lastError = null;
  for (const dir of PRINTABLE_DIRS) {
    let names = [];
    // A directory the printer does not have is simply empty; a session that
    // died is not — reporting that as "no files" would send someone looking
    // for a file the printer actually has.
    try { names = await ftp.list(dir, LISTING_MAX); } catch (e) { failures++; lastError = e; continue; }
    for (const name of names) {
      if (!isPrintable(name) || seen.has(dir + name)) continue;
      seen.add(dir + name);
      const path = toPath(dir, name);
      let size = null, modified = 0;
      try { size = await ftp.size(dir + name); } catch {}
      try { modified = (await ftp.mdtm(dir + name)) || 0; } catch {}
      out.push({ path, size: size || 0, modified });
    }
  }
  if (!out.length && failures === PRINTABLE_DIRS.length && lastError) throw lastError;
  // Newest first when the printer dated them, by name otherwise.
  return out.sort((a, b) => (b.modified - a.modified) || a.path.localeCompare(b.path));
}

// ---- inside the .3mf ----

// Bambu Studio writes one <plate> per plate into Metadata/slice_info.config,
// with a <filament> line per filament the plate uses. Parsed with a regex
// rather than an XML parser: it is a flat, machine-written file, and this is
// the only thing SnapCon reads out of it.
function parseSliceInfo(xml) {
  const plates = [];
  const text = String(xml || "");
  for (const block of text.split(/<plate>/i).slice(1)) {
    const body = block.split(/<\/plate>/i)[0];
    const meta = {};
    for (const m of body.matchAll(/<metadata\s+key="([^"]*)"\s+value="([^"]*)"/gi)) meta[m[1]] = m[2];
    const filaments = [];
    for (const m of body.matchAll(/<filament\s+([^>]*)\/?>/gi)) {
      const attrs = {};
      for (const a of m[1].matchAll(/(\w+)="([^"]*)"/g)) attrs[a[1]] = a[2];
      const id = parseInt(attrs.id, 10);
      if (!Number.isFinite(id)) continue;
      filaments.push({
        id,
        type: (attrs.type || "").trim(),
        color: normalizeColor(attrs.color),
        usedG: Number(attrs.used_g) || 0,
        usedM: Number(attrs.used_m) || 0
      });
    }
    filaments.sort((a, b) => a.id - b.id);
    const index = parseInt(meta.index, 10);
    plates.push({
      index: Number.isFinite(index) ? index : plates.length + 1,
      prediction: Number(meta.prediction) || null, // seconds
      weight: Number(meta.weight) || null,
      filaments
    });
  }
  return plates;
}

function normalizeColor(c) {
  const m = /^#?([0-9a-f]{6})(?:[0-9a-f]{2})?$/i.exec(String(c || "").trim());
  return m ? "#" + m[1].toUpperCase() : null;
}

// Which plates the file holds, from the gcode entries, so a file without a
// slice_info.config still prints (plate 1).
function platesFromEntries(entries) {
  const out = [];
  for (const e of entries) {
    const m = /^Metadata\/plate_(\d+)\.gcode$/i.exec(e.name);
    if (m) out.push(Number(m[1]));
  }
  return [...new Set(out)].sort((a, b) => a - b);
}

// Reads just what starting a print needs: the plate numbers and, when it is
// there, the slice info for the chosen plate.
async function readJob(ftp, path, { plate = null } = {}) {
  const ftpPath = toFtpPath(path);
  let size = null;
  try { size = await ftp.size(ftpPath); } catch {}
  let whole = null;
  const readWhole = async () => {
    if (!whole) whole = await ftp.read(ftpPath, 0, Infinity, WHOLE_FILE_MAX);
    return whole;
  };
  let ranged = size != null;
  const read = async (offset, length) => {
    if (ranged) {
      try { return await ftp.read(ftpPath, offset, length); }
      catch (e) { if (e.code !== "ENOREST") throw e; ranged = false; }
    }
    const all = await readWhole();
    return all.subarray(offset, offset + length);
  };
  const total = size != null ? size : (await readWhole()).length;
  const entries = await readCentralDirectory(read, total);
  const plates = platesFromEntries(entries);
  const info = entries.find(e => e.name.toLowerCase() === SLICE_INFO.toLowerCase());
  let sliceInfo = [];
  if (info) {
    try { sliceInfo = parseSliceInfo((await readEntry(read, info)).toString("utf8")); } catch { sliceInfo = []; }
  }
  const chosen = plate || plates[0] || (sliceInfo[0] && sliceInfo[0].index) || 1;
  return { plate: chosen, plates: plates.length ? plates : [chosen], info: sliceInfo.find(pl => pl.index === chosen) || null };
}

// ---- AMS ----

// Maps the file's filaments onto the printer's AMS trays: same material and
// the same colour wins, same material alone will do. Position in the array is
// the file's filament (0-based), the value the printer's global tray number
// (unit * 4 + slot), -1 for one that has no home — which is what makes the
// difference between a print that starts and one that stops on the first
// colour change, so a file whose filaments cannot all be placed is started
// without the AMS instead.
function amsMapping(filaments, trays) {
  if (!filaments.length || !trays.length) return { mapping: filaments.map(() => -1), complete: false };
  const taken = new Set();
  const chosen = new Map(); // filament id -> tray
  const loaded = trays.filter(t => t.loaded);
  const claim = (f, t) => { taken.add(t.tray); chosen.set(f.id, t.tray); };
  // Exact matches first, all of them: deciding one filament at a time would
  // let a filament that has no colour match take the very tray that is the
  // only exact match for a later one.
  for (const f of filaments) {
    const exact = loaded.find(t => !taken.has(t.tray) && sameMaterial(t.type, f.type) && t.color && f.color && t.color === f.color);
    if (exact) claim(f, exact);
  }
  for (const f of filaments) {
    if (chosen.has(f.id)) continue;
    const sameType = loaded.find(t => !taken.has(t.tray) && sameMaterial(t.type, f.type));
    if (sameType) claim(f, sameType);
  }
  // The array the printer reads is indexed by the PROJECT's filament slot
  // (id 1 is index 0), not by position in this plate's list: a plate that
  // uses filaments 1 and 3 of a four-filament project must leave index 1
  // empty, or the printer prints slot 2's part from slot 3's spool.
  const size = Math.max(...filaments.map(f => f.id), filaments.length);
  const mapping = new Array(size).fill(-1);
  for (const f of filaments) {
    const tray = chosen.has(f.id) ? chosen.get(f.id) : -1;
    if (f.id >= 1 && f.id <= size) mapping[f.id - 1] = tray;
  }
  return { mapping, complete: filaments.every(f => chosen.has(f.id)) };
}

function sameMaterial(a, b) {
  const norm = (s) => String(s || "").trim().toUpperCase().replace(/[\s-]/g, "");
  if (!norm(a) || !norm(b)) return false;
  return norm(a) === norm(b);
}

module.exports = {
  listPrintables, readJob, amsMapping,
  _internal: { parseSliceInfo, platesFromEntries, normalizeColor, sameMaterial, toFtpPath, isPrintable, PRINTABLE_DIRS }
};
