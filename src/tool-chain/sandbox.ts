// src/tool-chain/sandbox.ts
// Runs one run_chain script in a fresh QuickJS (WebAssembly) context. The script can only
// reach the host through the `servers` bindings and `console.log`; there is no require,
// process, fetch or filesystem. Every resource is bounded (see RunLimits).

import {
  getQuickJS,
  type QuickJSContext,
  type QuickJSDeferredPromise,
  type QuickJSHandle,
  type QuickJSRuntime,
} from "quickjs-emscripten";

export interface RunLimits {
  /** Heap limit for the script, in bytes. */
  memoryBytes: number;
  /** Max JS stack, in bytes. */
  stackBytes: number;
  /** Wall-clock budget for the whole run, in ms. */
  deadlineMs: number;
  /** Max nested tool calls per run. */
  maxCalls: number;
  /** Max tool calls in flight at once. */
  maxConcurrent: number;
  /** Max bytes of console.log output per run. */
  maxLogBytes: number;
  /** Max serialized size of any value crossing the boundary, in bytes. */
  maxValueBytes: number;
  /** Per-call timeout ceiling (the caller's toolTimeoutMs still applies). */
  callTimeoutMs: number;
}

export const DEFAULT_LIMITS: RunLimits = {
  memoryBytes: 64 * 1024 * 1024,
  stackBytes: 512 * 1024,
  deadlineMs: 60_000,
  maxCalls: 64,
  maxConcurrent: 4,
  maxLogBytes: 64 * 1024,
  maxValueBytes: 1024 * 1024,
  callTimeoutMs: 5 * 60_000,
};

/**
 * Binding exposed to the script as `servers.<server>.<tool>(args)`.
 * `tools` lists the callable names. `"*"` accepts any name (toolChain: true); the host decides
 * whether the name exists once the server is active.
 */
export interface CodeBinding {
  server: string;
  tools: string[] | "*";
}

/**
 * Host callback for one nested call. Resolves to `{ value, failed }`: `value` is what the script
 * receives, and `failed` marks an error value (counted in failedCalls). A rejection also becomes
 * an `{ error }` value inside the script, so a failed call never aborts the run by itself.
 */
export type NestedCall = (
  server: string,
  tool: string,
  args: unknown,
  timeoutMs: number
) => Promise<{ value: unknown; failed: boolean }>;

export interface RunInput {
  code: string;
  bindings: CodeBinding[];
  callTool: NestedCall;
  limits?: Partial<RunLimits>;
}

export interface RunOutput {
  /** Lines written with console.log, joined and capped. */
  logs: string;
  /** The script's return value (JSON-compatible). Undefined when the script returned nothing. */
  value: unknown;
  /** Set when the script threw, timed out, or hit a limit. */
  error?: string;
  /** Nested calls that resolved to an error value (upstream isError, refused, or failed). */
  failedCalls: number;
  /** Nested calls attempted, successful or not. */
  calls: number;
}

/** The user's code is wrapped in an async arrow so `await` and `return` work at top level. */
const WRAPPER_PREFIX = "(async () => {\n";
const WRAPPER_SUFFIX = "\n})()";
/** Lines the wrapper adds before the user's first line. */
const LINE_OFFSET = 1;

let engine: ReturnType<typeof getQuickJS> | undefined;
function quickjs(): ReturnType<typeof getQuickJS> {
  engine ??= getQuickJS();
  return engine;
}

/** Thrown inside the host to stop a run. The message is shown to the model. */
class RunAbort extends Error {}

/** Serialize a value crossing the boundary, enforcing the size cap. */
function boundedJson(value: unknown, max: number, what: string): string {
  let json: string | undefined;
  try {
    json = JSON.stringify(value);
  } catch {
    throw new RunAbort(`${what} is not JSON-serializable`);
  }
  if (json === undefined) return "null";
  if (Buffer.byteLength(json, "utf-8") > max) {
    throw new RunAbort(`${what} exceeds the ${Math.floor(max / 1024)} KiB size limit`);
  }
  return json;
}

/** Map a raw QuickJS error to a line-numbered message with hints for the model. */
export function formatScriptError(name: string, message: string, stack: string | undefined): string {
  const match = stack ? /script\.js:(\d+):\d+/.exec(stack) : null;
  const userLine = match ? Number(match[1]) - LINE_OFFSET : undefined;
  const where = userLine !== undefined && userLine >= 1 ? ` (line ${userLine})` : "";
  if (/out of memory/i.test(message)) {
    return `script exceeded its memory limit${where}\nHint: each run_chain run is a fresh scope`;
  }
  const hints: string[] = [];
  if (/is not defined|is not a function|Cannot read propert/i.test(message)) {
    hints.push("tools are only reachable as servers.<name>.<tool>(args); check names against the stubs");
  }
  if (/(require|process|fetch|import)/.test(message) && /not defined|Cannot find/.test(message)) {
    hints.push("the sandbox has no require, process, fetch or imports; use servers.* for tools");
  }
  hints.push("each run_chain run is a fresh scope");
  return `${name}: ${message}${where}\nHint: ${hints.join("; ")}`;
}

