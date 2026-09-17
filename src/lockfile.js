/**
 * Is the polling loop actually running?
 *
 * The naive check is existsSync(".jobhunt.lock"), which reports a loop killed by a
 * closed terminal as healthy forever. Both callers had already moved past that to
 * a process.kill(pid, 0) liveness probe.
 *
 * That probe is still not enough. It answers "does SOME process have this pid",
 * and pids are recycled — on macOS the space is small enough that a long-lived
 * lock from a loop that died hours ago can be answered by an unrelated process
 * that has since inherited the number. The report would read "polling loop
 * running" while nothing polls, which is the precise failure this dashboard
 * exists to prevent and the one this codebase keeps reproducing.
 *
 * So: confirm the pid is alive AND that its command line is the loop. One shared
 * implementation, because two copies of a subtle check drift.
 */
import { existsSync, readFileSync, unlinkSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";

export const LOCK = ".jobhunt.lock";

/** The pid's argv, or null when the process is gone or unreadable. */
function commandLine(pid) {
  try {
    return execFileSync("ps", ["-p", String(pid), "-o", "args="], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}

/**
 * @returns {{running:boolean, pid:number|null, reason:string, ageMs:number|null}}
 *   reason is one of: running | no_lock | unreadable | dead | pid_reused
 */
export function loopStatus({ marker = "run.mjs" } = {}) {
  if (!existsSync(LOCK))
    return { running: false, pid: null, reason: "no_lock", ageMs: null };

  let ageMs = null;
  try {
    ageMs = Date.now() - statSync(LOCK).mtimeMs;
  } catch {}

  let pid;
  try {
    pid = Number(readFileSync(LOCK, "utf8").trim());
  } catch {
    return { running: false, pid: null, reason: "unreadable", ageMs };
  }
  if (!Number.isFinite(pid) || pid <= 0)
    return { running: false, pid: null, reason: "unreadable", ageMs };

  try {
    process.kill(pid, 0); // existence probe, delivers nothing
  } catch {
    return { running: false, pid, reason: "dead", ageMs };
  }

  // Alive — but is it ours? A recycled pid answers the probe just as readily.
  const argv = commandLine(pid);
  if (argv && !argv.includes(marker))
    return { running: false, pid, reason: "pid_reused", ageMs };

  return { running: true, pid, reason: "running", ageMs };
}

/** Remove a lock no live loop owns. Returns what it did, never throws. */
export function clearStaleLock(opts = {}) {
  const st = loopStatus(opts);
  if (st.running || st.reason === "no_lock") return { removed: false, ...st };
  try {
    unlinkSync(LOCK);
    return { removed: true, ...st };
  } catch {
    return { removed: false, ...st };
  }
}
