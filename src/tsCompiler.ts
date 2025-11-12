import * as path from "node:path";
import * as ts from "typescript";

const configLookupCache = new Map<string, string | null>();
const compilerContextCache = new Map<string, CompilerContext>();

const DEFAULT_COMPILER_OPTIONS: ts.CompilerOptions = {
  module: ts.ModuleKind.CommonJS,
  target: ts.ScriptTarget.ES2020,
  moduleResolution: ts.ModuleResolutionKind.Node16,
  esModuleInterop: true,
  resolveJsonModule: true,
  allowJs: true,
  skipLibCheck: true,
};

interface CompilerContext {
  options: ts.CompilerOptions;
  baseDir: string;
  resolutionCache: ts.ModuleResolutionCache;
  originalRootDir?: string;
}

export function transpileTypeScriptModule(
  source: string,
  filePath: string,
  workspaceFolder?: string
): string {
  const context = getCompilerContext(filePath, workspaceFolder);
  const transpiled = ts.transpileModule(source, {
    compilerOptions: context.options,
    fileName: filePath,
    reportDiagnostics: true,
  });

  if (transpiled.diagnostics && transpiled.diagnostics.length > 0) {
    const host = createDiagnosticHost(context.baseDir);
    const formatted = ts.formatDiagnostics(transpiled.diagnostics, host);
    throw new Error(
      `Failed to compile TypeScript companion module at ${filePath}:\n${formatted}`
    );
  }

  return transpiled.outputText;
}

export function resolveTypeScriptImport(
  moduleName: string,
  containingFile: string,
  workspaceFolder?: string
): string | undefined {
  const context = getCompilerContext(containingFile, workspaceFolder);
  const host = createModuleResolutionHost(context.baseDir);
  const resolution = ts.resolveModuleName(
    moduleName,
    containingFile,
    context.options,
    host,
    context.resolutionCache
  );

  const resolved = resolution.resolvedModule;
  if (!resolved || !resolved.resolvedFileName) {
    return undefined;
  }

  if (resolved.extension === ts.Extension.Dts) {
    return undefined;
  }

  return resolved.resolvedFileName;
}

function getCompilerContext(
  filePath: string,
  workspaceFolder?: string
): CompilerContext {
  const configPath = findTsConfigPath(filePath, workspaceFolder);
  if (!configPath) {
    const baseDir = workspaceFolder
      ? path.resolve(workspaceFolder)
      : path.dirname(filePath);
    const cacheKey = `default::${baseDir}`;
    const cached = compilerContextCache.get(cacheKey);
    if (cached) {
      return cached;
    }

    const options = { ...DEFAULT_COMPILER_OPTIONS };
    const resolutionCache = createModuleResolutionCache(baseDir, options);
    const context: CompilerContext = { options, baseDir, resolutionCache };
    compilerContextCache.set(cacheKey, context);
    return context;
  }

  const normalizedConfigPath = path.normalize(configPath);
  const baseDir = path.dirname(normalizedConfigPath);
  const baseKey = `config::${normalizedConfigPath}`;
  const rootlessKey = `${baseKey}::noRootDir`;

  const cachedBase = compilerContextCache.get(baseKey);
  if (
    cachedBase &&
    (!cachedBase.originalRootDir ||
      isWithinDirectory(filePath, cachedBase.originalRootDir))
  ) {
    return cachedBase;
  }

  const cachedRootless = compilerContextCache.get(rootlessKey);
  if (cachedRootless) {
    return cachedRootless;
  }

  const host = ts.sys;
  const configFile = ts.readConfigFile(normalizedConfigPath, host.readFile);
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

  let cacheKey = baseKey;
  let originalRootDir: string | undefined;

  if (options.rootDir) {
    originalRootDir = path.resolve(baseDir, options.rootDir);
    if (!isWithinDirectory(filePath, originalRootDir)) {
      const { rootDir, ...rest } = options;
      options = { ...rest };
      cacheKey = rootlessKey;
    }
  }

  const resolutionCache = createModuleResolutionCache(baseDir, options);
  const context: CompilerContext = {
    options,
    baseDir,
    resolutionCache,
    originalRootDir,
  };
  compilerContextCache.set(cacheKey, context);
  return context;
}

function createModuleResolutionCache(
  baseDir: string,
  options: ts.CompilerOptions
): ts.ModuleResolutionCache {
  const getCanonicalFileName = ts.sys.useCaseSensitiveFileNames
    ? (fileName: string) => fileName
    : (fileName: string) => fileName.toLowerCase();

  return ts.createModuleResolutionCache(baseDir, getCanonicalFileName, options);
}

function createModuleResolutionHost(
  baseDir: string
): ts.ModuleResolutionHost {
  return {
    fileExists: ts.sys.fileExists,
    readFile: ts.sys.readFile,
    directoryExists: ts.sys.directoryExists,
    getDirectories: ts.sys.getDirectories,
    realpath: ts.sys.realpath,
    getCurrentDirectory: () => baseDir,
  };
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
