import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { EventEmitter } from 'node:events';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  CLAUDE_DIR, CLAUDE_WORKTREES_DIR, NODE_MODULES_CACHES, PROJECT_MARKERS, PROJECT_MARKER_EXTS,
} from './targets.js';

const execFileP = promisify(execFile);
const git = (args, cwd) => execFileP('git', args, { cwd, timeout: 20_000, maxBuffer: 4 << 20 });

const HOME = os.homedir();

// Never descend into these, anywhere. Dependency folders are only ever
// reported as a whole (with --all), never scanned for caches inside them.
const NEVER_ENTER = new Set(['.git', '.hg', '.svn', 'venv', '.venv', 'Pods', 'vendor', 'bower_components']);
// Skip these when they sit directly in the home directory (huge, never contain projects).
const HOME_SKIP = new Set(['Library', 'Applications', 'Music', 'Movies', 'Pictures', 'Public']);
// Skip these when scanning from the filesystem root.
const ROOT_SKIP = new Set([
  'System', 'Volumes', 'private', 'dev', 'proc', 'sys', 'cores', 'Library',
  'Applications', 'bin', 'sbin', 'usr', 'etc', 'var', 'opt', 'tmp', 'nix',
]);

/** Simple concurrency limiter (keeps readdir storms under control). */
function limiter(max) {
  let active = 0;
  const queue = [];
  const next = () => {
    if (active >= max || queue.length === 0) return;
    active++;
    const { fn, resolve, reject } = queue.shift();
    fn().then(resolve, reject).finally(() => {
      active--;
      next();
    });
  };
  return (fn) =>
    new Promise((resolve, reject) => {
      queue.push({ fn, resolve, reject });
      next();
    });
}

function looksLikeProject(entries) {
  for (const e of entries) {
    if (PROJECT_MARKERS.has(e.name)) return true;
    if (PROJECT_MARKER_EXTS.some((ext) => e.name.endsWith(ext))) return true;
  }
  return false;
}

/**
 * Walks `root`, emitting:
 *   'found'    (item)  – a target directory was discovered (size unknown yet)
 *   'size'     (item)  – its size has been computed
 *   'progress' ()      – another directory was read
 *   'done'     ()      – walk + all size computations finished
 *
 * item = { path, rel, name, target, size, files, mtime, state, note?, error? }
 * state: 'sizing' | 'ready' | 'deleting' | 'deleted' | 'error'
 */
export class Scanner extends EventEmitter {
  constructor({ root, targets, exclude = [], maxDepth = Infinity, filter = {} }) {
    super();
    this.root = path.resolve(root);
    this.targets = targets;
    this.targetMap = new Map(targets.map((t) => [t.name, t]));
    this.exclude = exclude;
    this.maxDepth = maxDepth;
    this.filter = filter;
    this.items = [];
    this.dirsScanned = 0;
    this.done = false;
    this.limit = limiter(48);
    this.pending = new Set();
  }

  async run() {
    await this.walk(this.root, 0);
    while (this.pending.size) await Promise.allSettled([...this.pending]);
    this.done = true;
    this.emit('done');
    return this.items;
  }

  isExcluded(full, name) {
    return this.exclude.some((x) => x === name || full.includes(x));
  }

  async readdir(dir) {
    try {
      return await this.limit(() => fs.readdir(dir, { withFileTypes: true }));
    } catch {
      return null; // EACCES, ENOENT (deleted mid-scan), ELOOP …
    }
  }

  async walk(dir, depth) {
    const entries = await this.readdir(dir);
    if (!entries) return;
    this.dirsScanned++;
    this.emit('progress');

    const isProject = looksLikeProject(entries);
    const atHome = dir === HOME;
    const atRoot = dir === path.parse(dir).root;
    const subdirs = [];
    const side = [];

    for (const e of entries) {
      if (!e.isDirectory()) continue; // symlinks report false here → never followed
      const name = e.name;
      const full = path.join(dir, name);
      if (this.isExcluded(full, name)) continue;

      const t = this.targetMap.get(name);
      if (t && (!t.project || isProject)) {
        this.found(full, t);
        continue; // don't descend into something we're about to offer for deletion
      }
      if (name === 'node_modules') {
        if (depth + 1 < this.maxDepth) side.push(this.peekNodeModules(full));
        continue;
      }
      if (NEVER_ENTER.has(name)) continue;
      if (name === CLAUDE_DIR) {
        side.push(this.walkClaudeWorktrees(full, depth + 1));
        continue;
      }
      if (name.startsWith('.')) continue; // hidden dirs never contain projects worth scanning
      if (atHome && HOME_SKIP.has(name)) continue;
      if (atRoot && ROOT_SKIP.has(name)) continue;
      if (depth + 1 < this.maxDepth) subdirs.push(full);
    }

    await Promise.all([...side, ...subdirs.map((d) => this.walk(d, depth + 1))]);
  }

