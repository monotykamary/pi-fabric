import { describe, expect, it } from "vitest";
import { fabricExecTitleHint } from "../src/ui/fabric-code-parser.js";
import { fabricExecTitleHintCached } from "../src/ui/fabric-title-hint.js";

const cases: [name: string, code: string, expected: string | undefined][] = [
  [
    "single read",
    "return await pi.read({ path: 'src/ui/fabric-code-parser.ts', offset: 1, limit: 80 });",
    "Read fabric-code-parser.ts",
  ],
  [
    "grep lexeme plus read",
    "const [h, c] = await Promise.all([pi.grep({ pattern: 'fallback', path: 'src', limit: 20 }), pi.read({ path: 'src/config.ts', offset: 520, limit: 60 })]); return { h, c };",
    "Search \"fallback\" in src + Read config.ts",
  ],
  [
    "coalesced edit",
    "await pi.edit({ path: 'src/config.ts', edits: [{ old: \"a\", new: \"b\" }] }); return 'ok';",
    "Edit config.ts",
  ],
  [
    "write via named string",
    "const r = await pi.write({ path: 'src/ui/title.ts', text: π.title }); return r.output;",
    "Write title.ts",
  ],
  [
    "bash command",
    "return await pi.bash({ cmd: 'pnpm run check', timeout: 180 });",
    "Shell pnpm run check",
  ],
  [
    "long bash command clipped",
    "return await pi.bash({ cmd: 'pnpm vitest run src/ui/title.test.ts', settle: true });",
    "Shell pnpm vitest run src/ui/title.…",
  ],
  [
    "mcp call",
    "return await mcp.github.get_issue({ owner: 'x', repo: 'y', issue_number: 12 });",
    "Mcp github.get_issue",
  ],
  [
    "memory pair collapses on shared key",
    "await memory.set({ key: 'plan', value: v }); return await memory.get({ key: 'plan' });",
    "Memory plan ×2",
  ],
  [
    "distinct same-verb targets collapse to a count",
    "const [a, b, c] = await Promise.all([pi.read('/x/a.ts'), pi.read('/x/b.ts'), pi.read('/x/c.ts')]); return [a, b, c];",
    "Read a.ts +2",
  ],
  [
    "segment assembly stops at the char budget",
    `const g = await pi.grep({ pattern: 'renderCall', path: 'src/fabric-exec-tool.ts' });
const r = await pi.read({ path: 'src/fabric-exec-tool.ts', offset: 240, limit: 30 });
await pi.edit({ path: 'src/fabric-exec-tool.ts', edits: [{ old: 'x', new: 'y' }] });
const b = await pi.bash({ cmd: 'pnpm run build', timeout: 120 });
return { g, r, b };`,
    "Search \"renderCall\" in fabric-exec-tool.ts + Read fabric-exec-tool.ts +…",
  ],
  [
    "search sweep keeps first-occurrence order under one verb",
    "return await Promise.all([pi.grep({pattern:'TODO',path:'src'}), pi.find({pattern:'*.ts',path:'src'}), pi.ls('src')]);",
    "Search \"TODO\" in src +2",
  ],
  [
    "bare directory qualifies a grep",
    "return await pi.grep({ pattern: 'TODO', path: 'src', ignoreCase: true });",
    "Search \"TODO\" in src",
  ],
  [
    "agent task clipped as target",
    "return await agents({ task: 'fix the lint errors in src/ui' });",
    "Agent fix the lint errors in src/ui",
  ],
  [
    "tools discovery counted",
    "const d = await tools.search({ query: 'github issues' }); return await tools.call({ ref: d[0].ref, args: {} });",
    "Tools ×2",
  ],
  [
    "regex pattern never quoted, path wins",
    "return await pi.grep({ pattern: '\\\\.name\\\\?\\\\.trim', path: 'src/fabric-exec-tool.ts', limit: 5 });",
    "Search fabric-exec-tool.ts",
  ],
  [
    "glob head with directory qualifier",
    "return await pi.find({ pattern: '*.test.ts', path: 'src/ui', limit: 10 });",
    "Search *.test.ts in src/ui",
  ],
  [
    "no fabric calls stays neutral",
    "const xs = [1, 2, 3]; return xs.reduce((a, b) => a + b, 0);",
    undefined,
  ],
  [
    "aliased calls are statically invisible",
    "const t = { r: pi.read }; return await t.r('src/config.ts');",
    undefined,
  ],
  [
    "dynamic template yields no target",
    'return await pi.bash({ cmd: `pnpm vitest run ${name}.test.ts` });',
    "Shell",
  ],
  [
    "comments are never counted",
    "// pi.write({ path: 'nope.ts' })\n/* pi.bash({ cmd: 'rm -rf /' }) */\nreturn await pi.read({ path: 'src/real.ts' });",
    "Read real.ts",
  ],
  [
    "unknown pi verb is humanized",
    "return await pi.forgeWorkspace({ path: 'src/x.ts' });",
    "Forge Workspace x.ts",
  ],
  [
    "named-string payload never surfaces",
    "const md = π['docs/secret.md']; return await pi.bash({ cmd: 'ls' });",
    "Shell ls",
  ],
];

