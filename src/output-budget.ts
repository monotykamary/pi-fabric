import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { truncateMiddle } from "./util.js";

export const MAX_FAILURE_MODEL_OUTPUT_CHARS = 20_000;

export const modelOutputBudget = (
  configuredMaxChars: number,
  success: boolean,
): number => success
  ? configuredMaxChars
  : Math.min(configuredMaxChars, MAX_FAILURE_MODEL_OUTPUT_CHARS);

export interface BoundedModelOutput {
  text: string;
  artifactPath?: string;
  originalChars: number;
  omittedChars: number;
}

type ArtifactWriter = (content: string) => Promise<string>;

const writeOutputArtifact: ArtifactWriter = async (content) => {
  const directory = await mkdtemp(path.join(tmpdir(), "pi-fabric-output-"));
  const artifactPath = path.join(directory, "output.txt");
  await writeFile(artifactPath, content, { encoding: "utf8", mode: 0o600 });
  return artifactPath;
};

export const boundModelOutput = async (
  visible: string,
  maxChars: number,
  fullOutput = visible,
  writeArtifact: ArtifactWriter = writeOutputArtifact,
): Promise<BoundedModelOutput> => {
  if (visible.length <= maxChars && fullOutput.length <= maxChars) {
    return { text: visible, originalChars: fullOutput.length, omittedChars: 0 };
  }

  let artifactPath: string | undefined;
  try {
    artifactPath = await writeArtifact(fullOutput);
  } catch {
    artifactPath = undefined;
  }
  const suffix = artifactPath
    ? `\n\n[Full output (${fullOutput.length} chars) saved to: ${artifactPath}]`
    : "";
  const bodyBudget = Math.max(1, maxChars - suffix.length);
  const body = truncateMiddle(visible, bodyBudget);
  let text = `${body}${suffix}`;
  if (text.length > maxChars) {
    // The suffix carries the artifact path; shrink the body again instead of
    // cutting into the path. A truncation marker can itself exceed a tiny
    // rebudget, so fall back to the bare suffix (or its tail), which always
    // fits and still ends with the path.
    const rebudget = maxChars - suffix.length;
    if (rebudget <= 0) {
      text = suffix.slice(-Math.max(1, maxChars));
    } else {
      const shrunk = truncateMiddle(body, rebudget);
      text = shrunk.length + suffix.length <= maxChars ? `${shrunk}${suffix}` : suffix;
    }
  }
  return {
    text,
    ...(artifactPath ? { artifactPath } : {}),
    originalChars: fullOutput.length,
    omittedChars: Math.max(0, fullOutput.length - Math.min(fullOutput.length, bodyBudget)),
  };
};
