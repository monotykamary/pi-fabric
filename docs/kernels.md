# Execution kernels

`fabric_exec` runs one program in the **configured kernel**. `executor.kernel` is `"typescript"` by default; select `"python"` for sandboxed Python through **Monty**. CPython requires explicit native escape-hatch selection. The choice is exclusive: there is **no per-call kernel selector**, language autodetection, or fallback to the other language. Change configuration to switch languages, not the tool arguments.

## Select Python

Monty is the default Python backend; a system Python installation is not required. Add this to `~/.pi/agent/fabric.json` for global defaults, or `<project>/.pi/fabric.json` for a trusted project's override:

```json
{
  "executor": {
    "kernel": "python"
  }
}
```

Project settings override global settings; untrusted project config is not loaded. `executor.pythonRuntime` defaults to `"monty"`; no extra enabled flag is needed. Fabric installs the optional, pinned `@pydantic/monty` native package on supported platforms and loads it lazily only for Monty execution. Missing/incompatible native dependencies fail with an installation hint, **never** a CPython fallback. Monty runs a Python subset, not a CPython installation; see [subset limitations](#monty-subset-limitations).

Alternatively, open `/fabric settings` → **Executor**, select **Kernel** → `python`, and keep **Runtime (Python)** → `monty`. **Runtime (TS)** controls only the TypeScript backend (`quickjs`, `node-process`, or `bun-process`); Python ignores that setting. Set **Kernel** back to `typescript` to restore TypeScript programs.

See [configuration](configuration.md) for save scopes, timeout ceilings, result formatting, and the full reference.

### Explicit CPython escape hatch

For full native Python and installed packages, install **CPython 3.10+** and opt in:

```json
{
  "executor": {
    "kernel": "python",
    "pythonRuntime": "cpython",
    "cpython": { "binary": "python3" }
  }
}
```

`executor.cpython.binary` is an executable name on `PATH` or a path, not shell arguments. An absolute path selects a particular interpreter. Setting only the binary does not select Python or disable Monty. CPython is trusted native code outside schema enforce, just as Node/Bun are TypeScript escape hatches. Host approvals do not cover direct native OS operations. Under enforce, CPython requires the additional OS isolation described below.

## Agent kernel inheritance

An agent request may select a **child's** language with `kernel: "typescript" | "python" | "inherit"` on `agents.run`, `agents.spawn`, `agents.create`, or `agents.handoff`. Omitted/`inherit` uses the caller's configured kernel. This is not a per-call selector on `fabric_exec`: its current program must still use the current kernel's syntax. Skills can choose the language that best fits their model and task; workflow, council, and RLM requests forward the option. See [agents](agents.md#choose-the-childs-language) for cross-language examples.

Concrete agent kernels require Pi with Fabric extensions enabled. Claude, Veda, and `extensions: false` reject them before launch; omitted/`inherit` remains valid but does not assign those runners a Fabric kernel. Actors keep the resolved language and Python backend for their persistent session; `ask`/`tell` cannot switch them. Inactive global templates resolve inheritance when imported, not when saved.

Workers receive a resolved `--kernel` and configured `--python-runtime`, then pass `PI_FABRIC_KERNEL` and `PI_FABRIC_PYTHON_RUNTIME` to their child process. `loadFabricConfig` applies these validated inherited overrides **after** global/trusted-project disk merge. Recursive and alternate-cwd children therefore keep the caller's language and backend policy; durable and trajectory handoffs snapshot policy before transfer. Disk settings and scope-specific settings views are not rewritten. The Python backend is configuration policy, not a public per-agent argument.

Only exact `typescript`/`python` environment kernel values and `cpython`/`monty` backend values are valid. Any present invalid override, including empty strings, casing variants, and `inherit`, makes configuration loading fail; there is no automatic native-execution fallback. Unset overrides use normal disk/default resolution. For backward compatibility, old standalone worker argv without these flags defaults to TypeScript/Monty and ignores ambient selectors. Non-Fabric workers clear both selectors from their child environment. Malformed disk `pythonRuntime` values normalize to the sandboxed `monty` default; inherited environment overrides are deliberately stricter.

## Write a Python program

The `code` argument is a **Python async function body**. Write ordinary Python statements, with top-level `await` and `return`; do not add a surrounding `async def` or invoke an event loop yourself. Every invocation starts fresh, so guest variables do not persist. Return a JSON-compatible value to the model; `print()` is for activity logs.

Python example (the contents of `fabric_exec.code`):

```python
import asyncio

manifest, sources = await asyncio.gather(
    pi.read("package.json"),
    pi.find({"pattern": "**/*.py", "path": "src"}),
)
return {
    "manifest": manifest,
    "sourceCount": len(sources.splitlines()),
    "checked": True,
    "error": None,
}
```

Use `asyncio.gather` only for independent calls; use sequential `await` when later work depends on an earlier result. Search before reading and return compact evidence; omit unused intermediate tool output.

### Core tools and native results

Host calls are async. `pi.read` accepts a path, a dictionary, or keyword arguments:

```python
text = await pi.read("README.md")
window = await pi.read({"path": "src/config.ts", "offset": 1, "limit": 40})
other_window = await pi.read(path="src/config.ts", offset=41, limit=40)
return {"readmeLines": len(text.splitlines()), "window": window, "next": other_window}
```

`pi.read`, `pi.grep`, `pi.find`, and `pi.ls` return strings. `pi.bash`, `pi.powershell` (Windows only), `pi.edit`, and `pi.write` return **native Python dictionaries**, not objects with attribute access:

```python
r = await pi.bash({"command": "git status --short", "settle": True})
return {"ok": r["ok"], "output": r["output"]}
```

Use `r['output']`, not `r.output`. Prefer canonical schema field names. Python and TypeScript share core object repairs: `cmd` → `command`, `file_path` → `path`, edit `old_string`/`new_string` → `oldText`/`newText`, write `text` → `content`, numeric-string coercion, shell `timeoutMs` conversion, and removal of null optional fields. Canonical values win conflicts; declared override properties stay canonical even when named like an alias. These repairs apply to direct calls and `tools.call`. Unknown fields still reject, including nested edits; `all` and `settle` must be booleans. Source-text repair remains language-specific: Python is never passed through the TypeScript rewriter. Shell calls raise on ordinary nonzero exits unless `settle=True`; timeout, cancellation, approval, and security failures still raise. Python uses `True`, `False`, and `None`, not JavaScript's `true`, `false`, and `null`. Do not paste TypeScript object literals, `const`, or `Promise.all` into a Python program.

### Named payloads

Keep multiline content outside `code` in the tool's top-level `payloads` map. For a call with `payloads: {"content": "..."}`, access that exact key through `π.content` or `payloads['content']`:

```python
text = π.content
r = await pi.write({"path": "notes.txt", "content": payloads["content"]})
return {"output": r["output"], "chars": len(text)}
```

`π` and `payloads` are data, not tools. Only use keys supplied in the same call. Mutating core tools remain subject to approvals and schema enforcement; this write example is not a bypass for schema transactions.

### Shared host bridge, not TypeScript syntax

Python uses the same host action namespaces: `tools`, `mcp`, `memory`, `state`, `schema`, `compact`, `agents`, `mesh`, and other registered Fabric providers. Full code mode also exposes `pi` and `extensions`; schema enforce uses the full-code bridge. Known actions use direct async calls, while computed refs use `tools.call`:

```python
hits = await tools.search({"query": "deployment status", "limit": 3})
if not hits:
    return None
return await tools.describe({"ref": hits[0]["ref"]})
```

For example, `await schema.status()` takes no arguments; `await tools.call({"ref": ref, "args": args})` invokes a computed ref. MCP names remain sanitized as `mcp.<server>.<tool>`. Arguments and results cross the bridge as JSON-compatible data and become Python dictionaries, lists, and scalar values.

Host actions retain the same registry/schema validation, approvals, audit, timeout, and cancellation paths. Python programs do **not** receive the static TypeScript check; Python syntax/runtime errors and authoritative host validation report failures instead. Use `await tools.describe({"ref": ref})` to inspect an action's actual schema before calling it.

Guest-local callback APIs are not automatically available just because host providers share namespaces. In particular, do not assume TypeScript's `memory.walk(args, visitor)`, callback-based workflow helpers, or `agents.handoff({when: ...})` predicates work in Python. Use host actions such as `memory.expand` with explicit Python loops and `asyncio.gather` instead; follow returned paging refs through `tools.call`. Existing TypeScript workflow/skill examples are TypeScript-only unless explicitly documented for Python.

## Repair, diagnostics, and compiler boundaries

Python syntax/runtime errors report user source lines and bounded recovery hints without bridge/bootstrap frames. Common dictionary-access mistakes, JavaScript globals, invalid schemas, and unsupported imports include Python-specific next steps. Hints do not retry effects, rewrite source, or enable native execution. Monty preflights direct identifiers and unescaped literal payload keys, including f-string replacement fields; lexical nesting beyond 64 levels fails closed. Dynamic or escaped-key lookups remain runtime checks and can fail after earlier effects. Only a reported pre-execution rejection guarantees no prior host calls.

The [repair and entropy compilers](entropy.md#kernel-boundary) operate on canonical host-call schemas, audits, and valid trace records, not Python source or traceback prose. Their catalog binding, validation, approvals, and quarantine rules remain active for both Python backends. Compiled overlays can restrict enums; they cannot remove required fields or weaken declared types.

[sPTC](speculation.md) currently supports effective TypeScript/QuickJS only. Python and native TypeScript skip speculative dispatch; they still execute normal host calls. Kernel/backend/policy changes clear and replace speculative state. No Python prefetch parser or TypeScript-parser approximation is claimed.

## Monty subset limitations

[Monty](https://github.com/pydantic/monty) is a sandboxed Python interpreter, **not CPython**, and is not a drop-in implementation of its standard library or installed packages. Only supported Python syntax/modules are available. `asyncio.gather` is tested; do not assume arbitrary `asyncio`, filesystem, networking, environment, subprocess, import, or third-party APIs exist. Use host actions for effects.

- Supply **acyclic JSON-compatible arguments**. The upstream native API may replace recursive host-argument containers with repr strings before Fabric sees them; cyclic arguments are unsupported. Final return values are additionally checked in the guest, so cyclic results fail without silently changing shape.
- Use string dictionary keys, finite numbers, and safe integers. Convert bytes/sets/custom objects explicitly; results and bridge data are bounded.
- Monty currently blocks direct capability attributes starting with `_`. For names such as `mcp._123._tool`, use `await tools.call(ref="mcp._123._tool", args={...})` with the exact discovered ref instead.
- `π` is an explicit-attribute payload object; `payloads` is a native dictionary with the same supplied keys, not the same object identity. Prefer `payloads["key"]` for keys that are not public Python identifiers.
- Every call uses a fresh native Monty worker with VM resource limits and a host watchdog. No CPython worker, system Python, or WASM fallback is used.

## Isolation and resource limits

| Kernel / backend | Security boundary |
| --- | --- |
| TypeScript / QuickJS (default) | Isolated WASM guest with host-mediated capabilities. |
| TypeScript / Node or Bun process | Trusted native code; no security sandbox. |
| Python / Monty (default), all schema modes | Sandboxed Python subset, VM allocation limits, host-mediated capabilities only. |
| Python / CPython, schema off or audit | Trusted native code with the local user's full OS privileges; no security sandbox. |
| Python / CPython, schema enforce | Required OS isolation: macOS `sandbox-exec` or Linux `bwrap` (bubblewrap), plus the same host schema gate. |

Selecting Python uses the Monty sandbox by default. Selecting **CPython** is an explicit opt-in to native execution. Outside schema enforce, generated CPython code can use native OS access; host approvals and audit cover bridge calls, not arbitrary Python file/network/subprocess operations. Only run code and projects you trust with your user account's authority.

**Schema enforce preserves the configured kernel.** TypeScript uses QuickJS even if a native TS backend was configured. Python stays Python: Monty remains sandboxed; explicit CPython additionally requires OS isolation. If the required isolation mechanism is unavailable or cannot launch, execution **fails closed**; it does not run unrestricted or silently fall back to TypeScript. Protected-workspace changes still use `schema.hypothesize` → `schema.verify` → `schema.commit` through the host bridge. Schema mode changes take effect in the next session.

On Linux, bubblewrap also requires usable unprivileged user namespaces. The bundled seccomp network filter supports x86-64 and ARM64; unsupported architectures fail closed without omitting that protection.

`executor.memoryLimitBytes` enforces Monty VM allocation limits; host-result and output bounds apply separately. A hard process watchdog interrupts CPU loops and pending host calls on timeout/cancellation, while host-call floors can raise the configured deadline.

For explicit CPython, `executor.memoryLimitBytes` bounds the process address space through `RLIMIT_AS` where the OS supports it. The current runtime applies it on Linux; macOS does not provide a dependable CPython address-space limit, so it is not enforced there. This is not a portable hard resident-memory cap: OS support varies, interpreter/library mappings count toward address space, and native allocations can fail before your data reaches the configured size. The configuration ceiling is detected physical memory, not QuickJS's WASM32 ceiling. Choose a limit large enough for the interpreter and workload without exhausting the machine.

Timeout, cancellation, process termination, and resource limits constrain execution; **process limits are not a security sandbox**. They do not replace enforce-mode OS isolation. See [configuration](configuration.md#executor-timeouts-and-ceilings) for shared deadline policy.
