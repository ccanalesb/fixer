/** Whether raw input names a folder on disk (POSIX path, Windows drive letter, or UNC). */
export function isFolderSourceInput(text: string): boolean {
  if (/^[/~.]/.test(text)) return true;
  if (/^[A-Za-z]:[/\\]/.test(text)) return true;
  if (/^\\\\/.test(text)) return true;
  if (/^\/\/.+/.test(text)) return true;
  return false;
}
