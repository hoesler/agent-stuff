#!/usr/bin/env node
// Regenerates pi/pstack from cursor/plugins. See pi/pstack/docs/harness/pi.md for the adapter it points at.
//
//   node scripts/generate-pstack.mjs [--ref <ref>] [--source <plugins-checkout>] [--check]

import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, posix, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
export const OUT = join(ROOT, "pi", "pstack");
const REPO = "https://github.com/cursor/plugins";
const COMMAND = "node scripts/generate-pstack.mjs";
// Hand-written and owned by this repo. Regeneration never touches it.
export const PRESERVED = "docs/harness";
export const ADAPTER = "docs/harness/pi.md";
const LOCAL_AGENTS = "docs/harness/agents";
const GUIDE = "docs/guide";
export const LINK = /\]\(([^)\s]+)\)/g;

// Upstream's list from scripts/generate-pstack-harness-trees.mjs, each tagged with the adapter section that answers it,
// plus the names pi lacks that Claude Code happens to share with Cursor.
export const TERMS = [
  { key: "`Task`", section: "Subagents", re: /`Task`|\bTask (tool|subagent|call)/ },
  { key: "`AskQuestion`", section: "Tools", re: /AskQuestion/ },
  { key: "todolist", section: "Tools", re: /\btodo ?list\b/i },
  { key: "`Grep`, `Glob`, `Read`", section: "Tools", re: /\bGrep\b|\bGlob\b|`Read`/ },
  { key: "subagent_type", section: "Subagents", re: /subagent_type/ },
  { key: "generalPurpose", section: "Subagents", re: /generalPurpose/ },
  { key: "poteto-agent", section: "Subagents", re: /poteto-agent/ },
  { key: "comment-sicko", section: "Subagents", re: /comment-sicko/ },
  { key: "`readonly: true`", section: "Subagents", re: /readonly: (true|false)|readonly\/Ask/ },
  { key: "`environment: \"cloud\"`", section: "Subagents", re: /environment: "(cloud|local)"/ },
  { key: "cloud_base_branch", section: "Subagents", re: /cloud_base_branch/ },
  { key: "`run_in_background: true`", section: "Subagents", re: /run_in_background/ },
  { key: "`resume`", section: "Subagents", re: /`resume`/ },
  { key: "`file_attachments`", section: "Subagents", re: /file_attachments/ },
  { key: "claude-", section: "Models", re: /\bclaude-[a-z]+-\d/ },
  { key: "grok-", section: "Models", re: /\bgrok-\d/ },
  { key: "gpt-", section: "Models", re: /\bgpt-\d/ },
  { key: "inherit-parent", section: "Models", re: /inherit-parent/ },
  { key: "pstack-models.mdc", section: "Models", re: /pstack-models\.mdc/ },
  { key: ".cursor/skills/", section: "Paths", re: /\.cursor\/skills/ },
  { key: "~/.cursor/plugins/", section: "Paths", re: /\.cursor\/plugins|\.cursor-plugin/ },
  { key: ".cursor/rules/", section: "Paths", re: /\.cursor\/rules|always-applied rule/ },
  { key: ".cursor/worktrees/", section: "Paths", re: /\.cursor\/worktrees/ },
  { key: "agent-transcripts", section: "Paths", re: /agent-transcripts|\.cursor\/projects/ },
  { key: "`/loop`", section: "Skills outside pstack", re: /\/loop\b/ },
  { key: "create-skill", section: "Skills outside pstack", re: /\bcreate-skill\b/ },
  { key: "cursor-team-kit", section: "Skills outside pstack", re: /cursor-team-kit|\bdeslop\b|\bcontrol-(cli|ui)\b/ },
  { key: "Cursor-only features", section: "Cursor-only features", re: /Bugbot|Cursor [Aa]utomation|cursor\.(sh|com)\/automations|[Cc]loud [Aa]gent|built-in PR tool/ },
];
export const ROUTE = { key: "Run another pstack skill", section: "Tools" };
// The order the adapter presents its sections in, so a pointer lists them the same way.
export const SECTIONS = ["Tools", "Subagents", "Models", "Paths", "Skills outside pstack", "Cursor-only features"];

