import * as fs from "node:fs/promises";
import * as fsSync from "node:fs";
import * as path from "node:path";

import type {
  ProcessingContext,
  ResolvedTemplatePreviewRecipe,
  TemplatePartialDefinition,
  TemplatePartialFileReference,
  TemplatePreviewRecipe,
} from "./types";
import {
  resolveTypeScriptImport,
  transpileTypeScriptModule,
} from "./tsCompiler";

declare const __non_webpack_require__: NodeRequire | undefined;

const dynamicRequire: NodeRequire =
  typeof __non_webpack_require__ === "function"
    ? __non_webpack_require__
    : require;

const MAX_RESOLUTION_DEPTH = 10;

type NodeModuleWithCompile = NodeJS.Module & {
  _compile(code: string, filename: string): unknown;
};

type ModuleConstructorWithStatics = {
  new (id: string, parent?: NodeModuleWithCompile | null): NodeModuleWithCompile;
  _nodeModulePaths?: (from: string) => string[];
  _resolveFilename?: (
    request: string,
    parent: NodeModuleWithCompile | null,
    isMain: boolean,
    options?: unknown
  ) => string;
  builtinModules?: string[];
};

const TS_EXTENSIONS = [".ts", ".tsx", ".cts", ".mts"] as const;

const builtinModuleNames = new Set<string>(
  ((dynamicRequire("module") as ModuleConstructorWithStatics).builtinModules ?? [])
);

interface ModuleLoadContext {
  readonly root: string;
  readonly dependencies: Set<string>;
  readonly overrides?: Record<string, string>;
}

interface ModuleLoadFrame {
  readonly modulePath: string;
  readonly context: ModuleLoadContext;
  readonly isRoot: boolean;
}

const moduleDependencyMap = new Map<string, Set<string>>();
const moduleLoadStack: ModuleLoadFrame[] = [];

function withModuleLoadFrame<T>(
  modulePath: string,
  treatAsRoot: boolean,
  overrides: Record<string, string> | undefined,
  loader: () => T
): T {
  const normalizedPath = path.normalize(modulePath);
  let context: ModuleLoadContext;
  let isRoot = false;

  if (treatAsRoot || moduleLoadStack.length === 0) {
    context = {
      root: normalizedPath,
      dependencies: new Set<string>(),
      overrides,
    };
    isRoot = true;
  } else {
    context = moduleLoadStack[moduleLoadStack.length - 1]!.context;
  }

  const frame: ModuleLoadFrame = {
    modulePath: normalizedPath,
    context,
    isRoot,
  };

  moduleLoadStack.push(frame);
  let success = false;
  try {
    const result = loader();
    success = true;
    return result;
  } finally {
    moduleLoadStack.pop();
    if (frame.isRoot) {
      if (success) {
        moduleDependencyMap.set(frame.context.root, frame.context.dependencies);
      } else {
        moduleDependencyMap.delete(frame.context.root);
      }
    }
  }
}

function recordModuleDependency(filePath: string): void {
  const frame = moduleLoadStack[moduleLoadStack.length - 1];
  if (!frame) {
    return;
  }

  frame.context.dependencies.add(path.normalize(filePath));
}

function getModuleOverride(filePath: string): string | undefined {
  const frame = moduleLoadStack[moduleLoadStack.length - 1];
  if (!frame) {
    return undefined;
  }

  const overrides = frame.context.overrides;
  if (!overrides) {
    return undefined;
  }

  const normalized = path.normalize(filePath);
  if (overrides[normalized] !== undefined) {
    return overrides[normalized];
  }

  for (const [candidate, source] of Object.entries(overrides)) {
    if (path.normalize(candidate) === normalized) {
      return source;
    }
  }

  return undefined;
}

function invalidateModuleTree(modulePath: string): void {
  const normalized = path.normalize(modulePath);
  const cachedDependencies = moduleDependencyMap.get(normalized);

  if (cachedDependencies) {
    for (const dependencyPath of cachedDependencies) {
      delete dynamicRequire.cache[dependencyPath];
    }
    moduleDependencyMap.delete(normalized);
  }

  delete dynamicRequire.cache[normalized];
}

function getModuleDependenciesFor(modulePath: string): string[] {
  const normalized = path.normalize(modulePath);
  const dependencies = moduleDependencyMap.get(normalized);
  if (!dependencies) {
    return [];
  }
  return Array.from(dependencies);
}

export interface TemplateRecipeLoadOptions {
  moduleSource?: string;
  moduleSourceOverrides?: Record<string, string>;
  partialSourceOverrides?: Record<string, string>;
  workspaceFolder?: string;
}

