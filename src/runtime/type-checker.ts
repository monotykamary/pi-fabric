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
  const compilerOptions: ts.CompilerOptions = {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    strict: true,
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
  const diagnostics = [
    ...program.getSyntacticDiagnostics(sourceFile),
    ...program.getSemanticDiagnostics(sourceFile),
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
