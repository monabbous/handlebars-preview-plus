import { watch as fsWatch, FSWatcher } from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";

import {
  MissingTemplateModuleError,
  loadTemplateRecipe,
} from "./templateModuleLoader";
import { renderTemplate } from "./templateRenderer";
import { PreviewLogger } from "./logger";
import type { ProcessingContext } from "./types";

const HANDLEBARS_VIEW_TYPE = "handlebarsPreview";
const RENDER_DEBOUNCE_MS = 200;

interface PreviewSession {
  readonly key: string;
  readonly templateUri: vscode.Uri;
  readonly modulePath: string;
  readonly moduleUri: vscode.Uri;
  readonly panel: vscode.WebviewPanel;
  moduleWatcher?: vscode.FileSystemWatcher;
  extraWatchers: vscode.Disposable[];
  fsWatchers: FSWatcher[];
  renderTimer?: NodeJS.Timeout;
  renderPromise?: Promise<void>;
  trackedPartials: Set<string>;
}

export class HandlebarsPreviewManager implements vscode.Disposable {
  private readonly sessions = new Map<string, PreviewSession>();
  private readonly moduleSessionIndex = new Map<string, Set<PreviewSession>>();
  private readonly partialSessionIndex = new Map<string, Set<PreviewSession>>();
  private readonly disposables: vscode.Disposable[] = [];

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly logger: PreviewLogger
  ) {
    this.disposables.push(
      vscode.workspace.onDidChangeTextDocument((event) => {
        const session = this.sessions.get(event.document.uri.toString());
        if (session) {
          this.logger.debug("Template document change detected", {
            template: session.templateUri.fsPath,
          });
          this.scheduleRender(session, "document-change");
        }

        const relatedSessions = this.moduleSessionIndex.get(
          event.document.uri.toString()
        );
        if (relatedSessions) {
          for (const activeSession of relatedSessions) {
            this.logger.debug("Companion module change detected", {
              module: activeSession.modulePath,
            });
            this.scheduleRender(activeSession, "module-document-change");
          }
        }

        const partialSessions = this.partialSessionIndex.get(
          event.document.uri.toString()
        );
        if (partialSessions) {
          for (const activeSession of partialSessions) {
            this.logger.debug("Partial document change detected", {
              partial: event.document.uri.fsPath,
            });
            this.scheduleRender(activeSession, "partial-document-change", true);
          }
        }
      }),
      vscode.workspace.onDidCloseTextDocument((document) => {
        const session = this.sessions.get(document.uri.toString());
        if (session && !session.panel.visible) {
          this.logger.debug("Disposing preview for closed document", {
            template: session.templateUri.fsPath,
          });
          session.panel.dispose();
        }
      })
    );
  }

  dispose(): void {
    for (const session of this.sessions.values()) {
      this.disposeSession(session);
    }
    this.sessions.clear();
    vscode.Disposable.from(...this.disposables).dispose();
  }

  async open(document: vscode.TextDocument): Promise<void> {
    const key = document.uri.toString();
    let session = this.sessions.get(key);

    if (session) {
      this.logger.debug("Revealing existing preview", {
        template: document.uri.fsPath,
      });
      session.panel.reveal(vscode.ViewColumn.Beside, true);
      this.scheduleRender(session, "reveal", true);
      return;
    }

    this.logger.debug("Opening new preview", {
      template: document.uri.fsPath,
    });
    const panel = this.createWebviewPanel(document);

    const modulePath = this.deriveModulePath(document.uri);

    session = {
      key,
      templateUri: document.uri,
      modulePath,
      moduleUri: vscode.Uri.file(modulePath),
      panel,
      extraWatchers: [],
      fsWatchers: [],
      trackedPartials: new Set(),
    };

    this.sessions.set(key, session);
    this.trackModuleSession(session);
    panel.onDidDispose(() => this.disposeSession(session!));

    this.registerModuleWatcher(session);
    panel.webview.html = this.renderPlaceholderHtml(
      "Rendering Handlebars Preview Plus…"
    );
    this.scheduleRender(session, "initial", true);
  }

  async refresh(targetUri?: vscode.Uri): Promise<void> {
    if (targetUri) {
      const direct = this.sessions.get(targetUri.toString());
      if (direct) {
        this.scheduleRender(direct, "refresh-command", true);
        return;
      }

      const document = await vscode.workspace.openTextDocument(targetUri);
      await this.open(document);
      return;
    }

    const activeSession = [...this.sessions.values()].find(
      (entry) => entry.panel.active
    );
    if (activeSession) {
      this.scheduleRender(activeSession, "refresh-command", true);
      return;
    }

    const editor = vscode.window.activeTextEditor;
    if (editor) {
      await this.open(editor.document);
    }
  }

  private createWebviewPanel(
    document: vscode.TextDocument
  ): vscode.WebviewPanel {
    const title = `${path.basename(document.fileName)} Preview`;
    return vscode.window.createWebviewPanel(
      HANDLEBARS_VIEW_TYPE,
      title,
      { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
      {
        enableScripts: true,
        retainContextWhenHidden: true,
      }
    );
  }

  private scheduleRender(
    session: PreviewSession,
    reason: string,
    immediate = false
  ): void {
    if (session.renderTimer) {
      clearTimeout(session.renderTimer);
    }

    this.logger.debug("Scheduling render", {
      template: session.templateUri.fsPath,
      reason,
      immediate,
    });

    const invoke = () => {
      session.renderTimer = undefined;
      session.renderPromise = this.render(session).catch((error) => {
        this.logger.error(error as Error, "Render failed");
        this.showError(session, error as Error);
      });
    };

    if (immediate) {
      invoke();
    } else {
      session.renderTimer = setTimeout(invoke, RENDER_DEBOUNCE_MS);
    }
  }

  private async render(session: PreviewSession): Promise<void> {
    const context = this.createProcessingContext(session);
    let document: vscode.TextDocument;

    try {
      document = await this.getDocument(session.templateUri);
    } catch (error) {
      this.logger.error(error as Error, "Failed to load template document");
      this.showError(session, error as Error);
      return;
    }

    const templateContent = document.getText();
    const moduleDocument = this.findOpenDocument(session.moduleUri);
    const moduleSourceOverride =
      moduleDocument && moduleDocument.isDirty
        ? moduleDocument.getText()
        : undefined;

    try {
      const recipe = await loadTemplateRecipe(
        session.modulePath,
        context,
        {
          moduleSource: moduleSourceOverride,
          partialSourceOverrides: this.collectDirtyDocumentOverrides(),
        }
      );
      this.updateAdditionalWatchers(
        session,
        recipe.watchFiles,
        recipe.partialFiles
      );
      const html = await renderTemplate(templateContent, recipe, context);
      const title =
        recipe.title ?? `${path.basename(session.templateUri.fsPath)} Preview`;
      session.panel.title = title;
      session.panel.webview.html = this.wrapWithDocument(html, title);
      this.logger.debug("Render completed", {
        template: session.templateUri.fsPath,
        module: session.modulePath,
        watchFiles: recipe.watchFiles.length,
        partials: Object.keys(recipe.partials).length,
      });
    } catch (error) {
      if (error instanceof MissingTemplateModuleError) {
        this.logger.debug("Missing companion module", {
          module: error.modulePath,
        });
        this.showMissingModule(session, error.modulePath);
        return;
      }

      this.logger.error(error as Error, "Render pipeline failed");
      this.showError(session, error as Error);
    }
  }

  private async getDocument(uri: vscode.Uri): Promise<vscode.TextDocument> {
    const open = vscode.workspace.textDocuments.find(
      (doc) => doc.uri.toString() === uri.toString()
    );
    if (open) {
      return open;
    }

    return vscode.workspace.openTextDocument(uri);
  }

  private findOpenDocument(uri: vscode.Uri): vscode.TextDocument | undefined {
    return vscode.workspace.textDocuments.find(
      (doc) => doc.uri.toString() === uri.toString()
    );
  }

  private createProcessingContext(session: PreviewSession): ProcessingContext {
    const workspaceFolder = vscode.workspace.getWorkspaceFolder(
      session.templateUri
    )?.uri.fsPath;
    return {
      templatePath: session.templateUri.fsPath,
      modulePath: session.modulePath,
      workspaceFolder,
    };
  }

  private deriveModulePath(templateUri: vscode.Uri): string {
    const templatePath = templateUri.fsPath;
    return `${templatePath}.js`;
  }

  private registerModuleWatcher(session: PreviewSession): void {
    session.moduleWatcher?.dispose();

    const moduleDir = path.dirname(session.modulePath);
    const pattern = new vscode.RelativePattern(
      vscode.Uri.file(moduleDir),
      path.basename(session.modulePath)
    );
    const watcher = vscode.workspace.createFileSystemWatcher(pattern);

    const rerender = () => this.scheduleRender(session, "module-change", true);
    const subscriptions = [
      watcher.onDidChange(() => rerender()),
      watcher.onDidCreate(() => rerender()),
      watcher.onDidDelete(() => rerender()),
    ];

    session.moduleWatcher = watcher;
    session.extraWatchers.push(watcher, ...subscriptions);
    this.logger.debug("Module watcher registered", {
      module: session.modulePath,
    });
  }

  private updateAdditionalWatchers(
    session: PreviewSession,
    watchFiles: string[],
    partialFiles: Record<string, string>
  ): void {
    for (const disposable of session.extraWatchers) {
      disposable.dispose();
    }
    for (const watcher of session.fsWatchers) {
      watcher.close();
    }

    session.extraWatchers = [];
    session.fsWatchers = [];

    this.registerModuleWatcher(session);

    this.untrackAllPartials(session);
    session.trackedPartials = new Set();

    const watchTargets = new Set<string>();

    for (const filePath of watchFiles) {
      if (filePath) {
        watchTargets.add(this.normalizeFsPath(session, filePath));
      }
    }

    for (const partialPath of Object.values(partialFiles)) {
      if (!partialPath) {
        continue;
      }
      const normalized = this.normalizeFsPath(session, partialPath);
      session.trackedPartials.add(normalized);
      this.trackPartialSession(session, normalized);
      watchTargets.add(normalized);
    }

    for (const filePath of watchTargets) {
      const watcher = this.createWatcherForPath(session, filePath);
      if (watcher) {
        session.extraWatchers.push(watcher.disposable);
        if (watcher.fsWatcher) {
          session.fsWatchers.push(watcher.fsWatcher);
        }
      }
    }

    this.logger.debug("Watchers refreshed", {
      template: session.templateUri.fsPath,
      watchTargets: watchTargets.size,
      partials: session.trackedPartials.size,
    });
  }

  private createWatcherForPath(
    session: PreviewSession,
    targetPath: string
  ): { disposable: vscode.Disposable; fsWatcher?: FSWatcher } | undefined {
    const targetUri = vscode.Uri.file(targetPath);
    const folder = vscode.workspace.getWorkspaceFolder(targetUri);
    const rerender = () => this.scheduleRender(session, `watch:${targetPath}`);

    if (folder) {
      const relative =
        path.relative(folder.uri.fsPath, targetPath) ||
        path.basename(targetPath);
      const watcher = vscode.workspace.createFileSystemWatcher(
        new vscode.RelativePattern(folder, relative)
      );
      const subscriptions = [
        watcher.onDidChange(() => rerender()),
        watcher.onDidCreate(() => rerender()),
        watcher.onDidDelete(() => rerender()),
      ];

      this.logger.debug("Registered VS Code watcher", {
        template: session.templateUri.fsPath,
        target: targetPath,
      });
      return {
        disposable: vscode.Disposable.from(watcher, ...subscriptions),
      };
    }

    try {
      const fsWatcher = fsWatch(targetPath, { persistent: false }, () =>
        rerender()
      );
      this.logger.debug("Registered fs.watch fallback", {
        template: session.templateUri.fsPath,
        target: targetPath,
      });
      return {
        disposable: new vscode.Disposable(() => fsWatcher.close()),
        fsWatcher,
      };
    } catch {
      this.logger.debug("Failed to watch target", {
        template: session.templateUri.fsPath,
        target: targetPath,
      });
      return undefined;
    }
  }

  private showMissingModule(session: PreviewSession, modulePath: string): void {
    const message = [
      "No companion data module found for this template.",
      `Expected module path: ${modulePath}`,
    ].join("\n");
    session.panel.webview.html = this.renderPlaceholderHtml(message);
  }

  private showError(session: PreviewSession, error: Error): void {
    const detail = error.stack ?? error.message ?? String(error);
    session.panel.webview.html = this.wrapWithDocument(
      `<section class="error"><h1>Handlebars Preview Plus failed</h1><pre>${this.escapeHtml(
        detail
      )}</pre></section>`,
      `${path.basename(session.templateUri.fsPath)} Preview`
    );
  }

  private wrapWithDocument(content: string, title: string): string {
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data: https: http:; style-src 'unsafe-inline'; script-src 'unsafe-inline'; font-src data: https: http:;" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>${this.escapeHtml(title)}</title>
<style>
  :root {
    color-scheme: light dark;
  }
  body {
    margin: 0;
    padding: 0;
    font-family: var(--vscode-editor-font-family, system-ui, sans-serif);
    background: var(--vscode-editor-background, #1e1e1e);
    color: var(--vscode-editor-foreground, #cccccc);
  }
  main {
    padding: 1.5rem;
    box-sizing: border-box;
  }
  pre {
    white-space: pre-wrap;
    word-break: break-word;
  }
  .error h1 {
    font-size: 1.1rem;
    margin-top: 0;
  }
</style>
</head>
<body>
<main>${content}</main>
</body>
</html>`;
  }

  private renderPlaceholderHtml(message: string): string {
    return this.wrapWithDocument(
      `<p>${this.escapeHtml(message)}</p>`,
      "Handlebars Preview Plus"
    );
  }

  private escapeHtml(value: string): string {
    return value
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  private disposeSession(session: PreviewSession): void {
    if (session.renderTimer) {
      clearTimeout(session.renderTimer);
    }

    session.moduleWatcher?.dispose();
    for (const disposable of session.extraWatchers) {
      disposable.dispose();
    }
    for (const watcher of session.fsWatchers) {
      watcher.close();
    }

    this.sessions.delete(session.key);
    this.untrackModuleSession(session);
    this.untrackAllPartials(session);
    this.logger.debug("Preview session disposed", {
      template: session.templateUri.fsPath,
    });
  }

  private trackModuleSession(session: PreviewSession): void {
    const key = session.moduleUri.toString();
    let bucket = this.moduleSessionIndex.get(key);
    if (!bucket) {
      bucket = new Set();
      this.moduleSessionIndex.set(key, bucket);
    }
    bucket.add(session);
  }

  private untrackModuleSession(session: PreviewSession): void {
    const key = session.moduleUri.toString();
    const bucket = this.moduleSessionIndex.get(key);
    if (!bucket) {
      return;
    }
    bucket.delete(session);
    if (bucket.size === 0) {
      this.moduleSessionIndex.delete(key);
    }
  }

  private trackPartialSession(session: PreviewSession, filePath: string): void {
    const key = vscode.Uri.file(filePath).toString();
    let bucket = this.partialSessionIndex.get(key);
    if (!bucket) {
      bucket = new Set();
      this.partialSessionIndex.set(key, bucket);
    }
    bucket.add(session);
  }

  private untrackPartialSession(
    session: PreviewSession,
    filePath: string
  ): void {
    const key = vscode.Uri.file(filePath).toString();
    const bucket = this.partialSessionIndex.get(key);
    if (!bucket) {
      return;
    }
    bucket.delete(session);
    if (bucket.size === 0) {
      this.partialSessionIndex.delete(key);
    }
  }

  private untrackAllPartials(session: PreviewSession): void {
    for (const partialPath of session.trackedPartials) {
      this.untrackPartialSession(session, partialPath);
    }
    session.trackedPartials.clear();
  }

  private collectDirtyDocumentOverrides(): Record<string, string> {
    const overrides: Record<string, string> = {};
    for (const document of vscode.workspace.textDocuments) {
      if (document.isDirty && document.uri.scheme === "file") {
        overrides[path.normalize(document.uri.fsPath)] = document.getText();
      }
    }
    return overrides;
  }

  private normalizeFsPath(session: PreviewSession, targetPath: string): string {
    if (path.isAbsolute(targetPath)) {
      return path.normalize(targetPath);
    }

    return path.normalize(
      path.resolve(path.dirname(session.modulePath), targetPath)
    );
  }
}
