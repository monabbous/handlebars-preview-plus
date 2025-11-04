import * as path from "node:path";
import * as vscode from "vscode";

import { HandlebarsPreviewManager } from "./previewManager";
import { PreviewLogger } from "./logger";

let previewManager: HandlebarsPreviewManager | undefined;
let logger: PreviewLogger | undefined;

export function activate(context: vscode.ExtensionContext): void {
  logger = new PreviewLogger();
  previewManager = new HandlebarsPreviewManager(context, logger);
  context.subscriptions.push(previewManager);
  context.subscriptions.push(logger);

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "handlebars-preview-plus.openPreview",
      async (uri?: vscode.Uri) => {
        const document = await resolveHandlebarsDocument(uri);
        if (!document) {
          return;
        }
        if (!previewManager) {
          return;
        }
        await previewManager.open(document);
      }
    ),
    vscode.commands.registerCommand(
      "handlebars-preview-plus.refreshPreview",
      async (uri?: vscode.Uri) => {
        await previewManager?.refresh(uri);
      }
    )
  );
}

export function deactivate(): void {
  previewManager?.dispose();
  previewManager = undefined;
  logger?.dispose();
  logger = undefined;
}

async function resolveHandlebarsDocument(
  uri?: vscode.Uri
): Promise<vscode.TextDocument | undefined> {
  const document = uri
    ? await vscode.workspace.openTextDocument(uri)
    : vscode.window.activeTextEditor?.document;

  if (!document) {
    vscode.window.showErrorMessage(
      "No Handlebars template selected for Handlebars Preview Plus."
    );
    return undefined;
  }

  if (document.isUntitled) {
    vscode.window.showWarningMessage(
      "Save the template file before opening Handlebars Preview Plus."
    );
    return undefined;
  }

  const ext = path.extname(document.fileName).toLowerCase();
  if (ext !== ".hbs" && ext !== ".handlebars") {
    vscode.window.showWarningMessage(
      "Handlebars Preview Plus works with .hbs or .handlebars files."
    );
    return undefined;
  }

  return document;
}
