import os from 'node:os';
import { spawn } from 'node:child_process';
import { c, clip, fmtAge, fmtSize, pad, tildify, truncate } from './format.js';
import { deleteItem } from './scan.js';

const SPIN = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
const SORTS = ['size', 'age', 'path'];
const HEADER_ROWS = 4;
const FOOTER_ROWS = 2;

/** Split a raw stdin chunk into individual key presses / escape sequences. */
function splitKeys(chunk) {
  const keys = [];
  let i = 0;
  while (i < chunk.length) {
    if (chunk[i] === '\x1b') {
      const m = /^\x1b\[[0-9;]*[A-Za-z~]/.exec(chunk.slice(i));
      if (m) {
        keys.push(m[0]);
        i += m[0].length;
        continue;
      }
    }
    keys.push(chunk[i]);
    i++;
  }
  return keys;
}

function openInFileManager(p) {
  const cmd =
    process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer' : 'xdg-open';
  try {
    spawn(cmd, [p], { detached: true, stdio: 'ignore' }).unref();
  } catch {
    /* ignore */
  }
}

/**
 * Interactive mode. Resolves with { deleted, freed } when the user quits.
 */
export function runTui({ scanner, root, sort = 'size', full = false, dryRun = false, version = '' }) {
  return new Promise((resolve) => {
    const out = process.stdout;
    const inp = process.stdin;
    const home = os.homedir();
    const rootLabel = tildify(root, home);

    const st = {
      cursor: 0,
      cursorItem: null,
      userMoved: false, // until the user moves, the cursor stays on the top row while results stream in
      offset: 0,
      listRows: 10,
      selected: new Set(),
      freed: 0,
      deletedCount: 0,
      status: '',
      confirm: null,
      sort: SORTS.includes(sort) ? sort : 'size',
      spin: 0,
      busy: 0,
    };
    let view = [];
    let dirty = true;
    let closed = false;

    // ── data ────────────────────────────────────────────────────────────
    const comparators = {
      size: (a, b) => (b.size ?? -1) - (a.size ?? -1) || a.rel.localeCompare(b.rel),
      age: (a, b) => (a.mtime ?? Infinity) - (b.mtime ?? Infinity) || a.rel.localeCompare(b.rel),
      path: (a, b) => a.rel.localeCompare(b.rel),
    };

    function compute() {
      view = scanner.visibleItems().sort(comparators[st.sort]);
      if (st.userMoved && st.cursorItem) {
        const i = view.indexOf(st.cursorItem);
        if (i >= 0) st.cursor = i;
      }
      st.cursor = Math.min(Math.max(0, st.cursor), Math.max(0, view.length - 1));
      st.cursorItem = view[st.cursor] ?? null;
    }

    function move(delta) {
      st.userMoved = true;
      st.cursor = Math.min(Math.max(0, st.cursor + delta), Math.max(0, view.length - 1));
      st.cursorItem = view[st.cursor] ?? null;
    }

    // ── rendering ───────────────────────────────────────────────────────
    function sizeColor(item) {
      const s = item.state === 'sizing' ? (item.size ? '~' + fmtSize(item.size) : '…')
        : item.state === 'deleting' ? 'deleting'
        : item.state === 'error' ? 'error'
        : fmtSize(item.size);
      const padded = pad(s, 9, true);
      if (item.state === 'sizing') return c.dim(padded);
      if (item.state === 'error') return c.red(padded);
      if (item.state === 'deleting') return c.yellow(padded);
      if (item.size >= 1024 ** 3) return c.red(padded);
      if (item.size >= 100 * 1024 ** 2) return c.yellow(padded);
      return padded;
    }

    function render() {
      if (closed) return;
      compute();
      const cols = out.columns || 80;
      const rows = out.rows || 24;
      st.listRows = Math.max(1, rows - HEADER_ROWS - FOOTER_ROWS);

      if (st.cursor < st.offset) st.offset = st.cursor;
      if (st.cursor >= st.offset + st.listRows) st.offset = st.cursor - st.listRows + 1;
      st.offset = Math.max(0, Math.min(st.offset, Math.max(0, view.length - st.listRows)));

      let total = 0;
      let selSize = 0;
      let selCount = 0;
      for (const it of view) {
        total += it.size ?? 0;
        if (st.selected.has(it)) {
          selCount++;
          selSize += it.size ?? 0;
        }
      }

      const lines = [];
      const working = !scanner.done || st.busy > 0;
      const spinner = working ? c.cyan(SPIN[st.spin % SPIN.length]) + ' ' : c.green('✓') + ' ';
      const scanMsg = scanner.done
        ? `${scanner.dirsScanned.toLocaleString()} dirs scanned`
        : `scanning… ${scanner.dirsScanned.toLocaleString()} dirs`;
      const left = ` ${c.bold(c.magenta('buildkill'))} ${c.dim('v' + version)}  ${c.dim(rootLabel)}`;
      const right = spinner + c.dim(scanMsg) + ' ';
      const gap = Math.max(1, cols - clipLen(left) - clipLen(right));
      lines.push(left + ' '.repeat(gap) + right);

      lines.push(
        ` ${c.bold(String(view.length))} folders · ${c.bold(fmtSize(total))} total · ` +
          (selCount ? c.yellow(`${selCount} selected (${fmtSize(selSize)})`) : c.dim('0 selected')) +
          ` · ${c.green('freed ' + fmtSize(st.freed))}` +
          (dryRun ? c.yellow('  [dry-run: nothing is actually deleted]') : ''),
      );
      lines.push('');

      const targetW = Math.min(18, Math.max(6, ...view.map((i) => i.name.length)));
      const fixed = 2 + 1 + 3 + 1 + 9 + 1 + 4 + 2 + targetW + 2;
      const pathW = Math.max(8, cols - fixed - 1);
      lines.push(
        c.dim(`       ${pad('SIZE', 9, true)} ${pad('AGE', 4, true)}  ${pad('TARGET', targetW)}  PATH`),
      );

      for (let i = st.offset; i < st.offset + st.listRows; i++) {
        const it = view[i];
        if (!it) {
          if (i === st.offset && view.length === 0) {
            lines.push(
              scanner.done
                ? c.green('   Nothing to clean here. 🎉')
                : c.dim('   Looking for build caches…'),
            );
          } else lines.push('');
          continue;
        }
        const isCur = i === st.cursor;
        const sel = st.selected.has(it);
        const pathStr = truncate(full ? tildify(it.path, home) : it.rel, pathW);
        lines.push(
          (isCur ? c.cyan(' ❯') : '  ') + ' ' +
            (sel ? c.yellow('[x]') : c.dim('[ ]')) + ' ' +
            sizeColor(it) + ' ' +
            c.dim(pad(fmtAge(it.mtime), 4, true)) + '  ' +
            c.magenta(pad(truncate(it.name, targetW), targetW)) + '  ' +
            (isCur ? c.bold(pathStr) : pathStr),
        );
      }

      if (st.confirm) {
        const n = st.confirm.length;
        const sz = st.confirm.reduce((a, i) => a + (i.size ?? 0), 0);
        lines.push(
          c.yellow(` ${dryRun ? 'Pretend-delete' : 'Delete'} ${n} folder${n === 1 ? '' : 's'} (${fmtSize(sz)})? `) +
            c.bold('y') + c.dim('/N'),
        );
      } else {
        lines.push(
          c.dim(
            ` ↑↓ move · space select · a all · d/⏎ delete · o open · s sort:${st.sort} · q quit`,
          ),
        );
      }
      lines.push(' ' + st.status);

      while (lines.length < rows) lines.push('');
      lines.length = rows;
      out.write('\x1b[H' + lines.map((l) => clip(l, cols) + '\x1b[0m\x1b[K').join('\n'));
      dirty = false;
    }

    function clipLen(s) {
      return s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').length;
    }

    // ── actions ─────────────────────────────────────────────────────────
    function askDelete() {
      const items = st.selected.size
        ? view.filter((i) => st.selected.has(i))
        : view[st.cursor] ? [view[st.cursor]] : [];
      const ok = items.filter((i) => i.state === 'ready' || i.state === 'sizing');
      if (!ok.length) return;
      st.confirm = ok;
    }

    async function doDelete(items) {
      st.busy++;
      let n = 0;
      let freed = 0;
      let failed = 0;
      await Promise.all(
        items.map(async (it) => {
          const sz = it.size ?? 0;
          try {
            await deleteItem(it, { dryRun, root });
            st.selected.delete(it);
            st.freed += sz;
            st.deletedCount++;
            n++;
            freed += sz;
          } catch (err) {
            failed++;
            st.status = c.red(`Failed: ${it.rel} — ${err.message}`);
          }
          dirty = true;
        }),
      );
      st.busy--;
      if (!failed) {
        st.status = c.green(
          `${dryRun ? 'Would delete' : 'Deleted'} ${n} folder${n === 1 ? '' : 's'}, freed ${fmtSize(freed)}`,
        );
      }
      dirty = true;
    }

    function onKey(key) {
      if (st.confirm) {
        const items = st.confirm;
        st.confirm = null;
        if (key === 'y' || key === 'Y') doDelete(items);
        else st.status = c.dim('Cancelled');
        return render();
      }
      switch (key) {
        case '\x03':
        case 'q':
        case '\x1b':
          return quit();
        case '\x1b[A':
        case 'k':
          move(-1);
          break;
        case '\x1b[B':
        case 'j':
          move(1);
          break;
        case '\x1b[5~':
          move(-st.listRows);
          break;
        case '\x1b[6~':
          move(st.listRows);
          break;
        case '\x1b[H':
        case '\x1b[1~':
        case 'g':
          move(-Infinity);
          break;
        case '\x1b[F':
        case '\x1b[4~':
        case 'G':
          move(Infinity);
          break;
        case ' ': {
          const it = view[st.cursor];
          if (it) {
            if (st.selected.has(it)) st.selected.delete(it);
            else st.selected.add(it);
          }
          break;
        }
        case 'a': {
          const all = view.length > 0 && view.every((i) => st.selected.has(i));
          if (all) st.selected.clear();
          else for (const i of view) st.selected.add(i);
          break;
        }
        case 'd':
        case '\r':
        case '\n':
        case '\x1b[3~':
        case '\x7f':
          askDelete();
          break;
        case 'o': {
          const it = view[st.cursor];
          if (it) openInFileManager(it.path);
          break;
        }
        case 's':
          st.sort = SORTS[(SORTS.indexOf(st.sort) + 1) % SORTS.length];
          break;
        default:
          return;
      }
      render();
    }

    // ── lifecycle ───────────────────────────────────────────────────────
    const onData = (chunk) => {
      for (const k of splitKeys(chunk)) {
        if (closed) break;
        onKey(k);
      }
    };
    const onResize = () => render();
    const timer = setInterval(() => {
      st.spin++;
      if (dirty || !scanner.done || st.busy > 0) render();
    }, 80);

    function restore() {
      clearInterval(timer);
      inp.off('data', onData);
      out.off('resize', onResize);
      if (inp.isTTY) inp.setRawMode(false);
      inp.pause();
      out.write('\x1b[?25h\x1b[?1049l');
    }

    function quit() {
      if (closed) return;
      closed = true;
      restore();
      process.off('exit', restore);
      resolve({ deleted: st.deletedCount, freed: st.freed });
    }

    out.write('\x1b[?1049h\x1b[H\x1b[2J\x1b[?25l');
    inp.setRawMode(true);
    inp.resume();
    inp.setEncoding('utf8');
    inp.on('data', onData);
    out.on('resize', onResize);
    process.once('exit', restore);

    scanner.on('found', () => (dirty = true));
    scanner.on('size', () => (dirty = true));
    scanner.on('done', () => (dirty = true));
    render();
  });
}
