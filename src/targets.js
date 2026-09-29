// Folder names buildkill looks for.
//
//   group:   'cache' | 'build' | 'deps'   (deps is opt-in via --all or -a)
//   project: true  → only reported when the *parent* directory looks like a
//                    project (has package.json, build.gradle, Cargo.toml, …).
//                    This keeps generic names like "dist" or "build" from
//                    matching random folders in ~/Documents.

export const TARGETS = [
  // ── JS / TS framework caches (name is unique enough to always be safe) ──
  { name: '.next',            group: 'cache', desc: 'Next.js build output + Turbopack / webpack cache' },
  { name: '.turbo',           group: 'cache', desc: 'Turborepo local task cache' },
  { name: '.nuxt',            group: 'cache', desc: 'Nuxt build' },
  { name: '.svelte-kit',      group: 'cache', desc: 'SvelteKit build' },
  { name: '.astro',           group: 'cache', desc: 'Astro cache' },
  { name: '.angular',         group: 'cache', desc: 'Angular CLI cache' },
  { name: '.parcel-cache',    group: 'cache', desc: 'Parcel cache' },
  { name: '.vite',            group: 'cache', desc: 'Vite cache (usually inside node_modules)' },
  { name: '.expo',            group: 'cache', desc: 'Expo / Metro cache' },
  { name: '.docusaurus',      group: 'cache', desc: 'Docusaurus cache' },
  { name: '.dart_tool',       group: 'cache', desc: 'Dart / Flutter tool cache' },
  { name: '__pycache__',      group: 'cache', desc: 'Python bytecode' },
  { name: '.pytest_cache',    group: 'cache', desc: 'pytest cache' },
  { name: '.mypy_cache',      group: 'cache', desc: 'mypy cache' },
  { name: '.ruff_cache',      group: 'cache', desc: 'ruff cache' },

  // ── generic names: only inside a project directory ──
  { name: '.cache',           group: 'cache', project: true, desc: 'Tool cache (Gatsby, Parcel, ESLint, babel-loader, …)' },
  { name: '.output',          group: 'build', project: true, desc: 'Nuxt / Nitro output' },
  { name: '.serverless',      group: 'build', project: true, desc: 'Serverless Framework packaging' },
  { name: '.webpack',         group: 'build', project: true, desc: 'serverless-webpack output' },
  { name: 'dist',             group: 'build', project: true, desc: 'Build output' },
  { name: 'build',            group: 'build', project: true, desc: 'Build output (also Gradle / Flutter)' },
  { name: 'out',              group: 'build', project: true, desc: 'Next.js static export' },
  { name: 'coverage',         group: 'build', project: true, desc: 'Test coverage reports' },
  { name: 'storybook-static', group: 'build', project: true, desc: 'Storybook static build' },
  { name: '.gradle',          group: 'cache', project: true, desc: 'Gradle per-project cache' },
  { name: 'target',           group: 'build', project: true, desc: 'Rust (cargo) / Maven build' },

  // ── dependencies: regenerable but slow to restore → opt-in ──
  { name: 'node_modules',     group: 'deps',  desc: 'npm / pnpm / yarn / bun dependencies (npkill territory)' },
  { name: 'Pods',             group: 'deps',  project: true, desc: 'CocoaPods (re-run pod install)' },
  { name: '.venv',            group: 'deps',  desc: 'Python virtualenv' },
  { name: 'venv',             group: 'deps',  project: true, desc: 'Python virtualenv' },

  // ── whole checkouts: not regenerable if they hold uncommitted work → opt-in ──
  { name: 'worktree',         group: 'worktrees', virtual: true, desc: 'Claude Code session worktree (.claude/worktrees/*), the whole checkout' },
];

// Claude Code keeps per-session git worktrees here, inside each repo.
export const CLAUDE_DIR = '.claude';
export const CLAUDE_WORKTREES_DIR = 'worktrees';

// Inside node_modules we never recurse (that's npkill's job), but these
// direct children are pure caches and are often gigabytes.
export const NODE_MODULES_CACHES = ['.cache', '.vite'];

// A directory "looks like a project" if it contains one of these.
export const PROJECT_MARKERS = new Set([
  'package.json', 'pnpm-workspace.yaml', 'turbo.json', 'nx.json', 'lerna.json',
  'deno.json', 'deno.jsonc', 'bun.lockb', 'tsconfig.json', 'angular.json',
  'build.gradle', 'build.gradle.kts', 'settings.gradle', 'settings.gradle.kts',
  'Podfile', 'pubspec.yaml', 'Cargo.toml', 'pom.xml', 'go.mod',
  'pyproject.toml', 'setup.py', 'setup.cfg', 'requirements.txt', 'Pipfile',
  'composer.json', 'Gemfile', 'mix.exs', 'Makefile', 'CMakeLists.txt',
]);
export const PROJECT_MARKER_EXTS = ['.xcodeproj', '.xcworkspace', '.csproj', '.sln', '.fsproj'];

export function defaultTargets({ all = false } = {}) {
  return TARGETS.filter((t) => t.group === 'cache' || t.group === 'build' || (all && t.group === 'deps'));
}

/**
 * Resolve the CLI's -t / -a / --all flags into a concrete target list.
 * Names that are not in TARGETS become custom, always-matched targets.
 */
export function resolveTargets({ target, add, all, nodeModules, worktrees } = {}) {
  const byName = new Map(TARGETS.map((t) => [t.name, t]));
  const split = (s) => (s ? s.split(',').map((x) => x.trim()).filter(Boolean) : []);
  const custom = (name) => byName.get(name) ?? { name, group: 'custom', desc: 'custom target' };

  let list = target ? split(target).map(custom) : defaultTargets({ all });
  for (const name of split(add)) {
    if (!list.some((t) => t.name === name)) list.push(custom(name));
  }
  if (nodeModules && !list.some((t) => t.name === 'node_modules')) list.push(byName.get('node_modules'));
  if (worktrees && !list.some((t) => t.name === 'worktree')) list.push(byName.get('worktree'));
  return list;
}

export function describeTargets() {
  const w = Math.max(...TARGETS.map((t) => t.name.length));
  const lines = [];
  const labels = {
    deps: 'deps  (opt-in: -N / --node-modules, --all, or -a <name>)',
    worktrees: 'worktrees  (opt-in: -W / --worktrees)',
  };
  for (const group of ['cache', 'build', 'deps', 'worktrees']) {
    lines.push('');
    lines.push(labels[group] ?? group);
    for (const t of TARGETS.filter((t) => t.group === group)) {
      const scope = t.virtual ? '.claude/worktrees' : t.project ? 'project dirs only' : 'anywhere         ';
      lines.push(`  ${t.name.padEnd(w)}  ${scope}  ${t.desc}`);
    }
  }
  return lines.join('\n').trimStart();
}
