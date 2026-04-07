# Overview

`procband` supervises one subprocess per `supervise()` call.

The returned `ProcbandProcess` is both:

- a `ChildProcess`-compatible handle for the current active child attempt
- a thenable wrapper that resolves to a `ProcessResult` when supervision is done

Supervision adds four behaviors on top of raw `spawn()`:

- prefixed `stdout` and `stderr`
- line-based matching for future output
- optional restart policy with failure suppression
- tree-aware shutdown for the child and its descendants

# When to Use

- You are writing project-specific TypeScript scripts, not a CLI.
- You need to wait for a subprocess to print a "ready" line.
- You want readable prefixed logs from multiple long-lived child processes.
- You need one shutdown API that kills descendant processes too.
- You want automatic restart with a small built-in guard against tight failure
  loops.

# When Not to Use

- You need a standalone process manager or service supervisor.
- You need buffered log history or replay for late subscribers.
- You need shell pipelines, shell parsing, or a command-line tool.
- You want one API that supervises many processes at once. `procband` keeps the
  unit of supervision to one process per call.

# Core Abstractions

- `ProcessConfig`
  Declares one supervised subprocess plus its label, color, restart policy, and
  optional raw `stderr` tee.
- `ProcbandProcess`
  The live wrapper returned by `supervise()`. It is a `ChildProcess`-compatible
  handle, a matching surface, a shutdown surface, and a thenable final result.
- `MatchEvent`
  A future matched line from `stdout` or `stderr`.
- `RestartPolicy`
  Rules for restart timing and failed-exit suppression.

# Data Flow / Lifecycle

1. `supervise(config)` spawns the first child process immediately.
2. Child `stdout` and `stderr` are read as text and split into lines.
3. Each line is prefixed and written to the parent `process.stdout` or
   `process.stderr`.
4. `stderr` can also be tee'd as raw bytes to `ProcessConfig.stderr`.
5. Future matching lines are delivered through `match()` callbacks or
   `waitFor()`.
6. When a child exits, `procband` either finalizes or starts a new attempt,
   depending on the restart policy.
7. `await proc` or `await proc.wait()` resolves only after the process is
   terminal and no further restart will happen.

# Common Tasks -> Recommended APIs

- Wait for one readiness line:
  `proc.waitFor('ready')`
- React to repeated matching output:
  `proc.match(pattern, callback, options)`
- Stop the process and its descendants:
  `proc.stop()`
- Inspect final exit state:
  `await proc` or `await proc.wait()`
- Capture raw child `stderr` in a file or custom stream:
  `ProcessConfig.stderr`
- Retry failed exits with sane defaults:
  `restart: true`
- Use explicit retry rules:
  `restart: { when, delayMs, maxFailures, windowMs }`

# Invariants and Constraints

- Matching is line-based and future-only.
- String patterns use substring matching.
- RegExp patterns run against the full observed line.
- `match()` subscriptions do not interfere with each other.
- `waitFor()` rejects if the process becomes terminal before a future match is
  observed.
- `await proc` resolves for both successful and failed exits. Inspect the
  returned `ProcessResult`.
- The wrapper survives restarts, but inherited `pid`, `stdin`, `stdout`,
  `stderr`, and related `ChildProcess` fields always refer to the current active
  child attempt.
- `kill()` only signals the current direct child. `stop()` disables restart and
  kills the full process tree.
- `stderr` prefixes always use the reserved red, even when a custom process
  color is configured.

# Error Model

- `supervise()` throws synchronously for invalid config such as missing `name`,
  missing `command`, or an invalid reserved color.
- `waitFor()` rejects on timeout or terminal exit before a future match.
- A thrown `match()` callback only unsubscribes that callback.
- Errors from `ProcessConfig.stderr` stop teeing to that sink but do not stop
  supervision.
- `stop()` may reject if tree-kill fails with a non-`ESRCH` error.

# Terminology

- Supervised process:
  A `ProcbandProcess` wrapper plus its current child attempt.
- Child attempt:
  One concrete spawned process instance inside a supervision run.
- Terminal:
  No child is running and no restart will be started.
- Restart suppression:
  Automatic disabling of further restarts after too many failed exits inside the
  configured window.
- Match:
  A future observed output line that satisfies a string or regex pattern.

# Non-Goals

- A standalone CLI
- Historical log replay
- Multi-process orchestration in one top-level API
- Shell command parsing
- Full service-management features such as persistence, cron scheduling, or host
  restarts
