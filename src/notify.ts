import { spawn } from "node:child_process";
import { log } from "./log.ts";

/**
 * Desktop notifications (architecture §9.7). Title and body are passed as
 * process arguments or environment variables, never spliced into a shell
 * command or script, so message text can't inject commands.
 */
export function desktopNotify(title: string, body: string): void {
  const run = (cmd: string, args: string[]) => {
    try {
      const child = spawn(cmd, args, { stdio: "ignore", detached: true });
      child.on("error", (err) => log.debug(`notification via ${cmd} failed: ${err.message}`));
      child.unref();
    } catch (err) {
      log.debug(`notification via ${cmd} failed: ${String(err)}`);
    }
  };
  if (process.platform === "darwin") {
    // AppleScript reads the text from argv, so quotes in it need no escaping.
    run("osascript", ["-e", "on run argv\ndisplay notification (item 2 of argv) with title (item 1 of argv)\nend run", title, body]);
  } else if (process.platform === "win32") {
    // A tray balloon; the text travels in environment variables, not in the script.
    const script = [
      "Add-Type -AssemblyName System.Windows.Forms, System.Drawing",
      "$n = New-Object System.Windows.Forms.NotifyIcon",
      "$n.Icon = [System.Drawing.SystemIcons]::Information",
      "$n.Visible = $true",
      "$n.ShowBalloonTip(5000, $env:TUIMSPEAK_TITLE, $env:TUIMSPEAK_BODY, 'Info')",
      "Start-Sleep -Seconds 6",
      "$n.Dispose()",
    ].join("; ");
    try {
      const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-Command", script], {
        stdio: "ignore",
        detached: true,
        windowsHide: true,
        env: { ...process.env, TUIMSPEAK_TITLE: title || "tuimspeak", TUIMSPEAK_BODY: body || " " },
      });
      child.on("error", (err) => log.debug(`notification via PowerShell failed: ${err.message}`));
      child.unref();
    } catch (err) {
      log.debug(`notification via PowerShell failed: ${String(err)}`);
    }
  } else {
    run("notify-send", ["--app-name=tuimspeak", "--", title, body]);
  }
}
