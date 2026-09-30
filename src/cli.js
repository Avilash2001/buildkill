import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { parseArgs } from 'node:util';
import { c, expandHome, fmtAge, fmtSize, pad, parseAge, parseSize, tildify } from './format.js';
import { Scanner, deleteItem } from './scan.js';
import { describeTargets, resolveTargets } from './targets.js';
import { runTui } from './tui.js';

const pkg = createRequire(import.meta.url)('../package.json');

const HELP = `
${c.bold('buildkill')} ${c.dim('v' + pkg.version)} — find & delete .next, .turbo, dist, build and other regenerable caches.

${c.bold('USAGE')}
  buildkill [dir] [options]            interactive (default: current directory)

${c.bold('OPTIONS')}
  -t, --target <a,b,c>   folder names to look for (replaces the default list)
  -a, --add <a,b,c>      extra folder names on top of the defaults (e.g. node_modules)
  -N, --node-modules     also look for node_modules folders (npkill-style)
  -W, --worktrees        list whole Claude Code worktrees (.claude/worktrees/*), flagging
                         any with uncommitted changes; runs git worktree prune after deleting
      --all              also include Pods and .venv on top of node_modules
  -x, --exclude <a,b>    folder names or path fragments to skip
  -d, --depth <n>        how deep to descend (default: unlimited)
      --min-size <size>  only show folders at least this big     e.g. 100mb, 2gb
      --older-than <age> only show folders untouched for this long  e.g. 7d, 2w, 3mo
  -s, --sort <mode>      size (default) | age | path
      --full             show absolute paths instead of relative ones

  -l, --list             non-interactive: print what was found and exit
      --json             like --list, as JSON
  -y, --yes              non-interactive: delete EVERYTHING found (combine with filters!)
  -n, --dry-run          never delete, only show what would be deleted
      --targets          print the default target list and exit
  -h, --help
  -v, --version

${c.bold('KEYS')} (interactive)
  ↑/↓ j/k  move        space  select        a  select all / none
  d / ⏎    delete      o      open in Finder s  cycle sort         q  quit

${c.bold('EXAMPLES')}
  buildkill ~/Desktop/Fleapo                 browse every project under a folder
  buildkill -l --min-size 200mb              quick report of the big offenders
  buildkill -t .next,.turbo -y --older-than 30d   unattended cleanup of stale caches
  buildkill -N                               include node_modules too (npkill-style)
  buildkill ~ -N --older-than 30d            everything stale, including old node_modules
  buildkill ~/Desktop -W                     leftover Claude Code session worktrees
`.trimStart();

function fail(msg) {
  process.stderr.write(`${c.red('buildkill:')} ${msg}\n${c.dim('Run buildkill --help for usage.')}\n`);
  return 1;
}

export async function main(argv) {
  let values;
  let positionals;
  try {
    ({ values, positionals } = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        target: { type: 'string', short: 't' },
        add: { type: 'string', short: 'a' },
        all: { type: 'boolean' },
        'node-modules': { type: 'boolean', short: 'N' },
        worktrees: { type: 'boolean', short: 'W' },
        exclude: { type: 'string', short: 'x' },
        depth: { type: 'string', short: 'd' },
        'min-size': { type: 'string' },
        'older-than': { type: 'string' },
        sort: { type: 'string', short: 's' },
        full: { type: 'boolean' },
        list: { type: 'boolean', short: 'l' },
        json: { type: 'boolean' },
        yes: { type: 'boolean', short: 'y' },
        'dry-run': { type: 'boolean', short: 'n' },
        targets: { type: 'boolean' },
        help: { type: 'boolean', short: 'h' },
        version: { type: 'boolean', short: 'v' },
      },
    }));
  } catch (err) {
    return fail(err.message);
  }

  if (values.help) return void process.stdout.write(HELP);
  if (values.version) return void process.stdout.write(pkg.version + '\n');
  if (values.targets) return void process.stdout.write(describeTargets() + '\n');
  if (positionals.length > 1) return fail(`expected at most one directory, got ${positionals.length}`);

  const root = path.resolve(expandHome(positionals[0] ?? process.cwd()));
  try {
    const st = await fs.stat(root);
    if (!st.isDirectory()) return fail(`${root} is not a directory`);
  } catch {
    return fail(`cannot access ${root}`);
  }

  let filter = {};
  let maxDepth = Infinity;
  try {
    if (values['min-size']) filter.minSize = parseSize(values['min-size']);
    if (values['older-than']) filter.olderThan = parseAge(values['older-than']);
    if (values.depth != null) {
      maxDepth = Number(values.depth);
      if (!Number.isInteger(maxDepth) || maxDepth < 1) throw new Error(`invalid depth "${values.depth}"`);
    }
  } catch (err) {
    return fail(err.message);
  }
  if (values.sort && !['size', 'age', 'path'].includes(values.sort)) {
    return fail(`invalid sort "${values.sort}" (size | age | path)`);
  }

  const targets = resolveTargets({
    target: values.target,
    add: values.add,
    all: values.all,
    nodeModules: values['node-modules'],
    worktrees: values.worktrees,
  });
  const exclude = values.exclude ? values.exclude.split(',').map((s) => s.trim()).filter(Boolean) : [];
  const scanner = new Scanner({ root, targets, exclude, maxDepth, filter });
  const dryRun = !!values['dry-run'];

  const wantsInteractive = !values.list && !values.json && !values.yes;
  const interactive = wantsInteractive && !!process.stdout.isTTY && !!process.stdin.isTTY;
  if (wantsInteractive && !interactive) {
    // Git Bash (mintty) and some IDE consoles give Node pipes, not a TTY.
    const mintty = !!process.env.MSYSTEM || process.env.TERM_PROGRAM === 'mintty';
    process.stderr.write(
      c.yellow('Interactive mode needs a real terminal (stdin/stdout are not a TTY); printing the list instead.\n') +
        (mintty ? c.dim('Git Bash: run  winpty buildkill …  or use Windows Terminal / PowerShell.\n') : ''),
    );
  }

  if (interactive) {
    const run = scanner.run().catch(() => {});
    const { deleted, freed } = await runTui({
      scanner,
      root,
      sort: values.sort,
      full: !!values.full,
      dryRun,
      version: pkg.version,
    });
    await Promise.race([run, new Promise((r) => setTimeout(r, 50))]);
    if (deleted) {
      process.stdout.write(
        `${dryRun ? 'Would have freed' : 'Freed'} ${c.bold(fmtSize(freed))} by deleting ${deleted} folder${deleted === 1 ? '' : 's'}.\n`,
      );
    }
    return 0;
  }

  return runBatch({ scanner, root, values, dryRun });
}