  /**
   * Claude Code creates a git worktree per session at <repo>/.claude/worktrees/<name>.
   * Each is a full checkout, often with its own node_modules and build output.
   * Without -W we scan inside them like any project; with -W each worktree is
   * offered as a whole (flagged when it has uncommitted changes).
   */
  async walkClaudeWorktrees(claudeDir, claudeDepth) {
    const wtRoot = path.join(claudeDir, CLAUDE_WORKTREES_DIR);
    const entries = await this.readdir(wtRoot);
    if (!entries) return;
    this.dirsScanned++;
    const wtTarget = this.targetMap.get('worktree');
    const wtDepth = claudeDepth + 2;
    const jobs = [];
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const full = path.join(wtRoot, e.name);
      if (this.isExcluded(full, e.name)) continue;
      if (wtTarget) {
        this.found(full, wtTarget);
        continue;
      }
      if (wtDepth < this.maxDepth) jobs.push(this.walk(full, wtDepth));
    }
    await Promise.all(jobs);
  }

  /** For a whole worktree: is it still a real worktree, and does it hold uncommitted work? */
  async inspectWorktree(item) {
    try {
      const st = await fs.stat(path.join(item.path, '.git'));
      if (!st.isFile()) {
        item.note = 'not a git worktree';
        return;
      }
    } catch {
      item.note = 'not a git worktree';
      return;
    }
    try {
      const { stdout } = await git(['status', '--porcelain'], item.path);
      if (stdout.trim()) item.note = 'uncommitted changes';
    } catch {
      item.note = 'git status failed';
    }
  }

  /** node_modules itself is npkill's job; we only pick out the caches inside it. */
  async peekNodeModules(nmDir) {
    if (this.targetMap.has('node_modules')) {
      this.found(nmDir, this.targetMap.get('node_modules'));
      return;
    }
    const entries = await this.readdir(nmDir);
    if (!entries) return;
    this.dirsScanned++;
    for (const e of entries) {
      if (!e.isDirectory() || !NODE_MODULES_CACHES.includes(e.name)) continue;
      const full = path.join(nmDir, e.name);
      if (this.isExcluded(full, e.name)) continue;
      const t = this.targetMap.get(e.name);
      if (t) this.found(full, t);
    }
  }

  found(full, target) {
    const item = {
      path: full,
      rel: path.relative(this.root, full) || '.',
      name: target.name,
      target,
      size: null,
      files: 0,
      mtime: null,
      state: 'sizing',
    };
    this.items.push(item);
    this.emit('found', item);
    const track = (promise) => {
      const p = promise.catch(() => {});
      this.pending.add(p);
      p.finally(() => this.pending.delete(p));
    };
    track(this.measure(item));
    if (target.name === 'worktree') track(this.inspectWorktree(item));
  }

  /** du-style size (allocated blocks) + newest mtime inside the tree. */
  async measure(item) {
    let size = 0;
    let files = 0;
    let mtime = 0;
    try {
      const st = await fs.lstat(item.path);
      mtime = st.mtimeMs;
      item.mtime = mtime;
    } catch {
      /* ignore */
    }

    const visit = async (dir) => {
      const entries = await this.readdir(dir);
      if (!entries) return;
      const subdirs = [];
      const filePaths = [];
      for (const e of entries) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) subdirs.push(full);
        else filePaths.push(full);
      }
      for (let i = 0; i < filePaths.length; i += 64) {
        const stats = await Promise.all(
          filePaths.slice(i, i + 64).map((f) => fs.lstat(f).catch(() => null)),
        );
        for (const st of stats) {
          if (!st) continue;
          files++;
          size += st.blocks ? st.blocks * 512 : st.size;
          if (st.mtimeMs > mtime) mtime = st.mtimeMs;
        }
        item.size = size; // progressive, so the UI can show a growing number
      }
      await Promise.all(subdirs.map(visit));
    };

    await visit(item.path);
    if (item.state === 'sizing') {
      item.size = size;
      item.files = files;
      item.mtime = mtime || item.mtime;
      item.state = 'ready';
      this.emit('size', item);
    }
  }

  /** Apply --min-size / --older-than. Unknown sizes pass (they're still being computed). */
  passesFilter(item) {
    const { minSize, olderThan } = this.filter;
    if (item.state === 'ready' && item.files === 0) return false; // empty folder: nothing to gain
    if (minSize && item.state !== 'sizing' && (item.size ?? 0) < minSize) return false;
    if (olderThan && item.mtime && Date.now() - item.mtime < olderThan) return false;
    return true;
  }

  visibleItems() {
    return this.items.filter((i) => i.state !== 'deleted' && this.passesFilter(i));
  }
}

/** Delete one found item, with guard rails. */
export async function deleteItem(item, { dryRun = false, root } = {}) {
  const p = path.resolve(item.path);
  const fsRoot = path.parse(p).root;
  if (p === fsRoot || p === HOME) throw new Error(`refusing to delete ${p}`);
  if (root && p === path.resolve(root)) throw new Error('refusing to delete the scan root');
  if (root && !p.startsWith(path.resolve(root) + path.sep)) throw new Error('path escapes scan root');
  const isWorktree = item.target?.name === 'worktree';
  if (!isWorktree && path.basename(p) !== item.name) throw new Error('path/name mismatch');
  if (isWorktree && path.basename(path.dirname(path.dirname(p))) !== CLAUDE_DIR) {
    throw new Error('not under .claude/worktrees');
  }

  item.state = 'deleting';
  try {
    if (!dryRun) {
      await fs.rm(p, { recursive: true, force: true, maxRetries: 3 });
      if (isWorktree) {
        // wt → worktrees → .claude → repo: drop git's now-stale bookkeeping for it
        const repo = path.dirname(path.dirname(path.dirname(p)));
        await git(['worktree', 'prune'], repo).catch(() => {});
      }
    }
    item.state = 'deleted';
  } catch (err) {
    item.state = 'error';
    item.error = err.message;
    throw err;
  }
}
