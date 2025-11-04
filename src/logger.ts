import * as vscode from "vscode";

function formatDetail(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }

  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export class PreviewLogger implements vscode.Disposable {
  private readonly channel = vscode.window.createOutputChannel(
    "Handlebars Preview Plus"
  );
  private readonly disposables: vscode.Disposable[] = [];
  private enabled = false;

  constructor() {
    this.updateEnabledFlag();
    this.disposables.push(
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (
          event.affectsConfiguration(
            "handlebars-preview-plus.enableDebugLogging"
          )
        ) {
          this.updateEnabledFlag();
        }
      })
    );
  }

  dispose(): void {
    vscode.Disposable.from(...this.disposables).dispose();
    this.channel.dispose();
  }

  debug(message: string, ...details: unknown[]): void {
    if (!this.enabled) {
      return;
    }
    const rendered = [message, ...details.map((detail) => formatDetail(detail))]
      .filter((segment) => segment.length > 0)
      .join(" ");
    this.channel.appendLine(`${new Date().toISOString()} ${rendered}`);
  }

  error(error: Error, context?: string): void {
    const prefix = context ? `${context}: ` : "";
    this.channel.appendLine(
      `${new Date().toISOString()} ERROR ${prefix}${error.message}`
    );
    if (error.stack) {
      this.channel.appendLine(error.stack);
    }
  }

  private updateEnabledFlag(): void {
    const config = vscode.workspace.getConfiguration(
      "handlebars-preview-plus"
    );
    const next = Boolean(config.get("enableDebugLogging"));
    if (next === this.enabled) {
      return;
    }

    this.enabled = next;
    if (this.enabled) {
      this.channel.appendLine(
        `${new Date().toISOString()} Debug logging enabled`
      );
    } else {
      this.channel.appendLine(
        `${new Date().toISOString()} Debug logging disabled`
      );
    }
  }
}