async function runBatch({ scanner, root, values, dryRun }) {
  const home = os.homedir();
  const showProgress = process.stderr.isTTY && !values.json;
  let last = 0;
  if (showProgress) {
    scanner.on('progress', () => {
      const now = Date.now();
      if (now - last < 100) return;
      last = now;
      process.stderr.write(`\r\x1b[K${c.dim(`scanning… ${scanner.dirsScanned.toLocaleString()} dirs, ${scanner.items.length} found`)}`);
    });
  }
  await scanner.run();
  if (showProgress) process.stderr.write('\r\x1b[K');

  const items = scanner
    .visibleItems()
    .sort((a, b) => (b.size ?? 0) - (a.size ?? 0) || a.rel.localeCompare(b.rel));
  const total = items.reduce((a, i) => a + (i.size ?? 0), 0);

  if (values.json) {
    process.stdout.write(
      JSON.stringify(
        {
          root,
          total,
          items: items.map((i) => ({
            path: i.path,
            target: i.name,
            size: i.size,
            files: i.files,
            mtime: i.mtime ? new Date(i.mtime).toISOString() : null,
            ...(i.note ? { note: i.note } : {}),
          })),
        },
        null,
        2,
      ) + '\n',
    );
    if (!values.yes) return 0;
  } else {
    if (!items.length) {
      process.stdout.write(`${c.green('Nothing to clean')} under ${tildify(root, home)} (${scanner.dirsScanned.toLocaleString()} dirs scanned).\n`);
      return 0;
    }
    const targetW = Math.max(6, ...items.map((i) => i.name.length));
    process.stdout.write(c.dim(`${pad('SIZE', 9, true)}  ${pad('AGE', 4, true)}  ${pad('TARGET', targetW)}  PATH\n`));
    for (const i of items) {
      const p = values.full ? tildify(i.path, home) : i.rel;
      const note = i.note ? (i.note === 'uncommitted changes' ? c.red(`  (${i.note})`) : c.yellow(`  (${i.note})`)) : '';
      process.stdout.write(`${pad(fmtSize(i.size), 9, true)}  ${pad(fmtAge(i.mtime), 4, true)}  ${c.magenta(pad(i.name, targetW))}  ${p}${note}\n`);
    }
    process.stdout.write(
      `\n${c.bold(items.length)} folder${items.length === 1 ? '' : 's'}, ${c.bold(fmtSize(total))} total ` +
        c.dim(`(${scanner.dirsScanned.toLocaleString()} dirs scanned under ${tildify(root, home)})`) + '\n',
    );
    if (!values.yes) return 0;
  }

  // --yes: delete everything listed
  process.stdout.write(`\n${dryRun ? c.yellow('[dry-run] would delete') : c.red('Deleting')} ${items.length} folder${items.length === 1 ? '' : 's'}…\n`);
  let freed = 0;
  let failed = 0;
  for (const i of items) {
    try {
      await deleteItem(i, { dryRun, root });
      freed += i.size ?? 0;
      process.stdout.write(`  ${c.green('✓')} ${pad(fmtSize(i.size), 9, true)}  ${i.rel}\n`);
    } catch (err) {
      failed++;
      process.stdout.write(`  ${c.red('✗')} ${pad('', 9)}  ${i.rel}  ${c.red(err.message)}\n`);
    }
  }
  process.stdout.write(`\n${dryRun ? 'Would free' : 'Freed'} ${c.bold(fmtSize(freed))}${failed ? c.red(`, ${failed} failed`) : ''}.\n`);
  return failed ? 2 : 0;
}
