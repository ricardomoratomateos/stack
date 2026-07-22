/** Abstraction over vscode.window user notifications. */
export interface INotifyPort {
  showError(message: string): void;
  showWarning(message: string): void;
  showInfo(message: string): void;
  /** Modal confirm; resolves with the chosen item or undefined on cancel. */
  confirm(message: string, detail: string | undefined, ...items: string[]): Promise<string | undefined>;
  withProgress<T>(title: string, task: (report: (message: string) => void) => Promise<T>): Promise<T>;
}