/**
 * In-context helper that builds one `servers.<name>` object. Named tools become plain functions;
 * `"*"` bindings get a Proxy so any tool name routes to the host (the host validates it).
 * `__call(server, tool, args)` is the host function that starts a nested call.
 */
const BIND_SERVER_SOURCE = `(function (serverName, tools, __call) {
  const invoke = (tool) => (args) => __call(serverName, tool, args === undefined ? {} : args);
  if (tools === "*") {
    return new Proxy({}, { get: (_t, prop) => (typeof prop === "string" ? invoke(prop) : undefined) });
  }
  const obj = {};
  for (const tool of tools) obj[tool] = invoke(tool);
  return obj;
})`;

export async function runCode(input: RunInput): Promise<RunOutput> {
  const limits: RunLimits = { ...DEFAULT_LIMITS, ...input.limits };
  const qjs = await quickjs();
  const runtime: QuickJSRuntime = qjs.newRuntime();
  const started = Date.now();
  let context: QuickJSContext | undefined;
  const handles: QuickJSHandle[] = [];
  const keep = <T extends QuickJSHandle>(h: T): T => {
    handles.push(h);
    return h;
  };

  runtime.setMemoryLimit(limits.memoryBytes);
  runtime.setMaxStackSize(limits.stackBytes);
  let interruptReason: string | undefined;
  runtime.setInterruptHandler(() => {
    if (Date.now() - started > limits.deadlineMs) {
      interruptReason ??= `script exceeded the ${Math.round(limits.deadlineMs / 1000)}s time limit`;
      return true;
    }
    return false;
  });

  const logs: string[] = [];
  let logBytes = 0;
  let logTruncated = false;
  let calls = 0;
  let failedCalls = 0;
  let inFlight = 0;
  let pendingNested = 0;
  const waiting: Array<() => void> = [];

  const acquire = async (): Promise<void> => {
    while (inFlight >= limits.maxConcurrent) {
      await new Promise<void>((resolve) => waiting.push(resolve));
    }
    inFlight++;
  };
  const release = (): void => {
    inFlight--;
    waiting.shift()?.();
  };

  const result = (value: unknown, error?: string): RunOutput => ({
    logs: logs.join("\n"),
    value,
    error,
    failedCalls,
    calls,
  });

  // Set once the VM is torn down. A host call still in flight then must not touch the context.
  let closed = false;

  try {
    context = runtime.newContext();
    const ctx = context;

    // Settle a host-created promise with a JSON payload. The payload is parsed inside the context
    // so the script gets a plain value (or an `{ error }` object). Results are always resolved,
    // never rejected, so one failed tool call cannot abort the script by accident.
    const jsonObj = keep(ctx.getProp(ctx.global, "JSON"));
    const jsonParse = keep(ctx.getProp(jsonObj, "parse"));
    const settle = (deferred: QuickJSDeferredPromise, payloadJson: string): void => {
      const jsonH = ctx.newString(payloadJson);
      const parsed = ctx.callFunction(jsonParse, jsonObj, jsonH);
      jsonH.dispose();
      if (parsed.error) {
        parsed.error.dispose();
        const fallback = ctx.newString(JSON.stringify({ error: "could not decode tool result" }));
        deferred.resolve(fallback);
        fallback.dispose();
        return;
      }
      deferred.resolve(parsed.value);
      parsed.value.dispose();
    };

    // console.log -> capped host-side buffer
    const logFn = keep(
      ctx.newFunction("log", (...args: QuickJSHandle[]) => {
        const line = args
          .map((a) => {
            if (ctx.typeof(a) === "string") return ctx.getString(a);
            const dumped = ctx.dump(a);
            return typeof dumped === "string" ? dumped : (JSON.stringify(dumped) ?? String(dumped));
          })
          .join(" ");
        const size = Buffer.byteLength(line, "utf-8") + 1;
        if (logBytes + size > limits.maxLogBytes) {
          if (!logTruncated) {
            logs.push("[log output truncated]");
            logTruncated = true;
          }
          return;
        }
        logBytes += size;
        logs.push(line);
      })
    );
    const consoleObj = keep(ctx.newObject());
    ctx.setProp(consoleObj, "log", logFn);
    ctx.setProp(ctx.global, "console", consoleObj);

    // __call(server, tool, args) -> promise settled from the host.
    const callFn = keep(
      ctx.newFunction("__call", (serverH, toolH, argsH) => {
        const server = ctx.getString(serverH);
        const tool = ctx.getString(toolH);
        const deferred = ctx.newPromise();
        keep(deferred.handle);
        pendingNested++;
        const done = (payload: unknown): void => {
          pendingNested--;
          if (closed) return;
          try {
            settle(deferred, JSON.stringify(payload));
          } catch {
            /* VM already torn down; nothing left to settle */
          }
        };
        const fail = (message: string): void => {
          failedCalls++;
          done({ error: message });
        };

        let args: unknown = {};
        try {
          args = ctx.dump(argsH);
          boundedJson(args, limits.maxValueBytes, "arguments");
        } catch (err) {
          fail((err as Error).message);
          return deferred.handle;
        }
        if (calls >= limits.maxCalls) {
          fail(`too many tool calls (limit ${limits.maxCalls} per run)`);
          return deferred.handle;
        }
        calls++;

        void (async () => {
          await acquire();
          try {
            const remaining = limits.deadlineMs - (Date.now() - started);
            const timeoutMs = Math.max(1, Math.min(limits.callTimeoutMs, remaining));
            const outcome = await input.callTool(server, tool, args, timeoutMs);
            boundedJson(outcome.value, limits.maxValueBytes, "tool result");
            if (outcome.failed) failedCalls++;
            done(outcome.value);
          } catch (err) {
            fail((err as Error).message);
          } finally {
            release();
          }
        })();
        return deferred.handle;
      })
    );
    ctx.setProp(ctx.global, "__call", callFn);

    // servers.<name> objects, built by the in-context helper above.
    const bindFn = keep(ctx.unwrapResult(ctx.evalCode(BIND_SERVER_SOURCE)));
    const serversObj = keep(ctx.newObject());
    for (const binding of input.bindings) {
      const serverH = ctx.newString(binding.server);
      const toolsH = binding.tools === "*" ? ctx.newString("*") : ctx.newArray();
      if (binding.tools !== "*") {
        binding.tools.forEach((t, i) => {
          const th = ctx.newString(t);
          ctx.setProp(toolsH, i, th);
          th.dispose();
        });
      }
      const built = ctx.callFunction(bindFn, ctx.undefined, serverH, toolsH, callFn);
      serverH.dispose();
      toolsH.dispose();
      const serverObj = ctx.unwrapResult(built);
      ctx.setProp(serversObj, binding.server, serverObj);
      serverObj.dispose();
    }
    ctx.setProp(ctx.global, "servers", serversObj);

    const evaluated = ctx.evalCode(WRAPPER_PREFIX + input.code + WRAPPER_SUFFIX, "script.js");
    if (evaluated.error) {
      const err = ctx.dump(evaluated.error) as { name?: string; message?: string; stack?: string };
      evaluated.error.dispose();
      return result(undefined, formatScriptError(err.name ?? "SyntaxError", err.message ?? String(err), err.stack));
    }
    const promise = keep(evaluated.value);

    // Drive the script: run promise continuations and wait for host calls to settle.
    for (;;) {
      if (interruptReason) throw new RunAbort(interruptReason);
      const state = ctx.getPromiseState(promise);
      if (state.type === "rejected") {
        const err = ctx.dump(state.error) as { name?: string; message?: string; stack?: string };
        state.error.dispose();
        return result(undefined, formatScriptError(err.name ?? "Error", err.message ?? String(err), err.stack));
      }
      if (state.type === "fulfilled") {
        const value = ctx.dump(state.value);
        state.value.dispose();
        boundedJson(value, limits.maxValueBytes, "return value");
        return result(value);
      }

      const jobs = runtime.executePendingJobs();
      if (jobs.error) {
        const err = ctx.dump(jobs.error) as { name?: string; message?: string; stack?: string };
        jobs.error.dispose();
        return result(undefined, formatScriptError(err.name ?? "Error", err.message ?? String(err), err.stack));
      }
      if (jobs.value === 0) {
        if (pendingNested === 0 && inFlight === 0 && waiting.length === 0) {
          return result(undefined, "script is waiting on a promise that never settles");
        }
        await new Promise((r) => setTimeout(r, 2));
      }
    }
  } catch (err) {
    if (err instanceof RunAbort) return result(undefined, err.message);
    const msg = (err as Error).message ?? String(err);
    // Memory or stack exhaustion surfaces as a host exception from the WASM module.
    return result(
      undefined,
      /memory|stack|Aborted|RuntimeError/i.test(msg)
        ? `script exceeded its memory or stack limit (${msg})`
        : msg
    );
  } finally {
    closed = true;
    for (const h of handles.reverse()) {
      if (h.alive) h.dispose();
    }
    context?.dispose();
    runtime.dispose();
  }
}
