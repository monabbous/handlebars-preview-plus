import Handlebars from "handlebars";

import type { ProcessingContext, ResolvedTemplatePreviewRecipe } from "./types";

export async function renderTemplate(
  templateContent: string,
  recipe: ResolvedTemplatePreviewRecipe,
  context: ProcessingContext
): Promise<string> {
  const engine = Handlebars.create();

  if (recipe.helpers) {
    for (const [name, helper] of Object.entries(recipe.helpers)) {
      engine.registerHelper(name, helper);
    }
  }

  if (recipe.partials) {
    for (const [name, partial] of Object.entries(recipe.partials)) {
      engine.registerPartial(name, partial);
    }
  }

  const processedTemplate = recipe.preprocess
    ? await recipe.preprocess(templateContent, context)
    : templateContent;
  const compiled = engine.compile(processedTemplate);
  const output = compiled(recipe.data ?? {});
  return recipe.postprocess ? recipe.postprocess(output, context) : output;
}
