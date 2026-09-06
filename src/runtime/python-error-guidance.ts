/** Pure diagnostic advice only; never rewrites code, retries, or changes backend policy.
 * Returns at most 900 characters, or undefined when no specific repair is known.
 * The caller owns appending this once, and should call only for runtime errors.
 */
export function pythonErrorRecoveryHint(code: string, error: string, backend: "monty" | "cpython"): string | undefined {
  // Inspect bounded ends so an oversized traceback cannot hide its exception summary.
  const text = error.slice(0, 8000) + "\n" + error.slice(-8000);
  const source = code.slice(0, 16000);
  if (/Execution (?:cancelled|canceled|aborted|timed out)|\b(?:AbortError|TimeoutError)\b|time limit exceeded|approval denied/i.test(text)) return undefined;
  if (/Pre-execution check: missing payloads|Payload .+ is missing|AttributeError:.*FabricPayloads.*has no attribute/.test(text)) {
    return "Supply every named key in fabric_exec.payloads before retrying; access those exact keys with π.name or payloads[\"name\"]. Do not invent payload names. Only a reported pre-execution check guarantees rejection before host calls; runtime lookups may follow earlier effects.";
  }
  if (/Invalid arguments for\s+[^\n]+:|Schema validation failed/i.test(text)) {
    return "Keep the callable ref and property path reported above. Inspect that callable with tools.describe, then pass a Python dictionary or keyword arguments matching its schema (quoted dictionary keys; True/False/None, not true/false/null). Fix the reported property, not the bridge or backend.";
  }
  if (/AttributeError:.*(?:dict|dictionary).*\boutput\b/.test(text)) {
    return 'Python host results are dictionaries, not JavaScript objects: use result["output"] or result.get("output"), not result.output. pi.read/grep/find/ls return strings directly; do not extract output from those strings.';
  }
  if (/NameError:.*\b(?:Promise|JSON|Object|Array|console|undefined|true|false|null)\b/.test(text)) {
    return "This invocation uses Python, not TypeScript. Use True/False/None, print(...), dictionary/list operations, and await asyncio.gather(...) for independent calls instead of Promise.all. Use Python-supported JSON facilities or return JSON-compatible values directly; JavaScript globals are unavailable.";
  }
  if (/NameError:.*\b(?:workflow|agent|rlm|council)\b/.test(text)) {
    return 'These are TypeScript guest orchestration helpers. In Python, use host actions such as await agents.run(task="...") and asyncio.gather; discover exact agent schemas with tools.describe. Select a TypeScript child explicitly if the task requires TypeScript-only callback helpers.';
  }
  if (/JSON-compatible|cyclic values|safe integers|numbers must be finite|cannot serialize.*(?:coroutine|bytes|set)|not JSON serializable/i.test(text)) {
    return 'Return finite scalars, lists, and string-keyed dictionaries without cycles. Await host calls before returning or indexing their results. Convert bytes, sets, and custom objects explicitly; callbacks and coroutine objects cannot cross the host bridge.';
  }
  if (backend === "monty" && /Monty.*(?:unavailable|incompatible)|optional.*(?:native|monty).*(?:missing|unavailable)|Cannot find.*(?:monty|native)/i.test(text)) {
    return "Install the configured @pydantic/monty version with its platform optional native dependency. Do not silently fall back. CPython requires an explicit executor.pythonRuntime='cpython' selection and trust approval for native execution.";
  }
  if (backend === "cpython" && /executor\.cpython\.binary|CPython 3\.10 or newer/.test(text)) {
    return "Set executor.cpython.binary to an installed CPython 3.10+ executable. Keep explicit native-execution trust and sandbox policy; do not substitute another interpreter or disable sandboxing automatically.";
  }
  if (backend === "monty" && /ImportError|ModuleNotFoundError|NotImplementedError|AttributeError|NameError:.*\bopen\b/.test(text)) {
    return "Monty supports a restricted Python subset, not arbitrary CPython imports or attributes. Use exposed pi/tools/mcp host calls for I/O; for unavailable proxy attributes use await tools.call(ref=\"provider.action\", args={...}) with the exact discovered ref. Native libraries require explicit trusted CPython configuration; never auto-enable or fall back.";
  }
  if (/\b(?:SyntaxError|IndentationError|TabError)\b/.test(text)) {
    return /(?:\b(?:const|let|var)\s+|=>|===|\bPromise\.|\bJSON\.)/.test(source)
      ? "This is a Python kernel: replace JavaScript declarations, arrow functions, and brace blocks with Python assignments, def, and indentation. Use True/False/None and await asyncio.gather(...) rather than Promise.all. Follow the reported fabric-exec.py line; do not rewrite or switch kernels automatically."
      : "Fix the reported fabric-exec.py line using Python syntax and consistent indentation. The code is an async function body: top-level await and return are supported. Check unmatched quotes/brackets and missing colons; do not add a wrapper or compensate for internal line offsets.";
  }
  return undefined;
}
