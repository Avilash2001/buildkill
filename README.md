# buildkill

Find and delete `.next`, `.turbo`, `dist`, `build` and other regenerable build caches.
Like [npkill](https://npkill.js.org/), but for build artifacts instead of `node_modules`.

```
 buildkill v1.0.0  ~/Desktop                                        ✓ 11,294 dirs scanned
 152 folders · 11.1 GB total · 2 selected (3.0 GB) · freed 0 B

            SIZE   AGE  TARGET            PATH
 ❯ [x]   1.73 GB   2mo  .next             Tagmango/tagmango-frontend/apps/web/.next
   [x]   1.26 GB   5mo  .next             Fleapo/the-dream-live-v2/.next
   [ ]   1.13 GB    7m  .turbo            Fleapo/itic-one/.turbo
   [ ]    889 MB   3mo  .next             Tagmango/fg-client/.next
   …
 ↑↓ move · space select · a all · d/⏎ delete · o open · s sort:size · q quit
```

Zero dependencies. Node 18+.

## Install

```bash
npm install -g buildkill
```

or run it once without installing:

```bash
npx buildkill ~/Desktop
```

Requires Node 18+.

## Usage

```
buildkill [dir] [options]            interactive (default: current directory)

  -t, --target <a,b,c>   folder names to look for (replaces the default list)
  -a, --add <a,b,c>      extra folder names on top of the defaults (e.g. node_modules)
  -N, --node-modules     also look for node_modules folders (npkill-style)
  -W, --worktrees        list whole Claude Code worktrees (.claude/worktrees/*), flagging
                         any with uncommitted changes; runs git worktree prune after deleting
      --all              also include Pods and .venv on top of node_modules
  -x, --exclude <a,b>    folder names or path fragments to skip
  -d, --depth <n>        how deep to descend (default: unlimited)
      --min-size <size>  only show folders at least this big       e.g. 100mb, 2gb
      --older-than <age> only show folders untouched for this long  e.g. 7d, 2w, 3mo
  -s, --sort <mode>      size (default) | age | path
      --full             show absolute paths instead of relative ones

  -l, --list             non-interactive: print what was found and exit
      --json             like --list, as JSON
  -y, --yes              non-interactive: delete EVERYTHING found (combine with filters!)
  -n, --dry-run          never delete, only show what would be deleted
      --targets          print the default target list and exit
```

Keys in interactive mode:

| key | action |
| --- | --- |
| `↑` `↓` / `j` `k` | move |
| `space` | select / unselect |
| `a` | select all / none |
| `d` / `Enter` / `Delete` | delete selected (asks `y/N` first) |
| `o` | reveal in Finder / file manager |
| `s` | cycle sort: size → age → path |
| `q` / `Esc` | quit |

Examples:

```bash
buildkill ~/Desktop/Fleapo                       # browse every project under a folder
buildkill -l --min-size 200mb                    # quick report of the big offenders
buildkill -t .next,.turbo -y --older-than 30d    # unattended cleanup of stale caches
buildkill -N                                     # include node_modules too (npkill-style)
buildkill ~ -N --older-than 30d                  # everything stale, including old node_modules
buildkill ~/Desktop -W                           # leftover Claude Code session worktrees
buildkill -n -y                                  # dry run: show what -y would delete
```

## What it deletes, and what it refuses to

Run `buildkill --targets` for the full list. In short:

- **Always**: framework caches whose names are unambiguous: `.next`, `.turbo`, `.nuxt`,
  `.svelte-kit`, `.astro`, `.angular`, `.parcel-cache`, `.vite`, `.expo`, `.dart_tool`,
  `__pycache__`, `.pytest_cache`, …
- **Only inside a project folder** (one with `package.json`, `build.gradle`, `Cargo.toml`,
  `pyproject.toml`, `Podfile`, …): generic names like `dist`, `build`, `out`, `coverage`,
  `.cache`, `target`, `storybook-static`. A `build` folder in `~/Documents` is never touched.
- **Opt-in**: `node_modules` with `-N` (or `--all`, which also adds `Pods` and `.venv`). These are
  regenerable but slow to restore, so they stay out of the default list. With `-N`, buildkill
  fully replaces npkill.
- **Claude Code worktrees** (`<repo>/.claude/worktrees/<session>`) are scanned like any other
  project, so the `node_modules` and `.next` a session left behind show up. With `-W` each
  worktree is listed whole instead; ones with uncommitted changes are flagged in red, and
  deleting one also runs `git worktree prune` in the parent repo.
- **Inside `node_modules`** only `.cache` and `.vite` are reported. It never recurses into
  `node_modules`, `vendor`, `venv`, `.git`, hidden folders, symlinks, or `~/Library`.
- Empty folders are hidden. Deletion refuses `/`, your home folder and the scan root.

Sizes are allocated disk blocks (what `du` reports), not apparent file sizes.
"AGE" is the newest file inside the folder, so a `.next` marked `5mo` really has not been built in five months.

## Alternatives

| tool | notes |
| --- | --- |
| `npx npkill -t .next,.turbo,dist` | npkill already supports custom targets, comma-separated. No notion of "safe to delete", so `dist` matches everywhere. |
| [kondo](https://github.com/tbillington/kondo) (Rust) | Multi-language artifact cleaner (Cargo, Gradle, Node, Python, Unity …). Doesn't know `.next` / `.turbo`. |
| [sweep](https://github.com/KitsuneKode/sweep), ZapDir | npkill-style TUIs covering `.next`, `dist`, `.turbo`. |
| `git clean -Xdn` / `-Xdf` | Per repo: removes everything gitignored. Careful, that includes `.env` files. |

## Feedback

If it's useful, a star on the repo helps and feel free to pass it on to other devs. Bugs, ideas, PRs, or if you want to work on it together: [open an issue](https://github.com/Avilash2001/buildkill/issues) or ping me.

## Development

```bash
git clone https://github.com/Avilash2001/buildkill.git
cd buildkill
npm test
npm install -g .   # link your local copy as the global command
```

MIT © Avilash Ghosh