describe("fabricExecTitleHint", () => {
  for (const [name, code, expected] of cases) {
    it(name, () => {
      expect(fabricExecTitleHint(code)).toBe(expected);
    });
  }
});

describe("Python title hints", () => {
  const pythonCases: [string, string | undefined][] = [
    ['return await pi.read(path="src/config.ts")', "Read config.ts"],
    ['return await pi.read({"path": "src/config.ts"})', "Read config.ts"],
    ['return await pi.read("src/config.ts")', "Read config.ts"],
    ['await pi.grep(pattern="fallback", path="src")\nreturn await pi.read("src/config.ts")', 'Search "fallback" in src + Read config.ts'],
    ['await pi.write(path="src/title.py", text=π.body)', "Write title.py"],
    ['await pi.bash(cmd="bun run check")', "Shell bun run check"],
    ['return await agents(task="Fix the failing tests")', "Agent Fix the failing tests"],
    ['await memory.set(key="plan", value=True)\nreturn await memory.get(key="plan")', "Memory plan ×2"],
    ['return await mcp.github.get_issue(owner="x")', "Mcp github.get_issue"],
    ['# pi.bash("not executed")\nreturn 1', undefined],
    ['"""pi.read("fake.ts")"""\nreturn await pi.read("real.ts")', "Read real.ts"],
    ["'''pi.bash(\"fake\")'''\nreturn 1", undefined],
    ['await pi.bash(cmd=f"echo {name}")', "Shell"],
    ['await pi.bash(cmd=f"{pi.read(\"fake.ts\")}")', "Shell"],
    ['await pi.bash(cmd=rf"echo {name}")', "Shell"],
    ['return await pi.read(r"src/config.ts")', "Read config.ts"],
    ['return await pi.read(u"src/config.ts")', "Read config.ts"],
    ['await pi.bash(cmd="""bun run check\nbun run build""")', "Shell bun run check"],
    ['return await pi.read(π["secret.ts"])', "Read"],
    ['n = 4 // 2\nreturn await pi.read("real.ts")', "Read real.ts"],
    ['return sum([1, 2])', undefined],
  ];
  it.each(pythonCases)("infers %s", (code, expected) => {
    expect(fabricExecTitleHint(code, "python")).toBe(expected);
    expect(fabricExecTitleHintCached(code, "python")).toBe(expected);
    expect(fabricExecTitleHintCached(code, "python")).toBe(expected);
  });

  it.each([
    [String.raw`await pi.read("src/\u0063onfig.ts")`, "Read config.ts"],
    [String.raw`await pi.read("src/\U00000063onfig.ts")`, "Read config.ts"],
    [String.raw`await pi.read("src/\143onfig.ts")`, "Read config.ts"],
    [String.raw`await pi.bash(cmd=r"echo \n")`, String.raw`Shell echo \n`],
    [String.raw`await pi.bash(cmd="echo \q")`, String.raw`Shell echo \q`],
    [String.raw`await pi.read("\Uffffffff")`, "Read"],
    [String.raw`await pi.read("\u{ffffff}")`, "Read"],
    [String.raw`await pi.read("\N{LATIN SMALL LETTER A}.ts")`, "Read"],
  ])("decodes Python escapes conservatively: %s", (code, expected) => {
    expect(fabricExecTitleHint(code, "python")).toBe(expected);
  });

  it("isolates cache entries by kernel", () => {
    const code = '# pi.bash("not executed")\nreturn 1';
    expect(fabricExecTitleHintCached(code, "typescript")).toBe("Shell not executed");
    expect(fabricExecTitleHintCached(code, "python")).toBeUndefined();
    expect(fabricExecTitleHintCached(code, "typescript")).toBe("Shell not executed");
  });
});

describe("fabricExecTitleHintCached", () => {
  for (const [name, code, expected] of cases) {
    it(`mirrors the pure hint: ${name}`, () => {
      expect(fabricExecTitleHintCached(code)).toBe(expected);
      expect(fabricExecTitleHintCached(code)).toBe(expected);
    });
  }
});