const tsWorkspaceRoots = new Set<string>();
let tsRequireHookInstalled = false;
let tsResolutionHookInstalled = false;

export async function loadTemplateRecipe(
  modulePath: string,
  context: ProcessingContext,
  options?: TemplateRecipeLoadOptions
): Promise<ResolvedTemplatePreviewRecipe> {
  const moduleSourceOverride = options?.moduleSource;
  const exists =
    moduleSourceOverride !== undefined ? true : await fileExists(modulePath);
  if (!exists) {
    throw new Error(`Companion module not found: ${modulePath}`);
  }

  const raw = await loadModuleExports(
    modulePath,
    moduleSourceOverride,
    options?.workspaceFolder ?? context.workspaceFolder,
    options?.moduleSourceOverrides
  );
  const recipe = await resolveRecipe(raw, context, 0);

  const resolvedHelpers = await resolveMaybeFactory(
    recipe?.helpers,
    context,
    {}
  );
  const resolvedPartials = await resolveMaybeFactory(
    recipe?.partials,
    context,
    {}
  );
  const resolvedData = await resolveMaybeFactory(recipe?.data, context, {});
  const resolvedWatchFiles = await resolveMaybeFactory(
    recipe?.watchFiles,
    context,
    []
  );
  const partialResolution = await resolvePartials(
    resolvedPartials,
    modulePath,
    options?.partialSourceOverrides
  );

  const moduleDependencies = getModuleDependenciesFor(modulePath);

  const watchEntries = [
    ...resolvedWatchFiles,
    ...Object.values(partialResolution.files),
    ...moduleDependencies,
  ];

  const normalizedWatchFiles = Array.from(new Set(watchEntries))
    .filter(
      (entry): entry is string =>
        typeof entry === "string" && entry.trim().length > 0
    )
    .map((entry) =>
      path.isAbsolute(entry)
        ? entry
        : path.resolve(path.dirname(modulePath), entry)
    );

  return {
    title: recipe?.title,
    data: resolvedData,
    helpers: resolvedHelpers,
    partials: partialResolution.contents,
    preprocess: recipe?.preprocess,
    postprocess: recipe?.postprocess,
    watchFiles: normalizedWatchFiles,
    partialFiles: partialResolution.files,
    moduleDependencies,
  };
}

async function loadModuleExports(
  modulePath: string,
  moduleSourceOverride: string | undefined,
  workspaceFolder?: string,
  moduleSourceOverrides?: Record<string, string>
): Promise<unknown> {
  invalidateModuleTree(modulePath);
  ensureTypeScriptSupport(workspaceFolder);
  const extension = path.extname(modulePath).toLowerCase();

  if (extension === ".ts") {
    const source =
      moduleSourceOverride ?? (await fs.readFile(modulePath, "utf8"));
    const transpiled = transpileTypeScriptModule(
      source,
      modulePath,
      workspaceFolder
    );
    return loadModuleFromSource(
      modulePath,
      transpiled,
      moduleSourceOverrides
    );
  }

  if (moduleSourceOverride !== undefined) {
    return loadModuleFromSource(
      modulePath,
      moduleSourceOverride,
      moduleSourceOverrides
    );
  }

  return withModuleLoadFrame(
    modulePath,
    true,
    moduleSourceOverrides,
    () => {
      try {
        const cacheKey = dynamicRequire.resolve(modulePath);
        delete dynamicRequire.cache[cacheKey];
      } catch {
        // ignore resolution errors; dynamic require will throw meaningful message below
      }
      return dynamicRequire(modulePath);
    }
  );
}

function loadModuleFromSource(
  modulePath: string,
  source: string,
  moduleSourceOverrides?: Record<string, string>
): unknown {
  return withModuleLoadFrame(
    modulePath,
    true,
    moduleSourceOverrides,
    () => {
      const ModuleCtor = dynamicRequire("module") as ModuleConstructorWithStatics;
      const compiledModule = new ModuleCtor(modulePath, null);
      compiledModule.filename = modulePath;

      const nodePaths = ModuleCtor._nodeModulePaths?.(path.dirname(modulePath));
      if (nodePaths) {
        compiledModule.paths = nodePaths;
      }

      compiledModule._compile(source, modulePath);
      dynamicRequire.cache[modulePath] = compiledModule;
      return compiledModule.exports;
    }
  );
}

function ensureTypeScriptSupport(workspaceFolder?: string): void {
  if (workspaceFolder) {
    tsWorkspaceRoots.add(path.resolve(workspaceFolder));
  }

  installTypeScriptRequireHook();
  installTypeScriptResolutionHook();
}

