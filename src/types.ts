import type { HelperDelegate } from "handlebars";

export type MaybePromise<T> = T | Promise<T>;

export interface ProcessingContext {
  readonly templatePath: string;
  readonly modulePath: string;
  readonly workspaceFolder?: string;
}

export type TemplateProcessor = (
  content: string,
  context: ProcessingContext
) => MaybePromise<string>;

export interface TemplatePreviewRecipe {
  title?: string;
  data?: unknown | ((context: ProcessingContext) => MaybePromise<unknown>);
  helpers?:
    | Record<string, HelperDelegate>
    | ((
        context: ProcessingContext
      ) => MaybePromise<Record<string, HelperDelegate>>);
  partials?:
    | Record<string, TemplatePartialDefinition>
    | ((
        context: ProcessingContext
      ) => MaybePromise<Record<string, TemplatePartialDefinition>>);
  preprocess?: TemplateProcessor;
  postprocess?: TemplateProcessor;
  watchFiles?:
    | string[]
    | ((context: ProcessingContext) => MaybePromise<string[]>);
}

export interface ResolvedTemplatePreviewRecipe {
  title?: string;
  data: unknown;
  helpers: Record<string, HelperDelegate>;
  partials: Record<string, string>;
  preprocess?: TemplateProcessor;
  postprocess?: TemplateProcessor;
  watchFiles: string[];
  partialFiles: Record<string, string>;
  moduleDependencies: string[];
}

export interface TemplatePartialFileReference {
  file: string;
  encoding?: BufferEncoding;
}

export type TemplatePartialDefinition =
  | string
  | TemplatePartialFileReference;
