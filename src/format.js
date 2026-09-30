// Tiny ANSI + formatting helpers (zero dependencies).
import os from 'node:os';
import path from 'node:path';

const colorEnabled =
  !!process.stdout.isTTY && !process.env.NO_COLOR && process.env.TERM !== 'dumb';

const wrap = (open, close = 39) => (s) =>
  colorEnabled ? `\x1b[${open}m${s}\x1b[${close}m` : String(s);

export const c = {
  bold: wrap(1, 22),
  dim: wrap(2, 22),
  inverse: wrap(7, 27),
  red: wrap(31),
  green: wrap(32),
  yellow: wrap(33),
  blue: wrap(34),
  magenta: wrap(35),
  cyan: wrap(36),
  gray: wrap(90),
};

const ANSI_RE = /\x1b\[[0-9;?]*[A-Za-z]/g;
export const stripAnsi = (s) => s.replace(ANSI_RE, '');
export const visibleLength = (s) => stripAnsi(s).length;

/** Cut an ANSI-coloured string to `width` visible chars, keeping escapes intact. */
export function clip(s, width) {
  let out = '';
  let vis = 0;
  let i = 0;
  while (i < s.length) {
    if (s[i] === '\x1b') {
      const m = /^\x1b\[[0-9;?]*[A-Za-z]/.exec(s.slice(i));
      if (m) {
        out += m[0];
        i += m[0].length;
        continue;
      }
    }
    if (vis >= width) break;
    out += s[i];
    vis++;
    i++;
  }
  return out;
}

const UNITS = ['B', 'KB', 'MB', 'GB', 'TB'];
export function fmtSize(bytes) {
  if (bytes == null) return '…';
  if (bytes < 1024) return `${bytes} B`;
  let n = bytes;
  let i = 0;
  while (n >= 1024 && i < UNITS.length - 1) {
    n /= 1024;
    i++;
  }
  const s = n < 10 ? n.toFixed(2) : n < 100 ? n.toFixed(1) : String(Math.round(n));
  return `${s} ${UNITS[i]}`;
}

export function fmtAge(mtimeMs, now = Date.now()) {
  if (!mtimeMs) return '?';
  const sec = Math.max(0, (now - mtimeMs) / 1000);
  const min = sec / 60;
  const h = min / 60;
  const d = h / 24;
  if (h < 1) return `${Math.floor(min)}m`;
  if (d < 1) return `${Math.floor(h)}h`;
  if (d < 14) return `${Math.floor(d)}d`;
  if (d < 60) return `${Math.floor(d / 7)}w`;
  if (d < 365) return `${Math.floor(d / 30)}mo`;
  return `${(d / 365).toFixed(1).replace(/\.0$/, '')}y`;
}

/** "500mb" → bytes. Accepts b/k/m/g/t with optional "b"/"ib". */
export function parseSize(str) {
  const m = /^\s*(\d+(?:\.\d+)?)\s*([kmgt]?)i?b?\s*$/i.exec(str);
  if (!m) throw new Error(`invalid size "${str}" (try 500mb, 2gb)`);
  const mult = { '': 1, k: 1024, m: 1024 ** 2, g: 1024 ** 3, t: 1024 ** 4 }[m[2].toLowerCase()];
  return Math.round(parseFloat(m[1]) * mult);
}

/** "7d" → ms. Units: min, h, d (default), w, mo, y. */
export function parseAge(str) {
  const m = /^\s*(\d+(?:\.\d+)?)\s*(min|h|d|w|mo|y)?\s*$/i.exec(str);
  if (!m) throw new Error(`invalid age "${str}" (try 7d, 2w, 3mo, 1y)`);
  const unit = (m[2] || 'd').toLowerCase();
  const ms = {
    min: 60e3,
    h: 3600e3,
    d: 86400e3,
    w: 7 * 86400e3,
    mo: 30 * 86400e3,
    y: 365 * 86400e3,
  }[unit];
  return parseFloat(m[1]) * ms;
}

/** Middle-ellipsis truncation for paths. */
export function truncate(str, width) {
  if (width <= 0) return '';
  if (str.length <= width) return str;
  if (width <= 1) return '…';
  const head = Math.ceil((width - 1) / 2);
  const tail = Math.floor((width - 1) / 2);
  return str.slice(0, head) + '…' + (tail ? str.slice(-tail) : '');
}

export function pad(str, width, right = false) {
  const s = String(str);
  if (s.length >= width) return s;
  const fill = ' '.repeat(width - s.length);
  return right ? fill + s : s + fill;
}

export function tildify(p, home) {
  if (!home) return p;
  if (p === home) return '~';
  return p.startsWith(home + path.sep) ? '~' + p.slice(home.length) : p;
}

/** "~" and "~/x" → the home directory. Shells on Windows (PowerShell, cmd) pass "~" through literally. */
export function expandHome(p, home = os.homedir()) {
  if (p === '~') return home;
  if (p.startsWith('~/') || p.startsWith('~\\')) return path.join(home, p.slice(2));
  return p;
}
