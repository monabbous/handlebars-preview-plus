import * as fs from "node:fs/promises";
import * as path from "node:path";

import type {
  ProcessingContext,
  ResolvedTemplatePreviewRecipe,
  TemplatePartialDefinition,
  TemplatePartialFileReference,
  TemplatePreviewRecipe,
} from "./types";
import { transpileTypeScriptModule } from "./tsCompiler";

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
};

export interface TemplateRecipeLoadOptions {
  moduleSource?: string;
  partialSourceOverrides?: Record<string, string>;
  workspaceFolder?: string;
}

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
    options?.workspaceFolder ?? context.workspaceFolder
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

  const watchEntries = [
    ...resolvedWatchFiles,
    ...Object.values(partialResolution.files),
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
  };
}

async function loadModuleExports(
  modulePath: string,
  moduleSourceOverride: string | undefined,
  workspaceFolder?: string
): Promise<unknown> {
  const extension = path.extname(modulePath).toLowerCase();

  if (extension === ".ts") {
    const source =
      moduleSourceOverride ?? (await fs.readFile(modulePath, "utf8"));
    const transpiled = transpileTypeScriptModule(
      source,
      modulePath,
      workspaceFolder
    );
    return loadModuleFromSource(modulePath, transpiled);
  }

  if (moduleSourceOverride !== undefined) {
    return loadModuleFromSource(modulePath, moduleSourceOverride);
  }

  const cacheKey = dynamicRequire.resolve(modulePath);
  delete dynamicRequire.cache[cacheKey];
  return dynamicRequire(modulePath);
}

function loadModuleFromSource(
  modulePath: string,
  source: string
): unknown {
  delete dynamicRequire.cache[modulePath];

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
