import type { FabricTypeError } from "./runtime/type-checker.js";

const SYNTAX_ERROR_PATTERN = /expected|unterminated|unexpected|invalid character/i;
const PAYLOAD_CALL_PATTERN = /\bpi\.(?:edit|write)\s*\(/;
const BASH_CALL_PATTERN = /\bpi\.bash\s*\(/;

const unsupportedBashOption = (
  errors: FabricTypeError[],
  option: "cwd" | "stdin",
): boolean => errors.some((error) =>
  error.message.includes(
    `'${option}' does not exist in type 'PiCommandArgument & PiBashOptions'`,
  )
);

export const typeErrorRecoveryHint = (
  code: string,
  errors: FabricTypeError[],
): string | undefined => {
  if (BASH_CALL_PATTERN.test(code)) {
    const hints: string[] = [];
    if (unsupportedBashOption(errors, "cwd")) {
      hints.push(
        'Recovery hint: `pi.bash` does not accept `cwd`. Put the directory change in the command, for example `await pi.bash("cd <dir> && <command>")`.',
      );
    }
    if (unsupportedBashOption(errors, "stdin")) {
      hints.push(
        "Recovery hint: `pi.bash` does not accept `stdin`. Write the content with `pi.write(path, content)`, then pass that path to the command or redirect the file into it.",
      );
    }
    if (hints.length > 0) return hints.join("\n");
  }

  if (!PAYLOAD_CALL_PATTERN.test(code)) return undefined;
  if (!errors.some((error) => SYNTAX_ERROR_PATTERN.test(error.message))) {
    return undefined;
  }
  return "Recovery hint: if embedded edit/write payload text caused the syntax error, pass it through top-level `strings` and reference `π.key` instead of escaping it inside `code`.";
};
