// FAT12/16/32 volumes in a byte array: enough of a file system driver to format a memory card
// image and to list, read, write and delete files in it, including long file names.
//
// The image is either a bare volume ("super floppy", what mkfs.vfat and this module produce)
// or a disk with an MBR whose first FAT partition is used. Everything follows Microsoft's
// "FAT: General Overview of On-Disk Format" (v1.03); FatFs, which ESP-IDF uses, reads it.

const SECTOR = 512;
const ATTR_RO = 0x01, ATTR_HIDDEN = 0x02, ATTR_SYSTEM = 0x04, ATTR_VOLUME = 0x08, ATTR_DIR = 0x10, ATTR_ARCHIVE = 0x20;
const ATTR_LFN = 0x0f;

export class FatError extends Error {}

const u16 = (b, o) => b[o] | (b[o + 1] << 8);
const u32 = (b, o) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
const w16 = (b, o, v) => { b[o] = v & 0xff; b[o + 1] = (v >> 8) & 0xff; };
const w32 = (b, o, v) => { b[o] = v & 0xff; b[o + 1] = (v >>> 8) & 0xff; b[o + 2] = (v >>> 16) & 0xff; b[o + 3] = (v >>> 24) & 0xff; };

function fatDateTime(d = new Date()) {
  const date = ((Math.max(1980, d.getFullYear()) - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
  return { date, time };
}

function parseDateTime(date, time) {
  if (!date) return null;
  return new Date(1980 + (date >> 9), ((date >> 5) & 15) - 1, date & 31, time >> 11, (time >> 5) & 63, (time & 31) * 2);
}

/** Split "/a/b/c" into ["a", "b", "c"]. */
export function splitPath(path) {
  return String(path).split('/').filter((p) => p && p !== '.');
}

function lfnChecksum(short11) {
  let sum = 0;
  for (let i = 0; i < 11; i++) sum = (((sum & 1) << 7) | (sum >> 1)) + short11[i] & 0xff;
  return sum;
}

const SHORT_OK = /^[A-Z0-9!#$%&'()\-@^_`{}~]+$/;

/** The name as an exact 8.3 short name, or null if it needs a long name entry. */
function exactShortName(name) {
  if (name === '.' || name === '..') return null;
  const dot = name.lastIndexOf('.');
  const base = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot + 1) : '';
  if (!base || base.length > 8 || ext.length > 3 || (dot > 0 && !ext)) return null;
  if (!SHORT_OK.test(base) || (ext && !SHORT_OK.test(ext))) return null;
  return pad83(base, ext);
}

function pad83(base, ext) {
  const out = new Uint8Array(11).fill(0x20);
  for (let i = 0; i < base.length; i++) out[i] = base.charCodeAt(i);
  for (let i = 0; i < ext.length; i++) out[8 + i] = ext.charCodeAt(i);
  if (out[0] === 0xe5) out[0] = 0x05;
  return out;
}

function shortToString(e) {
  const raw = Array.from(e.subarray(0, 11), (c) => String.fromCharCode(c));
  if (raw[0] === '\x05') raw[0] = '\xe5';
  let base = raw.slice(0, 8).join('').trimEnd();
  let ext = raw.slice(8, 11).join('').trimEnd();
  // Windows NT case flags: lowercase base (bit 3) / extension (bit 4).
  if (e[12] & 0x08) base = base.toLowerCase();
  if (e[12] & 0x10) ext = ext.toLowerCase();
  return ext ? base + '.' + ext : base;
}

function cleanForShort(s) {
  let out = '';
  for (const ch of s.toUpperCase()) {
    if (ch === ' ' || ch === '.') continue;
    out += SHORT_OK.test(ch) ? ch : '_';
  }
  return out;
}

export class FatVolume {
  /**
   * @param {Uint8Array} image the whole card; modified in place
   */
  constructor(image) {
    this.img = image;
    this.base = 0;
    let bs = image.subarray(0, SECTOR);
    if (!this.looksLikeBootSector(bs)) {
      // An MBR: take the first partition with a FAT type.
      if (u16(bs, 510) !== 0xaa55) throw new FatError('not a FAT volume (no boot signature)');
      let found = false;
      for (let i = 0; i < 4; i++) {
        const p = 446 + i * 16;
        const type = bs[p + 4];
        if ([0x01, 0x04, 0x06, 0x0b, 0x0c, 0x0e].includes(type)) {
          this.base = u32(bs, p + 8) * SECTOR;
          found = true;
          break;
        }
      }
      if (!found) throw new FatError('no FAT partition on this card');
      bs = image.subarray(this.base, this.base + SECTOR);
      if (!this.looksLikeBootSector(bs)) throw new FatError('partition is not FAT formatted');
    }
    this.bytesPerSector = u16(bs, 11);
    this.secPerClus = bs[13];
    this.reserved = u16(bs, 14);
    this.numFats = bs[16];
    this.rootEntries = u16(bs, 17);
    const total16 = u16(bs, 19);
    this.totalSectors = total16 || u32(bs, 32);
    const fat16 = u16(bs, 22);
    this.fatSize = fat16 || u32(bs, 36);
    this.rootDirSectors = Math.ceil((this.rootEntries * 32) / this.bytesPerSector);
    this.firstDataSector = this.reserved + this.numFats * this.fatSize + this.rootDirSectors;
    const dataSectors = this.totalSectors - this.firstDataSector;
    this.clusterCount = Math.floor(dataSectors / this.secPerClus);
    this.type = this.clusterCount < 4085 ? 12 : this.clusterCount < 65525 ? 16 : 32;
    this.rootCluster = this.type === 32 ? u32(bs, 44) : 0;
    this.fsInfoSector = this.type === 32 ? u16(bs, 48) : 0;
    this.clusterBytes = this.secPerClus * this.bytesPerSector;
    if (this.bytesPerSector !== SECTOR) throw new FatError('unsupported sector size ' + this.bytesPerSector);
    const labelOff = this.type === 32 ? 71 : 43;
    this.label = String.fromCharCode(...bs.subarray(labelOff, labelOff + 11)).trim();
    this.allocHint = 2;
  }

  looksLikeBootSector(bs) {
    return (bs[0] === 0xeb || bs[0] === 0xe9) && u16(bs, 11) === SECTOR && bs[13] && (bs[13] & (bs[13] - 1)) === 0 && bs[16] >= 1;
  }

  // ---- low level ---------------------------------------------------------------------------

  sectorOffset(sector) { return this.base + sector * SECTOR; }
  clusterOffset(c) { return this.sectorOffset(this.firstDataSector + (c - 2) * this.secPerClus); }

  fatGet(c) {
    const fat = this.sectorOffset(this.reserved);
    const b = this.img;
    if (this.type === 12) {
      const o = fat + c + (c >> 1);
      const v = u16(b, o);
      return c & 1 ? v >> 4 : v & 0xfff;
    }
    if (this.type === 16) return u16(b, fat + c * 2);
    return u32(b, fat + c * 4) & 0x0fffffff;
  }

  fatSet(c, v) {
    const b = this.img;
    for (let f = 0; f < this.numFats; f++) {
      const fat = this.sectorOffset(this.reserved + f * this.fatSize);
      if (this.type === 12) {
        const o = fat + c + (c >> 1);
        const old = u16(b, o);
        w16(b, o, c & 1 ? (old & 0x000f) | ((v & 0xfff) << 4) : (old & 0xf000) | (v & 0xfff));
      } else if (this.type === 16) {
        w16(b, fat + c * 2, v);
      } else {
        const o = fat + c * 4;
        w32(b, o, (u32(b, o) & 0xf0000000) | (v & 0x0fffffff));
      }
    }
  }

  isEnd(v) { return v >= (this.type === 12 ? 0xff8 : this.type === 16 ? 0xfff8 : 0x0ffffff8); }
  get endMark() { return this.type === 12 ? 0xfff : this.type === 16 ? 0xffff : 0x0fffffff; }

  chain(start) {
    const out = [];
    let c = start;
    const seen = new Set();
    while (c >= 2 && c < this.clusterCount + 2 && !seen.has(c)) {
      seen.add(c);
      out.push(c);
      const next = this.fatGet(c);
      if (this.isEnd(next) || next < 2) break;
      c = next;
    }
    return out;
  }

  freeClusters() {
    let n = 0;
    for (let c = 2; c < this.clusterCount + 2; c++) if (this.fatGet(c) === 0) n++;
    return n;
  }

  get freeBytes() { return this.freeClusters() * this.clusterBytes; }
  get totalBytes() { return this.clusterCount * this.clusterBytes; }

  allocCluster(prev) {
    const n = this.clusterCount;
    for (let i = 0; i < n; i++) {
      const c = 2 + ((this.allocHint - 2 + i) % n);
      if (this.fatGet(c) === 0) {
        this.fatSet(c, this.endMark);
        if (prev) this.fatSet(prev, c);
        this.allocHint = c + 1;
        this.img.fill(0, this.clusterOffset(c), this.clusterOffset(c) + this.clusterBytes);
        return c;
      }
    }
    throw new FatError('card is full');
  }

  freeChain(start) {
    for (const c of this.chain(start)) this.fatSet(c, 0);
  }

  /** Byte offsets of every 32-byte slot of a directory (root of FAT12/16 is a fixed region). */
  dirSlots(cluster) {
    const slots = [];
    if (cluster === 0 && this.type !== 32) {
      const start = this.sectorOffset(this.reserved + this.numFats * this.fatSize);
      for (let i = 0; i < this.rootEntries; i++) slots.push(start + i * 32);
    } else {
      for (const c of this.chain(cluster || this.rootCluster)) {
        const o = this.clusterOffset(c);
        for (let i = 0; i < this.clusterBytes / 32; i++) slots.push(o + i * 32);
      }
    }
    return slots;
  }

  /** Parse a directory into entries with their slot ranges. */
  readDirCluster(cluster) {
    const slots = this.dirSlots(cluster);
    const out = [];
    let lfn = [], lfnStart = -1, lfnSum = -1;
    for (let i = 0; i < slots.length; i++) {
      const e = this.img.subarray(slots[i], slots[i] + 32);
      if (e[0] === 0x00) break;
      if (e[0] === 0xe5) { lfn = []; lfnStart = -1; continue; }
      if (e[11] === ATTR_LFN) {
        if (e[0] & 0x40) { lfn = []; lfnStart = i; lfnSum = e[13]; }
        const part = [];
        for (const o of [1, 3, 5, 7, 9, 14, 16, 18, 20, 22, 24, 28, 30]) part.push(u16(e, o));
        lfn[(e[0] & 0x1f) - 1] = part;
        continue;
      }
      if (e[11] & ATTR_VOLUME) { lfn = []; lfnStart = -1; continue; }
      let name = shortToString(e);
      const first = lfnStart >= 0 ? lfnStart : i;
      if (lfn.length && lfnSum === lfnChecksum(e.subarray(0, 11))) {
        const chars = [];
        for (const part of lfn) {
          if (!part) { chars.length = 0; break; }
          for (const ch of part) { if (ch === 0 || ch === 0xffff) break; chars.push(ch); }
        }
        if (chars.length) name = String.fromCharCode(...chars);
      }
      const hi = this.type === 32 ? u16(e, 20) : 0;
      out.push({
        name,
        shortName: shortToString(e),
        isDir: !!(e[11] & ATTR_DIR),
        attr: e[11],
        size: u32(e, 28),
        cluster: (hi << 16) | u16(e, 26),
        modified: parseDateTime(u16(e, 24), u16(e, 22)),
        slots: slots.slice(first, i + 1),
      });
      lfn = []; lfnStart = -1;
    }
    return out;
  }

  /** Resolve a path to its entry ({isDir, cluster, ...}); the root is {isDir:true, cluster:0}. */
  lookup(path) {
    let cur = { name: '', isDir: true, cluster: 0, root: true };
    for (const part of splitPath(path)) {
      if (!cur.isDir) return null;
      const want = part.toLowerCase();
      const next = this.readDirCluster(cur.cluster).find((e) => e.name.toLowerCase() === want && e.name !== '.' && e.name !== '..');
      if (!next) return null;
      cur = next;
    }
    return cur;
  }

  // ---- public API --------------------------------------------------------------------------

  /** Entries of a directory, without "." and "..". */
  list(path = '/') {
    const dir = this.lookup(path);
    if (!dir) throw new FatError('no such directory: ' + path);
    if (!dir.isDir) throw new FatError('not a directory: ' + path);
    return this.readDirCluster(dir.cluster)
      .filter((e) => e.name !== '.' && e.name !== '..')
      .map(({ name, isDir, size, modified, attr }) => ({ name, isDir, size, modified, hidden: !!(attr & ATTR_HIDDEN) }));
  }

  exists(path) { return !!this.lookup(path); }

  readFile(path) {
    const e = this.lookup(path);
    if (!e) throw new FatError('no such file: ' + path);
    if (e.isDir) throw new FatError('is a directory: ' + path);
    const out = new Uint8Array(e.size);
    let pos = 0;
    for (const c of this.chain(e.cluster)) {
      if (pos >= e.size) break;
      const n = Math.min(this.clusterBytes, e.size - pos);
      out.set(this.img.subarray(this.clusterOffset(c), this.clusterOffset(c) + n), pos);
      pos += n;
    }
    return out;
  }

  /** Find `count` consecutive free slots in a directory, growing it if it is a cluster chain. */
  freeSlots(dirCluster, count) {
    for (;;) {
      const slots = this.dirSlots(dirCluster);
      let run = 0;
      for (let i = 0; i < slots.length; i++) {
        const b = this.img[slots[i]];
        if (b === 0x00 || b === 0xe5) {
          run++;
          if (run === count) {
            // A run that includes the end marker must keep the directory terminated: anything
            // after it is already 0x00, so nothing to do.
            return slots.slice(i - count + 1, i + 1);
          }
        } else run = 0;
      }
      if (dirCluster === 0 && this.type !== 32) throw new FatError('root directory is full');
      const chain = this.chain(dirCluster || this.rootCluster);
      this.allocCluster(chain[chain.length - 1]);
    }
  }

  uniqueShortName(dirCluster, name) {
    const taken = new Set(this.readDirCluster(dirCluster).map((e) => e.shortName.toUpperCase()));
    const dot = name.lastIndexOf('.');
    const baseRaw = cleanForShort(dot > 0 ? name.slice(0, dot) : name) || 'FILE';
    const ext = cleanForShort(dot > 0 ? name.slice(dot + 1) : '').slice(0, 3);
    for (let n = 1; n < 1000000; n++) {
      const tail = '~' + n;
      const base = baseRaw.slice(0, 8 - tail.length) + tail;
      const str = ext ? base + '.' + ext : base;
      if (!taken.has(str)) return pad83(base, ext);
    }
    throw new FatError('too many similar names');
  }

  /** Write a new directory entry (with long name entries when needed); returns its offset. */
  createEntry(dirCluster, name, attr, cluster, size) {
    if (!name || /[\\/:*?"<>|\x00-\x1f]/.test(name) || name.length > 255) throw new FatError('invalid name: ' + name);
    let short = exactShortName(name);
    const needLfn = !short;
    if (!short) short = this.uniqueShortName(dirCluster, name);
    const units = [];
    for (let i = 0; i < name.length; i++) units.push(name.charCodeAt(i));
    const lfnCount = needLfn ? Math.ceil(units.length / 13) : 0;
    const slots = this.freeSlots(dirCluster, lfnCount + 1);
    const sum = lfnChecksum(short);
    for (let k = 0; k < lfnCount; k++) {
      const seq = lfnCount - k;            // stored last part first
      const e = this.img.subarray(slots[k], slots[k] + 32);
      e.fill(0);
      e[0] = seq | (k === 0 ? 0x40 : 0);
      e[11] = ATTR_LFN;
      e[13] = sum;
      const offs = [1, 3, 5, 7, 9, 14, 16, 18, 20, 22, 24, 28, 30];
      for (let j = 0; j < 13; j++) {
        const idx = (seq - 1) * 13 + j;
        const v = idx < units.length ? units[idx] : idx === units.length ? 0 : 0xffff;
        w16(e, offs[j], v);
      }
    }
    const o = slots[lfnCount];
    const e = this.img.subarray(o, o + 32);
    e.fill(0);
    e.set(short, 0);
    e[11] = attr;
    const { date, time } = fatDateTime();
    w16(e, 14, time); w16(e, 16, date); w16(e, 18, date); w16(e, 22, time); w16(e, 24, date);
    w16(e, 20, this.type === 32 ? (cluster >>> 16) : 0);
    w16(e, 26, cluster & 0xffff);
    w32(e, 28, size);
    return o;
  }

  parentOf(path) {
    const parts = splitPath(path);
    if (!parts.length) throw new FatError('cannot use the root here');
    const name = parts.pop();
    const dir = this.lookup('/' + parts.join('/'));
    if (!dir || !dir.isDir) throw new FatError('no such directory: /' + parts.join('/'));
    return { dir, name };
  }

  /** Create a directory (and its parents). Existing directories are fine. */
  mkdir(path) {
    let cur = '';
    for (const part of splitPath(path)) {
      cur += '/' + part;
      const e = this.lookup(cur);
      if (e) { if (!e.isDir) throw new FatError('a file is in the way: ' + cur); continue; }
      const { dir, name } = this.parentOf(cur);
      const c = this.allocCluster(0);
      this.createEntry(dir.cluster, name, ATTR_DIR, c, 0);
      // "." and ".." entries
      const o = this.clusterOffset(c);
      const { date, time } = fatDateTime();
      const dots = [[pad83('.', ''), c], [pad83('..', ''), dir.root ? 0 : dir.cluster]];
      dots.forEach(([n, cl], i) => {
        const e = this.img.subarray(o + i * 32, o + i * 32 + 32);
        e.set(n, 0); e[11] = ATTR_DIR;
        w16(e, 14, time); w16(e, 16, date); w16(e, 18, date); w16(e, 22, time); w16(e, 24, date);
        w16(e, 20, this.type === 32 ? (cl >>> 16) : 0); w16(e, 26, cl & 0xffff);
      });
    }
    this.syncFsInfo();
  }

  /** Create or replace a file. Parent directories are created as needed. */
  writeFile(path, data) {
    data = data instanceof Uint8Array ? data : new Uint8Array(data);
    const parts = splitPath(path);
    if (parts.length > 1) this.mkdir('/' + parts.slice(0, -1).join('/'));
    const existing = this.lookup(path);
    if (existing && existing.isDir) throw new FatError('is a directory: ' + path);
    const needed = Math.ceil(data.length / this.clusterBytes);
    const free = this.freeClusters() + (existing ? this.chain(existing.cluster).length : 0);
    if (needed > free) throw new FatError(`not enough space on the card for ${parts[parts.length - 1]}`);
    if (existing) this.removeEntry(existing);
    let first = 0, prev = 0;
    for (let i = 0; i < needed; i++) {
      const c = this.allocCluster(prev);
      if (!first) first = c;
      const off = i * this.clusterBytes;
      this.img.set(data.subarray(off, Math.min(off + this.clusterBytes, data.length)), this.clusterOffset(c));
      prev = c;
    }
    const { dir, name } = this.parentOf(path);
    this.createEntry(dir.cluster, name, ATTR_ARCHIVE, first, data.length);
    this.syncFsInfo();
  }

  removeEntry(e) {
    if (e.cluster) this.freeChain(e.cluster);
    for (const s of e.slots) this.img[s] = 0xe5;
  }

  /** Delete a file, or a directory with everything in it. */
  remove(path) {
    const e = this.lookup(path);
    if (!e || e.root) throw new FatError('no such file: ' + path);
    if (e.isDir) {
      for (const child of this.list(path)) this.remove(path.replace(/\/$/, '') + '/' + child.name);
    }
    this.removeEntry(this.lookup(path));
    this.syncFsInfo();
  }

  syncFsInfo() {
    if (this.type !== 32 || !this.fsInfoSector) return;
    const o = this.sectorOffset(this.fsInfoSector);
    w32(this.img, o + 488, 0xffffffff);   // free count unknown: let the driver recount
    w32(this.img, o + 492, 0xffffffff);
  }

  /** Every file under a directory, depth first: [{path, size, isDir}]. */
  walk(path = '/') {
    const out = [];
    const rec = (p) => {
      for (const e of this.list(p)) {
        const full = (p === '/' ? '' : p) + '/' + e.name;
        out.push({ path: full, size: e.size, isDir: e.isDir });
        if (e.isDir) rec(full);
      }
    };
    rec(path);
    return out;
  }
}

/**
 * A freshly formatted card image of `bytes` bytes (a multiple of 512 KiB), FAT16 up to 2 GiB
 * and FAT32 above, with no partition table. Cluster sizes follow Microsoft's defaults.
 */
export function formatImage(bytes, label = 'CARDPUTER') {
  if (bytes % (512 * 1024)) throw new FatError('card size must be a multiple of 512 KiB');
  const img = new Uint8Array(bytes);
  const total = bytes / SECTOR;
  const fat32 = bytes > 2048 * 1024 * 1024 - 1;
  // Sectors per cluster: FAT16 2 KiB under 128 MiB, 4 KiB to 256, 8 KiB to 512 MiB, then 16/32.
  let spc;
  if (fat32) spc = bytes <= 8 * 2 ** 30 ? 8 : bytes <= 16 * 2 ** 30 ? 16 : 64;
  else spc = bytes <= 16 * 2 ** 20 ? 2 : bytes <= 128 * 2 ** 20 ? 4 : bytes <= 256 * 2 ** 20 ? 8 : bytes <= 512 * 2 ** 20 ? 16 : bytes <= 1024 * 2 ** 20 ? 32 : 64;
  const reserved = fat32 ? 32 : 1;
  const rootEntries = fat32 ? 0 : 512;
  const rootSecs = (rootEntries * 32) / SECTOR;
  const numFats = 2;
  // FAT size: iterate until stable (entries for every cluster plus the two reserved).
  let fatSize = 1;
  for (let i = 0; i < 8; i++) {
    const clusters = Math.floor((total - reserved - rootSecs - numFats * fatSize) / spc);
    fatSize = Math.ceil(((clusters + 2) * (fat32 ? 4 : 2)) / SECTOR);
  }
  const bs = img.subarray(0, SECTOR);
  bs.set([0xeb, 0x3c, 0x90], 0);
  bs.set(Array.from('MSWIN4.1', (c) => c.charCodeAt(0)), 3);
  w16(bs, 11, SECTOR);
  bs[13] = spc;
  w16(bs, 14, reserved);
  bs[16] = numFats;
  w16(bs, 17, rootEntries);
  if (total < 65536 && !fat32) w16(bs, 19, total); else w32(bs, 32, total);
  bs[21] = 0xf8;
  if (!fat32) w16(bs, 22, fatSize);
  w16(bs, 24, 63); w16(bs, 26, 255);
  const serial = (Date.now() ^ (Math.random() * 0xffffffff)) >>> 0;
  const lab = Array.from(label.toUpperCase().padEnd(11).slice(0, 11), (c) => c.charCodeAt(0));
  if (fat32) {
    w32(bs, 36, fatSize);
    w32(bs, 44, 2);          // root cluster
    w16(bs, 48, 1);          // FSInfo
    w16(bs, 50, 6);          // backup boot sector
    bs[64] = 0x80; bs[66] = 0x29; w32(bs, 67, serial);
    bs.set(lab, 71);
    bs.set(Array.from('FAT32   ', (c) => c.charCodeAt(0)), 82);
  } else {
    bs[36] = 0x80; bs[38] = 0x29; w32(bs, 39, serial);
    bs.set(lab, 43);
    bs.set(Array.from('FAT16   ', (c) => c.charCodeAt(0)), 54);
  }
  w16(bs, 510, 0xaa55);
  for (let f = 0; f < numFats; f++) {
    const o = (reserved + f * fatSize) * SECTOR;
    if (fat32) { w32(img, o, 0x0ffffff8); w32(img, o + 4, 0x0fffffff); w32(img, o + 8, 0x0fffffff); }
    else { w16(img, o, 0xfff8); w16(img, o + 2, 0xffff); }
  }
  if (fat32) {
    const fi = img.subarray(SECTOR, 2 * SECTOR);
    w32(fi, 0, 0x41615252); w32(fi, 484, 0x61417272); w32(fi, 488, 0xffffffff); w32(fi, 492, 0xffffffff); w32(fi, 508, 0xaa550000);
    img.copyWithin(6 * SECTOR, 0, 2 * SECTOR);
  }
  // Volume label entry in the root directory.
  const rootOff = fat32 ? (reserved + numFats * fatSize) * SECTOR : (reserved + numFats * fatSize) * SECTOR;
  img.set(lab, rootOff);
  img[rootOff + 11] = ATTR_VOLUME;
  return img;
}

export const FAT_ATTR = { ATTR_RO, ATTR_HIDDEN, ATTR_SYSTEM, ATTR_VOLUME, ATTR_DIR, ATTR_ARCHIVE };
