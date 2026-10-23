/**
 * The macOS "choose file" and "choose folder" dialogs, opened by the backend on its own machine.
 *
 * The dialog appears on the host's screen, never the browser's. That is only
 * coherent because the backend always runs on the user's machine (ADR-0019);
 * a remote UI must fall back to typing the path.
 */
import { execFile } from 'node:child_process';

/**
 * Long enough to go hunting for the catalog, short enough not to leak a stuck
 * osascript. AppleScript would otherwise give up after its default two minutes,
 * so the limit has to be stated in the script as well as on the process.
 */
const DIALOG_TIMEOUT_SECONDS = 300;

/** AppleScript's error numbers for a dismissed dialog and an expired one. */
const USER_CANCELLED = '-128';
const APPLE_EVENT_TIMED_OUT = '-1712';

export type FileDialogResult = { path: string } | { dismissed: true };

export class FileDialogUnavailableError extends Error {
  constructor() {
    super('Native file dialog is only available on macOS');
  }
}

export class FileDialogBusyError extends Error {
  constructor() {
    super('A file dialog is already open on the machine running the backend');
  }
}

export function nativeFileDialogAvailable(): boolean {
  return process.platform === 'darwin';
}

/**
 * Only one at a time: a second dialog would queue behind the first with nothing
 * on screen to explain the wait.
 */
let dialogOpen = false;

function asAppleScriptString(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/**
 * @param extension file type to filter by, without the dot (e.g. `lrcat`)
 * @returns the chosen POSIX path, or `dismissed` if the user closed the dialog
 */
export function chooseFile(prompt: string, extension: string): Promise<FileDialogResult> {
  return choose(`choose file with prompt ${asAppleScriptString(prompt)} of type {${asAppleScriptString(extension)}}`);
}

/** @returns the chosen folder's POSIX path, without the trailing slash AppleScript gives it */
export async function chooseFolder(prompt: string): Promise<FileDialogResult> {
  const result = await choose(`choose folder with prompt ${asAppleScriptString(prompt)}`);
  return 'path' in result ? { path: result.path.replace(/(.)\/+$/, '$1') } : result;
}

async function choose(command: string): Promise<FileDialogResult> {
  if (!nativeFileDialogAvailable()) throw new FileDialogUnavailableError();
  if (dialogOpen) throw new FileDialogBusyError();

  // osascript is not a GUI app, so its dialog opens behind every window unless
  // something already frontmost puts it up. System Events is that something.
  const script = [
    'tell application "System Events"',
    '  activate',
    `  with timeout of ${DIALOG_TIMEOUT_SECONDS} seconds`,
    `    set chosenFile to ${command}`,
    '  end timeout',
    'end tell',
    'return POSIX path of chosenFile',
  ].join('\n');

  dialogOpen = true;
  try {
    const stdout = await new Promise<string>((resolve, reject) => {
      execFile(
        'osascript',
        ['-e', script],
        // A grace period over the script's own limit, so AppleScript gets to
        // report the expiry itself rather than dying mid-sentence.
        { timeout: (DIALOG_TIMEOUT_SECONDS + 10) * 1000 },
        (error, out, stderr) => {
          if (!error) return resolve(out);
          reject(new Error(stderr.trim() || error.message));
        },
      );
    });
    return { path: stdout.trim() };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes(USER_CANCELLED)) return { dismissed: true };
    if (message.includes(APPLE_EVENT_TIMED_OUT)) {
      throw new Error('The file dialog was left unanswered for too long');
    }
    throw new Error(`Could not open the file dialog: ${message}`);
  } finally {
    dialogOpen = false;
  }
}
