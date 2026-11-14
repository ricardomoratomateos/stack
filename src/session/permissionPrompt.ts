/**
 * The question lines of the agents' permission prompts:
 * - Claude Code: "Do you want to proceed?", "Do you want to make this edit to …?"
 * - opencode: "Permission required", with "Allow once" among its choices
 */
const PROMPT = [/\bDo you want to\b/, /\bPermission required\b/i, /\bAllow once\b/];

/** How far up from the bottom of the screen a prompt's question may sit (a long command fills the box above its options). */
const TAIL = 40;

/**
 * Whether the bottom of an agent's screen (tmux capture-pane) shows a
 * permission prompt — so Enter/Escape answer it rather than land in whatever
 * the agent is doing now. A wording these do not know refuses an Allow; it
 * never sends one blind.
 */
export function permissionPromptOnScreen(screen: string): boolean {
  const lines = screen.split('\n').filter((l) => l.trim() !== '').slice(-TAIL);
  return lines.some((l) => PROMPT.some((re) => re.test(l)));
}
