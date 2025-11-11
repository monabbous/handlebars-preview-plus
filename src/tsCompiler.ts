import * as path from "node:path";
import * as ts from "typescript";

const compilerOptionsCache = new Map<string, ts.CompilerOptions>();
const configLookupCache = new Map<string, string | null>();

const DEFAULT_COMPILER_OPTIONS: ts.CompilerOptions = {
  module: ts.ModuleKind.CommonJS,
  target: ts.ScriptTarget.ES2020,
  moduleResolution: ts.ModuleResolutionKind.Node16,
  esModuleInterop: true,
  resolveJsonModule: true,
  allowJs: true,
  skipLibCheck: true,
};

export function transpileTypeScriptModule(
  source: string,
  filePath: string,
  workspaceFolder?: string
): string {
  const compilerOptions = getCompilerOptions(filePath, workspaceFolder);
  const transpiled = ts.transpileModule(source, {
    compilerOptions,
    fileName: filePath,
    reportDiagnostics: true,
  });

  if (transpiled.diagnostics && transpiled.diagnostics.length > 0) {
    const host = createDiagnosticHost(workspaceFolder ?? path.dirname(filePath));
    const formatted = ts.formatDiagnostics(transpiled.diagnostics, host);
    throw new Error(
      `Failed to compile TypeScript companion module at ${filePath}:\n${formatted}`
    );
  }

  return transpiled.outputText;
}

function getCompilerOptions(
  filePath: string,
  workspaceFolder?: string
): ts.CompilerOptions {
  const configPath = findTsConfigPath(filePath, workspaceFolder);
  if (!configPath) {
    return { ...DEFAULT_COMPILER_OPTIONS };
  }

  const cached = compilerOptionsCache.get(configPath);
  if (cached) {
    return cached;
  }

  const host = ts.sys;
  const configFile = ts.readConfigFile(configPath, host.readFile);
  const baseDir = path.dirname(configPath);
  const diagnosticHost = createDiagnosticHost(baseDir);

  if (configFile.error) {
    throw new Error(ts.formatDiagnostic(configFile.error, diagnosticHost));
  }

  const parsed = ts.parseJsonConfigFileContent(
    configFile.config,
    host,
    baseDir
  );

  if (parsed.errors.length) {
    throw new Error(ts.formatDiagnostics(parsed.errors, diagnosticHost));
  }

  let options: ts.CompilerOptions = {
    ...parsed.options,
    module: ts.ModuleKind.CommonJS,
  };

  if (options.rootDir) {
    const absoluteRoot = path.resolve(baseDir, options.rootDir);
    if (!isWithinDirectory(filePath, absoluteRoot)) {
      const { rootDir, ...rest } = options;
      options = { ...rest };
    }
  }

  compilerOptionsCache.set(configPath, options);
  return options;
}

function findTsConfigPath(
  filePath: string,
  workspaceFolder?: string
): string | null {
  const searchOrder = [path.dirname(filePath)];
  if (workspaceFolder) {
    searchOrder.push(workspaceFolder);
  }

  for (const searchRoot of searchOrder) {
    const key = path.resolve(searchRoot);
    if (configLookupCache.has(key)) {
      const cached = configLookupCache.get(key) ?? null;
      if (cached) {
        return cached;
      }
      continue;
    }

    const resolved =
      ts.findConfigFile(searchRoot, ts.sys.fileExists, "tsconfig.json") ??
      null;
    configLookupCache.set(key, resolved);
    if (resolved) {
      return resolved;
    }
  }

  return null;
}

function createDiagnosticHost(baseDir: string): ts.FormatDiagnosticsHost {
  return {
    getCurrentDirectory: () => baseDir,
    getCanonicalFileName: (fileName) => fileName,
    getNewLine: () => "\n",
  };
}

function isWithinDirectory(filePath: string, directory: string): boolean {
  const relative = path.relative(directory, filePath);
  if (!relative) {
    return true;
  }

  return !relative.startsWith("..") && !path.isAbsolute(relative);
}
