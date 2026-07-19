import { type Skill } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { restoreSkillsForFullCodePrompt } from "../src/core/skill-prompt.js";

const makeSkill = (
  input: Pick<Skill, "name" | "description" | "filePath"> & Partial<Skill>,
): Skill => ({
  baseDir: `/skills/${input.name}`,
  sourceInfo: {} as Skill["sourceInfo"],
  disableModelInvocation: false,
  ...input,
});

const skills: Skill[] = [
  makeSkill({
    name: "release-risk",
    description: "Review launch plans for operational risk.",
    filePath: "/skills/release-risk/SKILL.md",
  }),
  makeSkill({
    name: "manual-only",
    description: "Run only when explicitly invoked.",
    filePath: "/skills/manual-only/SKILL.md",
    disableModelInvocation: true,
  }),
];

const occurrences = (value: string, search: string): number =>
  value.split(search).length - 1;

describe("full code skill prompt", () => {
  it("restores Pi's skill catalog before the working directory", () => {
    const prompt = restoreSkillsForFullCodePrompt(
      "Core prompt\nCurrent working directory: /workspace",
      skills,
    );

    expect(prompt).toContain(
      "Use `pi.read` inside `fabric_exec` to load a skill's file when the task matches its description.",
    );
    expect(prompt).toContain("<name>release-risk</name>");
    expect(prompt).not.toContain("manual-only");
    expect(prompt.indexOf("<available_skills>")).toBeLessThan(
      prompt.indexOf("Current working directory:"),
    );
  });

  it("uses Pi's XML escaping for model-visible skill metadata", () => {
    const prompt = restoreSkillsForFullCodePrompt(
      "Core prompt",
      [makeSkill({
        name: "review",
        description: 'Review <plans> & "risks".',
        filePath: "/skills/a&b/SKILL.md",
      })],
    );

    expect(prompt).toContain("Review &lt;plans&gt; &amp; &quot;risks&quot;.");
    expect(prompt).toContain("/skills/a&amp;b/SKILL.md");
  });

  it("adapts an existing Pi skill section instead of duplicating it", () => {
    const original = [
      "Core prompt",
      "The following skills provide specialized instructions for specific tasks.",
      "Use the read tool to load a skill's file when the task matches its description.",
      "<available_skills>",
      "  <skill><name>release-risk</name></skill>",
      "</available_skills>",
      "Current working directory: /workspace",
    ].join("\n");

    const prompt = restoreSkillsForFullCodePrompt(original, skills);

    expect(occurrences(prompt, "<available_skills>")).toBe(1);
    expect(prompt).not.toContain("Use the read tool to load a skill");
    expect(prompt).toContain("Use `pi.read` inside `fabric_exec`");
  });

  it("leaves the prompt unchanged when every skill requires explicit invocation", () => {
    const prompt = "Core prompt\nCurrent working directory: /workspace";
    expect(
      restoreSkillsForFullCodePrompt(prompt, [skills[1]!]),
    ).toBe(prompt);
  });

  it("appends the catalog when a custom prompt has no working-directory marker", () => {
    const prompt = restoreSkillsForFullCodePrompt("Custom prompt", skills);

    expect(prompt.startsWith("Custom prompt\n\nThe following skills")).toBe(true);
    expect(prompt).toContain("<available_skills>");
  });
});
