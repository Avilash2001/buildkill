import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { Scanner, deleteItem } from '../src/scan.js';
import { resolveTargets } from '../src/targets.js';
import { fmtSize, parseAge, parseSize, truncate } from '../src/format.js';

const run = promisify(execFile);
const BIN = fileURLToPath(new URL('../bin/buildkill.js', import.meta.url));

async function mk(root, spec) {
  for (const [rel, content] of Object.entries(spec)) {
    const p = path.join(root, rel);
    if (content === null) await fs.mkdir(p, { recursive: true });
    else {
      await fs.mkdir(path.dirname(p), { recursive: true });
      await fs.writeFile(p, content);
    }
  }
}

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'buildkill-'));
  await mk(root, {
    // a Next.js app
    'web/package.json': '{}',
    'web/.next/cache/a.bin': 'x'.repeat(200_000),
    'web/.next/BUILD_ID': 'abc',
    'web/dist/bundle.js': 'y'.repeat(50_000),
    'web/node_modules/.cache/babel/x': 'z'.repeat(10_000),
    'web/node_modules/lodash/index.js': 'module.exports = 1',
    'web/node_modules/lodash/.next/should-not-find': 'nope',
    // monorepo child + turbo
    'mono/turbo.json': '{}',
    'mono/.turbo/cache.tar': 'q'.repeat(30_000),
    'mono/apps/api/package.json': '{}',
    'mono/apps/api/build/main.js': 'k'.repeat(1_000),
    // generic names WITHOUT a project marker → must not be found
    'random/dist/photo.jpg': 'jpeg',
    'random/build/notes.txt': 'notes',
    // android
    'app/android/build.gradle': '',
    'app/android/build/out.apk': 'apk',
    'app/android/.gradle/8.0/x': 'g',
    // never entered
    '.git/objects/.next/x': 'x',
    'web/.git/.next/x': 'x',
    // hidden non-target dir → not entered
    '.config/something/.next/x': 'x',
    // deps group (opt-in)
    'py/pyproject.toml': '',
    'py/.venv/lib/x': 'v',
    'py/.venv/lib/site-packages/pkg/__pycache__/m.pyc': 'p',
    'py/venv2/lib/__pycache__/m.pyc': 'p',
    'py/__pycache__/m.pyc': 'p',
    'php/composer.json': '{}',
    'php/vendor/lib/build/x': 'x',
    // empty target folders are hidden from the list
    'web/.turbo': null,
  });
  // symlinked dir must never be followed
  await fs.symlink(path.join(root, 'web'), path.join(root, 'link-to-web'));
  return root;
}

const rels = (items) => items.map((i) => i.rel).sort();
const scan = async (opts) => { const s = new Scanner(opts); await s.run(); return s.visibleItems(); };

