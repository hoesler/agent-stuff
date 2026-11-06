import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, it } from "node:test";
import {
  ADAPTER,
  danglingLinks,
  insertPointer,
  OUT,
  pinned,
  pointer,
  SECTIONS,
  sectionsFor,
  TERMS,
  toPersona,
  walk,
} from "./generate-pstack.mjs";

const POINTER = /^In pi, read .*\n\n/m;
const skills = readdirSync(join(OUT, "skills")).filter((name) => existsSync(join(OUT, "skills", name, "SKILL.md")));

describe("the generated pi/pstack tree", () => {
  it("has no relative link that points at nothing", () => {
    const paths = walk(OUT).map((path) => relative(OUT, path));
    const all = new Set(paths);
    const has = (path) => all.has(path) || paths.some((key) => key.startsWith(`${path}/`));
    const files = new Map(paths.map((path) => [path, { bytes: readFileSync(join(OUT, path)) }]));
    assert.deepEqual(danglingLinks(files, has), []);
  });

  it("points every skill that uses a Cursor name at the adapter sections it needs", () => {
    for (const skill of skills) {
      const dir = join(OUT, "skills", skill);
      const markdown = walk(dir)
        .filter((path) => path.endsWith(".md"))
        .map((path) => readFileSync(path, "utf8").replace(POINTER, ""))
        .join("\n");
      const sections = sectionsFor(markdown, skills.filter((name) => name !== skill));
      const text = readFileSync(join(dir, "SKILL.md"), "utf8");
      if (sections.size === 0) assert.doesNotMatch(text, POINTER, skill);
      else assert.ok(text.includes(pointer(`[the pi adapter](../../${ADAPTER})`, "skill", sections)), skill);
    }
  });

  it("has an adapter row for every term and a heading for every section", () => {
    const adapter = readFileSync(join(OUT, ADAPTER), "utf8");
    for (const { key } of TERMS) assert.ok(adapter.includes(key), key);
    for (const name of SECTIONS) assert.ok(adapter.includes(`## ${name}\n`), name);
  });

  it("ships the four personas setup installs, none with a model", () => {
    const agents = readdirSync(join(OUT, "agents")).sort();
    assert.deepEqual(agents, ["comment-sicko.md", "poteto-agent.md", "pstack-general.md", "pstack-readonly.md"]);
    for (const agent of agents) {
      const frontmatter = readFileSync(join(OUT, "agents", agent), "utf8").match(/^---\n([\s\S]*?)\n---/)[1];
      assert.match(frontmatter, new RegExp(`^name: ${agent.replace(/\.md$/, "")}$`, "m"));
      assert.doesNotMatch(frontmatter, /^model:/m);
    }
    assert.match(readFileSync(join(OUT, "agents", "pstack-readonly.md"), "utf8"), /^tools: (?!.*\b(edit|write)\b).*$/m);
  });
});

describe("generator helpers", () => {
  it("puts the pointer under the H1, or after the frontmatter without one", () => {
    assert.equal(insertPointer("---\nname: a\n---\n\n# A\n\nBody\n", "P"), "---\nname: a\n---\n\n# A\n\nP\n\nBody\n");
    assert.equal(insertPointer("---\nname: a\n---\n\nBody\n", "P"), "---\nname: a\n---\n\nP\n\nBody\n");
  });

  it("reads the pinned commit from UPSTREAM", () => {
    const sha = "8b3326d99fd4b993cb33a24dad8af03175c642c5";
    assert.equal(pinned(`repo: x\npath: pstack\ncommit: ${sha}\ndate: 2026-10-22\n`), sha);
    assert.throws(() => pinned("repo: x\n"), /pins no commit/);
  });

  it("keeps only the persona fields the subagent extension reads", () => {
    assert.equal(toPersona("---\nname: a\ndescription: b\nis_background: true\n---\n\nBody\n"), "---\nname: a\ndescription: b\n---\n\nBody\n");
  });

  it("flags a bare route to a sibling skill but not a linked one", () => {
    const route = (markdown) => [...sectionsFor(markdown, ["how"])].map(({ key }) => key);
    assert.deepEqual(route("Run the **how** skill."), ["Run another pstack skill"]);
    assert.deepEqual(route("Run the **how** skill ([how](../how/SKILL.md))."), []);
  });

  it("ignores template placeholders and URLs when checking links", () => {
    const files = new Map([["a.md", { bytes: Buffer.from("[x](url) [y](https://e.com) [z](b.md) [w](missing.md)") }]]);
    assert.deepEqual(danglingLinks(files, (path) => path === "b.md"), ["a.md links to missing.md"]);
  });
});
