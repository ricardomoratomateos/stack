/**
 * Whether this window runs as a client of `stackd`.
 *
 * An explicit `stack.useDaemon` (true or false, in any scope) always wins. When the user never set
 * it, a live daemon socket means "the desktop app / launchd agent is already running it": use it.
 */
export function shouldUseDaemon(explicit: boolean | undefined, daemonAlive: boolean): boolean {
  return explicit ?? daemonAlive;
}

/** The value the user set themselves, from `WorkspaceConfiguration.inspect`, narrowest scope first. */
export function explicitUseDaemon(
  inspected: { workspaceFolderValue?: boolean; workspaceValue?: boolean; globalValue?: boolean } | undefined,
): boolean | undefined {
  return inspected?.workspaceFolderValue ?? inspected?.workspaceValue ?? inspected?.globalValue;
}