test('finds the right folders with default targets', async () => {
  const root = await fixture();
  try {
    const s = new Scanner({ root, targets: resolveTargets() });
    await s.run();
    const items = s.visibleItems();
    assert.ok(s.items.some((i) => i.rel === 'web/.turbo'), 'empty folder is found…');
    assert.ok(!items.some((i) => i.rel === 'web/.turbo'), '…but hidden from the view');
    assert.deepEqual(rels(items), [
      'app/android/.gradle',
      'app/android/build',
      'mono/.turbo',
      'mono/apps/api/build',
      'py/__pycache__',
      'py/venv2/lib/__pycache__',
      'web/.next',
      'web/dist',
      'web/node_modules/.cache',
    ]);
    for (const i of items) {
      assert.equal(i.state, 'ready');
      assert.ok(i.size > 0, `${i.rel} has size`);
      assert.ok(i.mtime > 0, `${i.rel} has mtime`);
    }
    const next = items.find((i) => i.rel === 'web/.next');
    assert.ok(next.size >= 200_000, 'size counts nested files');
    assert.equal(next.files, 2);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('--all adds dependency folders, -t replaces the list', async () => {
  const root = await fixture();
  try {
    const all = await scan({ root, targets: resolveTargets({ all: true }) });
    assert.ok(rels(all).includes('py/.venv'));
    assert.ok(rels(all).includes('web/node_modules'));
    assert.ok(!rels(all).includes('web/node_modules/.cache'), 'no cache when node_modules itself is a target');

    const only = await scan({ root, targets: resolveTargets({ target: '.next' }) });
    assert.deepEqual(rels(only), ['web/.next']);

    const custom = await scan({ root, targets: resolveTargets({ target: 'random' }) });
    assert.deepEqual(rels(custom), ['random']);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('depth and exclude limit the walk', async () => {
  const root = await fixture();
  try {
    const shallow = await scan({ root, targets: resolveTargets(), maxDepth: 2 });
    assert.deepEqual(rels(shallow), ['mono/.turbo', 'py/__pycache__', 'web/.next', 'web/dist']);

    const ex = await scan({ root, targets: resolveTargets(), exclude: ['web', 'mono/apps'] });
    assert.deepEqual(rels(ex), ['app/android/.gradle', 'app/android/build', 'mono/.turbo', 'py/__pycache__', 'py/venv2/lib/__pycache__']);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('filters: min-size and older-than', async () => {
  const root = await fixture();
  try {
    const s = new Scanner({ root, targets: resolveTargets(), filter: { minSize: 100_000 } });
    await s.run();
    assert.deepEqual(rels(s.visibleItems()), ['web/.next']);

    const old = new Scanner({ root, targets: resolveTargets(), filter: { olderThan: parseAge('1d') } });
    await old.run();
    assert.deepEqual(rels(old.visibleItems()), [], 'everything was just created');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('deleteItem removes the folder and refuses dangerous paths', async () => {
  const root = await fixture();
  try {
    const s = new Scanner({ root, targets: resolveTargets() });
    const items = await s.run();
    const next = items.find((i) => i.rel === 'web/.next');

    await deleteItem(next, { dryRun: true, root });
    assert.equal(next.state, 'deleted');
    await fs.access(next.path); // still there

    next.state = 'ready';
    await deleteItem(next, { root });
    await assert.rejects(fs.access(next.path));
    await fs.access(path.join(root, 'web/package.json')); // siblings untouched

    await assert.rejects(deleteItem({ path: root, name: path.basename(root) }, { root }), /scan root/);
    await assert.rejects(deleteItem({ path: os.homedir(), name: path.basename(os.homedir()) }), /refusing/);
    await assert.rejects(deleteItem({ path: '/', name: '' }), /refusing/);
    await assert.rejects(deleteItem({ path: path.join(root, 'web/dist'), name: '.next' }, { root }), /mismatch/);
    await assert.rejects(deleteItem({ path: os.tmpdir(), name: path.basename(os.tmpdir()) }, { root }), /escapes/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('CLI: --json, --list, --yes --dry-run, --yes', async () => {
  const root = await fixture();
  try {
    const { stdout: json } = await run(process.execPath, [BIN, root, '--json']);
    const data = JSON.parse(json);
    assert.equal(data.items.length, 9);
    assert.equal(data.items[0].target, '.next', 'sorted by size desc');
    assert.ok(data.total > 0);

    const { stdout: list } = await run(process.execPath, [BIN, root, '-l', '-t', '.turbo,dist']);
    assert.match(list, /mono\/\.turbo/);
    assert.match(list, /web\/dist/);
    assert.doesNotMatch(list, /\.next/);
    assert.match(list, /2 folders/);

    const { stdout: dry } = await run(process.execPath, [BIN, root, '-y', '-n', '-t', '.turbo']);
    assert.match(dry, /dry-run/);
    await fs.access(path.join(root, 'mono/.turbo'));

    const { stdout: real } = await run(process.execPath, [BIN, root, '-y', '-t', '.turbo,dist']);
    assert.match(real, /Freed/);
    await assert.rejects(fs.access(path.join(root, 'mono/.turbo')));
    await assert.rejects(fs.access(path.join(root, 'web/dist')));
    await fs.access(path.join(root, 'web/.next'));
    await fs.access(path.join(root, 'random/dist'), undefined, 'non-project dist untouched');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('CLI: bad arguments exit 1', async () => {
  await assert.rejects(run(process.execPath, [BIN, '--min-size', 'lots']), /invalid size/);
  await assert.rejects(run(process.execPath, [BIN, '--depth', '0']), /invalid depth/);
  await assert.rejects(run(process.execPath, [BIN, '/definitely/not/here']), /cannot access/);
});

test('format helpers', () => {
  assert.equal(fmtSize(0), '0 B');
  assert.equal(fmtSize(1536), '1.50 KB');
  assert.equal(fmtSize(3 * 1024 ** 3), '3.00 GB');
  assert.equal(parseSize('500mb'), 500 * 1024 ** 2);
  assert.equal(parseSize('2GiB'), 2 * 1024 ** 3);
  assert.equal(parseAge('2w'), 14 * 86400e3);
  assert.equal(parseAge('30'), 30 * 86400e3);
  assert.equal(truncate('abcdefghij', 5), 'ab…ij');
  assert.equal(truncate('abc', 5), 'abc');
});
