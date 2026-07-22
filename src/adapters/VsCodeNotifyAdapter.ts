import * as vscode from 'vscode';
import { INotifyPort } from '../ports/INotifyPort';

/** INotifyPort backed by vscode.window notifications + progress. */
export class VsCodeNotifyAdapter implements INotifyPort {
  showError(message: string): void {
    vscode.window.showErrorMessage(message);
  }

  showWarning(message: string): void {
    vscode.window.showWarningMessage(message);
  }

  showInfo(message: string): void {
    vscode.window.showInformationMessage(message);
  }

  confirm(message: string, detail: string | undefined, ...items: string[]): Promise<string | undefined> {
    return Promise.resolve(vscode.window.showWarningMessage(message, { modal: true, detail }, ...items));
  }

  withProgress<T>(title: string, task: (report: (message: string) => void) => Promise<T>): Promise<T> {
    return Promise.resolve(
      vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title, cancellable: false },
        (progress) => task((message: string) => progress.report({ message })),
      ),
    ) as Promise<T>;
  }
}
