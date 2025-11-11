import { watch as fsWatch, FSWatcher } from "node:fs";
import * as fsPromises from "node:fs/promises";
import * as path from "node:path";
import * as vscode from "vscode";

import { loadTemplateRecipe } from "./templateModuleLoader";
import { renderTemplate } from "./templateRenderer";
import { PreviewLogger } from "./logger";
import type { ProcessingContext, ResolvedTemplatePreviewRecipe } from "./types";

const HANDLEBARS_VIEW_TYPE = "handlebarsPreview";
const RENDER_DEBOUNCE_MS = 200;

interface PreviewSession {
  readonly key: string;
  readonly templateUri: vscode.Uri;
  readonly panel: vscode.WebviewPanel;
  readonly moduleCandidates: string[];
  readonly trackedModuleUris: Set<string>;
  moduleWatchers: vscode.Disposable[];
  activeModulePath?: string;
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
              module: event.document.uri.fsPath,
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

    const moduleCandidates = this.deriveModuleCandidates(document.uri);

    session = {
      key,
      templateUri: document.uri,
      panel,
      moduleCandidates,
      trackedModuleUris: new Set(),
      moduleWatchers: [],
      extraWatchers: [],
      fsWatchers: [],
      trackedPartials: new Set(),
    };

    this.sessions.set(key, session);
    this.trackModuleSessions(session);
    panel.onDidDispose(() => this.disposeSession(session!));

    this.registerModuleWatchers(session);
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
    let document: vscode.TextDocument;

    try {
      document = await this.getDocument(session.templateUri);
    } catch (error) {
      this.logger.error(error as Error, "Failed to load template document");
      this.showError(session, error as Error);
      return;
    }

    const templateContent = document.getText();
    const dirtyOverrides = this.collectDirtyDocumentOverrides();

    const moduleSelection = await this.resolveCompanionModule(
      session,
      dirtyOverrides
    );
    session.activeModulePath = moduleSelection?.path;

    const context = this.createProcessingContext(
      session,
      moduleSelection?.path
    );

    try {
      const recipe = moduleSelection
        ? await loadTemplateRecipe(moduleSelection.path, context, {
            moduleSource: moduleSelection.source,
            partialSourceOverrides: dirtyOverrides,
            workspaceFolder: context.workspaceFolder,
          })
        : this.createDefaultRecipe();

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
        module: session.activeModulePath,
        watchFiles: recipe.watchFiles.length,
        partials: Object.keys(recipe.partials).length,
      });
    } catch (error) {
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

  private createProcessingContext(
    session: PreviewSession,
    modulePathForContext?: string
  ): ProcessingContext {
    const workspaceFolder = vscode.workspace.getWorkspaceFolder(
      session.templateUri
    )?.uri.fsPath;
    const fallbackModulePath =
      modulePathForContext ??
      session.activeModulePath ??
      session.moduleCandidates[0] ??
      `${session.templateUri.fsPath}.js`;
    return {
      templatePath: session.templateUri.fsPath,
      modulePath: fallbackModulePath,
      workspaceFolder,
    };
  }

  private deriveModuleCandidates(templateUri: vscode.Uri): string[] {
    const templatePath = templateUri.fsPath;
    const candidates = [`${templatePath}.js`, `${templatePath}.ts`];
    return Array.from(new Set(candidates.map((candidate) => path.normalize(candidate))));
  }

  private registerModuleWatchers(session: PreviewSession): void {
    for (const disposable of session.moduleWatchers) {
      disposable.dispose();
    }
    session.moduleWatchers = [];

    for (const candidate of session.moduleCandidates) {
      const watcher = this.createModuleWatcher(session, candidate);
      if (watcher) {
        session.moduleWatchers.push(watcher);
      }
    }
  }

  private createModuleWatcher(
    session: PreviewSession,
    modulePath: string
  ): vscode.Disposable | undefined {
    const moduleDir = path.dirname(modulePath);
    const fileName = path.basename(modulePath);
    const watcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(vscode.Uri.file(moduleDir), fileName)
    );

    const rerender = () => this.scheduleRender(session, "module-change", true);
    const subscriptions = [
      watcher.onDidChange(() => rerender()),
      watcher.onDidCreate(() => rerender()),
      watcher.onDidDelete(() => rerender()),
    ];

    this.logger.debug("Module watcher registered", {
      module: modulePath,
    });
    return vscode.Disposable.from(watcher, ...subscriptions);
  }

  private async resolveCompanionModule(
    session: PreviewSession,
    overrides: Record<string, string>
  ): Promise<{ path: string; source?: string } | undefined> {
    for (const candidate of session.moduleCandidates) {
      const normalized = path.normalize(candidate);
      const override = overrides[normalized];
      if (override !== undefined) {
        return { path: normalized, source: override };
      }

      if (await this.fileExists(normalized)) {
        return { path: normalized };
      }
    }

    return undefined;
  }

  private async fileExists(filePath: string): Promise<boolean> {
    try {
      await fsPromises.access(filePath);
      return true;
    } catch {
      return false;
    }
  }

  private createDefaultRecipe(): ResolvedTemplatePreviewRecipe {
    return {
      title: undefined,
      data: {},
      helpers: {},
      partials: {},
      preprocess: undefined,
      postprocess: undefined,
      watchFiles: [],
      partialFiles: {},
    };
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

    for (const disposable of session.moduleWatchers) {
      disposable.dispose();
    }
    for (const disposable of session.extraWatchers) {
      disposable.dispose();
    }
    for (const watcher of session.fsWatchers) {
      watcher.close();
    }

    this.sessions.delete(session.key);
    this.untrackModuleSessions(session);
    this.untrackAllPartials(session);
    this.logger.debug("Preview session disposed", {
      template: session.templateUri.fsPath,
    });
  }

  private trackModuleSessions(session: PreviewSession): void {
    for (const candidate of session.moduleCandidates) {
      const key = vscode.Uri.file(candidate).toString();
      session.trackedModuleUris.add(key);
      let bucket = this.moduleSessionIndex.get(key);
      if (!bucket) {
        bucket = new Set();
        this.moduleSessionIndex.set(key, bucket);
      }
      bucket.add(session);
    }
  }

  private untrackModuleSessions(session: PreviewSession): void {
    for (const key of session.trackedModuleUris) {
      const bucket = this.moduleSessionIndex.get(key);
      if (!bucket) {
        continue;
      }
      bucket.delete(session);
      if (bucket.size === 0) {
        this.moduleSessionIndex.delete(key);
      }
    }
    session.trackedModuleUris.clear();
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

    const baseDir = session.activeModulePath
      ? path.dirname(session.activeModulePath)
      : path.dirname(session.templateUri.fsPath);
    return path.normalize(path.resolve(baseDir, targetPath));
  }
}
