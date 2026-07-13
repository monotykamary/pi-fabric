import path from "node:path";
import ts from "typescript";

export interface FabricTypeError {
  line: number;
  column: number;
  message: string;
}

export interface FabricTypeCheckResult {
  errors: FabricTypeError[];
}

export const typeCheckFabricCode = (
  code: string,
  declarations: string,
): FabricTypeCheckResult => {
  const virtualFile = path.resolve("/__pi_fabric_guest__.ts");
  const declarationLineCount = declarations.split("\n").length;
  const sourceText = `${declarations}\nasync function __piFabricMain() {\n${code}\n}\n`;
  // Functional-errors-only: disable strict type-correctness (null-safety,
  // union narrowing, implicit any, strict function types) so valid code isn't
  // blocked. Genuine breakage still fails fast at type-check (syntax, undefined
  // names, wrong arity); the rest surfaces as a runtime error from the sandbox.
  const compilerOptions: ts.CompilerOptions = {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    strict: false,
    noImplicitAny: false,
    strictNullChecks: false,
    strictFunctionTypes: false,
    strictBindCallApply: false,
    alwaysStrict: false,
    strictPropertyInitialization: false,
    noImplicitThis: false,
    useUnknownInCatchVariables: false,
    noEmit: true,
    skipLibCheck: true,
    lib: ["lib.es2022.d.ts"],
  };
  const baseHost = ts.createCompilerHost(compilerOptions, true);
  const sourceFile = ts.createSourceFile(virtualFile, sourceText, ts.ScriptTarget.ES2022, true);
  const host: ts.CompilerHost = {
    ...baseHost,
    fileExists: (fileName) => fileName === virtualFile || baseHost.fileExists(fileName),
    readFile: (fileName) => (fileName === virtualFile ? sourceText : baseHost.readFile(fileName)),
    getSourceFile: (fileName, languageVersion, onError, shouldCreateNewSourceFile) =>
      fileName === virtualFile
        ? sourceFile
        : baseHost.getSourceFile(
            fileName,
            languageVersion,
            onError,
            shouldCreateNewSourceFile,
          ),
  };
  const program = ts.createProgram([virtualFile], compilerOptions, host);
  // Pure type-correctness codes — drop so only functional errors reach the
  // model. Property-access/assignability/narrowing fall through to a runtime
  // error; undefined-name (2304) and wrong-arity (2554) are kept (real breakage).
  // Excess-property (2350/2561) is deliberately KEPT — it catches typo'd
  // argument keys, which are functional (wrong tool shape). Only pure
  // type-correctness (narrowing/assignability/null/any) is dropped below.
  const TYPE_CORRECTNESS_CODES = new Set<number>([
    2339, 2551,                               // property access / union narrowing -> runtime
    2322, 2345, 2367,                         // not-assignable -> runtime
    2531, 2532, 18047, 18048,                 // possibly null/undefined
    7006, 7008, 7019, 7031, 7032, 7033, 7034, // implicit any
  ]);
  const diagnostics = [
    ...program.getSyntacticDiagnostics(sourceFile),
    ...program.getSemanticDiagnostics(sourceFile).filter(
      (diagnostic) => !TYPE_CORRECTNESS_CODES.has(diagnostic.code),
    ),
  ];
  return {
    errors: diagnostics.map((diagnostic) => {
      const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n");
      if (!diagnostic.file || diagnostic.start === undefined) {
        return { line: 0, column: 0, message };
      }
      const position = diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start);
      const line = position.line - declarationLineCount;
      return {
        line: Math.max(1, line),
        column: position.character + 1,
        message,
      };
    }),
  };
};