function installTypeScriptRequireHook(): void {
  if (tsRequireHookInstalled) {
    return;
  }

  const requireWithExtensions = dynamicRequire as typeof require & {
    extensions?: NodeJS.RequireExtensions;
  };

  if (!requireWithExtensions.extensions) {
    return;
  }

  const registerTsModule = function registerTsModule(
    module: NodeModule,
    filename: string
  ) {
    withModuleLoadFrame(
      filename,
      moduleLoadStack.length === 0,
      undefined,
      () => {
        const override = getModuleOverride(filename);
        const source = override ?? fsSync.readFileSync(filename, "utf8");
        const workspace = findWorkspaceForFile(filename);
        const transpiled = transpileTypeScriptModule(source, filename, workspace);

        (module as NodeModuleWithCompile)._compile(transpiled, filename);
        recordModuleDependency(filename);
      }
    );
  } as unknown as NodeJS.RequireExtensions[keyof NodeJS.RequireExtensions];

  for (const extension of TS_EXTENSIONS) {
    requireWithExtensions.extensions[extension] = registerTsModule;
  }

  tsRequireHookInstalled = true;
}

function installTypeScriptResolutionHook(): void {
  if (tsResolutionHookInstalled) {
    return;
  }

  const ModuleCtor = dynamicRequire("module") as ModuleConstructorWithStatics;
  const originalResolve = ModuleCtor._resolveFilename?.bind(ModuleCtor);

  if (!originalResolve) {
    return;
  }

  ModuleCtor._resolveFilename = function resolveWithTsFallback(
    request: string,
    parent: NodeModuleWithCompile | null,
    isMain: boolean,
    options?: unknown
  ): string {
    try {
      return originalResolve(request, parent, isMain, options as never);
    } catch (error) {
      if (!shouldAttemptTypeScriptFallback(error, request, parent)) {
        throw error;
      }

      const resolved = resolveTypeScriptFallback(request, parent);
      if (resolved) {
        return resolved;
      }

      throw error;
    }
  };

  tsResolutionHookInstalled = true;
}

function shouldAttemptTypeScriptFallback(
  error: unknown,
  request: string,
  parent: NodeModuleWithCompile | null
): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }

  const code = (error as NodeJS.ErrnoException).code;
  if (code !== "MODULE_NOT_FOUND") {
    return false;
  }

  if (!parent?.filename) {
    return false;
  }

  if (request.startsWith(".") || path.isAbsolute(request)) {
    return true;
  }

  if (builtinModuleNames.has(request)) {
    return false;
  }

  return true;
}

function resolveTypeScriptFallback(
  request: string,
  parent: NodeModuleWithCompile | null
): string | undefined {
  if (!parent?.filename) {
    return undefined;
  }

  const workspace = findWorkspaceForFile(parent.filename);
  const tsResolved = resolveTypeScriptImport(
    request,
    parent.filename,
    workspace
  );
  if (tsResolved) {
    recordModuleDependency(tsResolved);
    return tsResolved;
  }

  const baseDir = path.dirname(parent.filename);
  const basePaths = path.isAbsolute(request)
    ? [request]
    : [path.resolve(baseDir, request)];

  const extensions = TS_EXTENSIONS;

  for (const basePath of basePaths) {
    if (fsSync.existsSync(basePath) && fsSync.statSync(basePath).isFile()) {
      recordModuleDependency(basePath);
      return basePath;
    }

    for (const extension of extensions) {
      const candidate = `${basePath}${extension}`;
      if (fsSync.existsSync(candidate)) {
        recordModuleDependency(candidate);
        return candidate;
      }
    }

    for (const extension of extensions) {
      const indexCandidate = path.join(basePath, `index${extension}`);
      if (fsSync.existsSync(indexCandidate)) {
        recordModuleDependency(indexCandidate);
        return indexCandidate;
      }
    }
  }

  return undefined;
}

function findWorkspaceForFile(filePath: string): string | undefined {
  for (const root of tsWorkspaceRoots) {
    if (isPathWithin(filePath, root)) {
      return root;
    }
  }

  return undefined;
}