export function walk(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((name) => {
    if (name === ".DS_Store" || name === "node_modules") return [];
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
}

function file(path) {
  return { bytes: readFileSync(path), executable: (statSync(path).mode & 0o111) !== 0 };
}

function text(bytes) {
  return { bytes: Buffer.from(bytes), executable: false };
}

/** The adapter sections a skill's Markdown needs, given the names of its sibling skills. */
export function sectionsFor(markdown, others) {
  const found = new Set();
  for (const term of TERMS) if (term.re.test(markdown)) found.add(term);
  if (others.length > 0) {
    const route = new RegExp(`the \\*\\*(?<bold>${others.join("|")})\\*\\* skill|\`/(?<command>${others.join("|")})\``, "g");
    const bare = markdown.split("\n").some((line) =>
      [...line.matchAll(route)].some(({ groups }) => !line.includes(`(../${groups.bold ?? groups.command}/`)),
    );
    if (bare) found.add(ROUTE);
  }
  return found;
}

/** `adapter` is how the reader reaches the adapter: a relative link from a skill, a `<pstack>` path from a persona. */
export function pointer(adapter, kind, sections) {
  const names = SECTIONS.filter((name) => [...sections].some((term) => term.section === name));
  return (
    `In pi, read ${adapter} once per session before you follow this ${kind}. ` +
    `It maps the Cursor names in pstack to pi. Sections that apply here: ${names.join(", ")}.`
  );
}

/** Put `line` under the first H1, or straight after the frontmatter when there is none. */
export function insertPointer(markdown, line) {
  if (/^# /m.test(markdown)) return markdown.replace(/^(# .*)\n+/m, `$1\n\n${line}\n\n`);
  return markdown.replace(/^(---\n[\s\S]*?\n---\n)\n*/, `$1\n${line}\n\n`);
}

/** Upstream personas carry Cursor fields. The subagent extension reads `name`, `description`, `tools`, `model`, `promote`. */
export function toPersona(markdown) {
  const [, frontmatter, body] = markdown.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/) ?? [];
  if (frontmatter === undefined) throw new Error("persona has no frontmatter");
  const kept = frontmatter.split("\n").filter((line) => /^(name|description):/.test(line));
  return `---\n${kept.join("\n")}\n---\n${body}`;
}

// The pstack-relative path a relative link in `from` points at, if it exists upstream.
function resolveUpstream(pstack, from, href) {
  const target = href.replace(/[#?].*/, "");
  if (!target || /^[a-z][a-z0-9+.-]*:/i.test(target)) return undefined;
  const path = posix.join(posix.dirname(from), target).replace(/\/$/, "");
  return existsSync(join(pstack, path)) ? path : undefined;
}

/** Relative links in `files` (tree-relative path → entry) that point at nothing in `has`. */
export function danglingLinks(files, has) {
  const dangling = [];
  for (const [path, entry] of files) {
    if (!path.endsWith(".md")) continue;
    for (const [, href] of entry.bytes.toString("utf8").matchAll(LINK)) {
      const target = href.replace(/[#?].*/, "");
      // A target with no `/` and no `.` is template text, such as `[PR #123](url)`, not a path.
      if (!/[/.]/.test(target) || /^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith("/")) continue;
      const resolved = posix.join(posix.dirname(path), target).replace(/\/$/, "");
      if (!has(resolved)) dangling.push(`${path} links to ${href}`);
    }
  }
  return dangling;
}

function render(pstack, upstream) {
  const skillsDir = join(pstack, "skills");
  const skills = readdirSync(skillsDir).filter((name) => existsSync(join(skillsDir, name, "SKILL.md"))).sort();
  const files = new Map();
  for (const path of [...walk(skillsDir), ...walk(join(pstack, GUIDE)), join(pstack, "README.md"), join(pstack, "LICENSE")]) {
    files.set(relative(pstack, path), file(path));
  }

  const used = new Map();
  for (const skill of skills) {
    const others = skills.filter((name) => name !== skill);
    const markdown = walk(join(skillsDir, skill))
      .filter((path) => path.endsWith(".md"))
      .map((path) => readFileSync(path, "utf8"))
      .join("\n");
    const sections = sectionsFor(markdown, others);
    for (const term of sections) used.set(term.key, [...(used.get(term.key) ?? []), skill]);
    if (sections.size === 0) continue;
    const entry = files.get(`skills/${skill}/SKILL.md`);
    entry.bytes = Buffer.from(insertPointer(entry.bytes.toString("utf8"), pointer(`[the pi adapter](../../${ADAPTER})`, "skill", sections)));
  }

  for (const path of walk(join(pstack, "agents")).filter((path) => path.endsWith(".md"))) {
    const markdown = readFileSync(path, "utf8");
    const sections = sectionsFor(markdown, skills);
    for (const term of sections) used.set(term.key, [...(used.get(term.key) ?? []), relative(pstack, path)]);
    // A persona is a system prompt, not a file, so a relative link means nothing there. `<pstack>` is the path the extension puts in every prompt.
    const persona = toPersona(markdown);
    const line = pointer(`the pi adapter at \`<pstack>/${ADAPTER}\``, "persona", sections);
    files.set(relative(pstack, path), text(sections.size ? insertPointer(persona, line) : persona));
  }
  for (const path of walk(join(OUT, LOCAL_AGENTS)).filter((path) => path.endsWith(".md"))) {
    files.set(`agents/${relative(join(OUT, LOCAL_AGENTS), path)}`, file(path));
  }

  for (const [path, entry] of files) {
    if (!path.endsWith(".md")) continue;
    entry.bytes = Buffer.from(
      entry.bytes.toString("utf8").replace(LINK, (link, href) => {
        const target = resolveUpstream(pstack, path, href);
        if (!target || target.split("/")[0] === ".." || [...files.keys()].some((key) => key === target || key.startsWith(`${target}/`))) return link;
        const kind = statSync(join(pstack, target)).isDirectory() ? "tree" : "blob";
        return `](${REPO}/${kind}/${upstream.commit}/pstack/${target}${href.slice(href.search(/[#?]|$/))})`;
      }),
    );
  }

  files.set(
    "UPSTREAM",
    text(
      `repo: ${REPO}\npath: pstack\ncommit: ${upstream.commit}\ndate: ${upstream.date}\n\n` +
        `Everything here except ${PRESERVED}/ is generated. Do not edit it by hand. Run \`${COMMAND}\` and commit the result.\n`,
    ),
  );
  return { files, used, skills };
}

function git(cwd, ...args) {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] }).trim();
}

function fetchUpstream(ref) {
  const dir = mkdtempSync(join(tmpdir(), "pstack-"));
  git(dir, "init", "--quiet");
  git(dir, "remote", "add", "origin", `${REPO}.git`);
  git(dir, "sparse-checkout", "set", "pstack");
  git(dir, "fetch", "--quiet", "--depth", "1", "--filter=blob:none", "origin", ref);
  git(dir, "checkout", "--quiet", "FETCH_HEAD");
  return dir;
}

function main(argv) {
  const option = (name) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : undefined);
  const source = option("--source") ?? fetchUpstream(option("--ref") ?? "main");
  const upstream = { commit: git(source, "rev-parse", "HEAD"), date: git(source, "log", "-1", "--format=%cs") };
  const { files, used, skills } = render(join(source, "pstack"), upstream);
  if (!option("--source")) rmSync(source, { recursive: true, force: true });

  const problems = [];
  const adapter = readFileSync(join(OUT, ADAPTER), "utf8");
  for (const [key, users] of used) if (!adapter.includes(key)) problems.push(`the pi adapter has no row for ${key}, used by ${users.join(", ")}`);
  for (const name of SECTIONS) if (!adapter.includes(`## ${name}\n`)) problems.push(`the pi adapter has no "## ${name}" section`);
  const preserved = new Map(walk(join(OUT, PRESERVED)).map((path) => [relative(OUT, path), file(path)]));
  const all = new Set([...files.keys(), ...preserved.keys()]);
  const has = (path) => all.has(path) || [...all].some((key) => key.startsWith(`${path}/`));
  problems.push(...danglingLinks(new Map([...files, ...preserved]), has).map((link) => `${link}, which is not in pi/pstack`));
  for (const problem of problems) console.log(`FAIL ${problem}`);
  if (problems.length > 0) process.exit(1);

  const onDisk = new Map(walk(OUT).map((path) => [relative(OUT, path), file(path)]).filter(([path]) => !path.startsWith(`${PRESERVED}/`)));
  if (argv.includes("--check")) {
    const drifted = [...new Set([...files.keys(), ...onDisk.keys()])].sort().filter((path) => {
      const [want, have] = [files.get(path), onDisk.get(path)];
      return !want || !have || !want.bytes.equals(have.bytes) || want.executable !== have.executable;
    });
    for (const path of drifted.slice(0, 20)) console.log(`pi/pstack/${path}`);
    if (drifted.length > 0) {
      console.log(`pi/pstack is out of date with ${upstream.commit}. Run \`${COMMAND}\` and commit the result.`);
      process.exit(1);
    }
    console.log(`pi/pstack is up to date with ${upstream.commit}.`);
    return;
  }
  for (const path of onDisk.keys()) rmSync(join(OUT, path));
  for (const [path, { bytes, executable }] of files) {
    mkdirSync(dirname(join(OUT, path)), { recursive: true });
    writeFileSync(join(OUT, path), bytes);
    chmodSync(join(OUT, path), executable ? 0o755 : 0o644);
  }
  for (const dir of walkDirs(OUT).reverse()) if (readdirSync(dir).length === 0) rmSync(dir, { recursive: true });
  const pointed = [...files.keys()].filter((path) => /^skills\/[^/]+\/SKILL\.md$/.test(path) && files.get(path).bytes.includes("[the pi adapter]")).length;
  console.log(`pstack ${upstream.commit}: ${skills.length} skills, ${pointed} with the pi adapter pointer`);
}

function walkDirs(dir) {
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .flatMap((entry) => [join(dir, entry.name), ...walkDirs(join(dir, entry.name))]);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main(process.argv.slice(2));
