// src/tool-chain/index.ts
// Public surface of tool chain: run a script, build stubs, convert results.

export { runCode, DEFAULT_LIMITS, formatScriptError } from "./sandbox.js";
export type { RunInput, RunOutput, RunLimits, CodeBinding, NestedCall } from "./sandbox.js";
export { toolSignature, serverStubs, summarizeDescription, STUB_HEADER, schemaToType } from "./stubs.js";
export { toScriptResult, toScriptValue } from "./results.js";
export type { ScriptError } from "./results.js";