function isPathWithin(target: string, container: string): boolean {
  const relative = path.relative(container, target);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

async function resolveRecipe(
  candidate: unknown,
  context: ProcessingContext,
  depth: number
): Promise<TemplatePreviewRecipe | undefined> {
  if (depth > MAX_RESOLUTION_DEPTH) {
    throw new Error(
      "Exceeded maximum depth while resolving preview configuration."
    );
  }

  if (typeof candidate === "function") {
    const result = await candidate(context);
    return resolveRecipe(result, context, depth + 1);
  }

  if (!candidate || typeof candidate !== "object") {
    return undefined;
  }

  const record = candidate as Record<string, unknown>;

  let resolved: TemplatePreviewRecipe | undefined;
  const nestedKeys: Array<keyof typeof record> = [
    "getPreviewRecipe",
    "getPreviewConfig",
    "getPreviewData",
    "default",
  ];

  for (const key of nestedKeys) {
    const value = record[key];
    if (value === undefined) {
      continue;
    }

    const nested = await resolveRecipe(value, context, depth + 1);
    resolved = mergeRecipes(resolved, nested);
  }

  const inlineRecipe: TemplatePreviewRecipe = {
    title: typeof record.title === "string" ? record.title : undefined,
    data: record.data as TemplatePreviewRecipe["data"],
    helpers: record.helpers as TemplatePreviewRecipe["helpers"],
    partials: record.partials as TemplatePreviewRecipe["partials"],
    preprocess:
      typeof record.preprocess === "function"
        ? (record.preprocess as TemplatePreviewRecipe["preprocess"])
        : undefined,
    postprocess:
      typeof record.postprocess === "function"
        ? (record.postprocess as TemplatePreviewRecipe["postprocess"])
        : undefined,
    watchFiles: record.watchFiles as TemplatePreviewRecipe["watchFiles"],
  };

  return mergeRecipes(resolved, inlineRecipe);
}

function mergeRecipes(
  base: TemplatePreviewRecipe | undefined,
  override?: TemplatePreviewRecipe
): TemplatePreviewRecipe | undefined {
  if (!override) {
    return base;
  }

  const result: TemplatePreviewRecipe = { ...(base ?? {}) };
  const keys: Array<keyof TemplatePreviewRecipe> = [
    "title",
    "data",
    "helpers",
    "partials",
    "preprocess",
    "postprocess",
    "watchFiles",
  ];

  for (const key of keys) {
    const value = override[key];
    if (value !== undefined && value !== null) {
      (result as Record<string, unknown>)[key as string] = value as unknown;
    }
  }

  return result;
}

async function resolveMaybeFactory<T>(
  value: T | ((context: ProcessingContext) => T | Promise<T>) | undefined,
  context: ProcessingContext,
  fallback: T
): Promise<T> {
  if (typeof value === "function") {
    const result = await (value as (ctx: ProcessingContext) => T | Promise<T>)(
      context
    );
    return result === undefined ? fallback : result;
  }

  if (value === undefined || value === null) {
    return fallback;
  }

  return value as T;
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function resolvePartials(
  partials: Record<string, TemplatePartialDefinition>,
  modulePath: string,
  overrides?: Record<string, string>
): Promise<{ contents: Record<string, string>; files: Record<string, string> }> {
  const contents: Record<string, string> = {};
  const files: Record<string, string> = {};
  const entries = Object.entries(partials ?? {});

  for (const [name, definition] of entries) {
    if (definition === undefined || definition === null) {
      continue;
    }

    if (isPartialFileReference(definition)) {
      if (!definition.file) {
        throw new Error(`Partial "${name}" is missing a file path.`);
      }

      const absolutePath = resolveRelativeToModule(
        modulePath,
        definition.file
      );
      const normalizedPath = path.normalize(absolutePath);
      const encoding = definition.encoding ?? "utf8";
      const override = findOverride(overrides, normalizedPath);

      let content: string;
      if (override !== undefined) {
        content = override;
      } else {
        try {
          content = await fs.readFile(normalizedPath, encoding);
        } catch (error) {
          throw new Error(
            `Failed to read partial "${name}" at ${normalizedPath}: ${(error as Error).message}`
          );
        }
      }

      contents[name] = content;
      files[name] = normalizedPath;
      continue;
    }

    contents[name] = String(definition);
  }

  return { contents, files };
}

function findOverride(
  overrides: Record<string, string> | undefined,
  normalizedPath: string
): string | undefined {
  if (!overrides) {
    return undefined;
  }

  if (normalizedPath in overrides) {
    return overrides[normalizedPath];
  }

  for (const [key, value] of Object.entries(overrides)) {
    if (path.normalize(key) === normalizedPath) {
      return value;
    }
  }

  return undefined;
}

function resolveRelativeToModule(modulePath: string, target: string): string {
  if (path.isAbsolute(target)) {
    return target;
  }

  return path.resolve(path.dirname(modulePath), target);
}

function isPartialFileReference(
  value: TemplatePartialDefinition
): value is TemplatePartialFileReference {
  return typeof value === "object" && value !== null && "file" in value;
}
