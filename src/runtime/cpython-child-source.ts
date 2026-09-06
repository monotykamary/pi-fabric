// Embedded so installed bundles do not depend on a source-tree Python asset.
export const CPYTHON_CHILD_SOURCE = String.raw`
import sys
if sys.implementation.name != "cpython" or sys.version_info < (3, 10):
    sys.stderr.write("Fabric requires CPython 3.10 or newer; set executor.cpython.binary to a supported interpreter.\n")
    sys.exit(1)

import ast
import asyncio
import json
import math
import os
import socket
import sys
import traceback

_MAX_FRAME = 16 * 1024 * 1024
_MAX_INTEGER = 9007199254740991
_pending = {}
_next_id = 0
_writer = None


def _json_value(value):
    if value is None or isinstance(value, (str, bool)):
        return value
    if isinstance(value, int):
        if abs(value) > _MAX_INTEGER:
            raise ValueError("Fabric JSON integers must fit JavaScript's safe integer range; return a string instead")
        return value
    if isinstance(value, float) and math.isfinite(value):
        return value
    if isinstance(value, (list, tuple)):
        return [_json_value(item) for item in value]
    if isinstance(value, dict) and all(isinstance(key, str) for key in value):
        return {key: _json_value(item) for key, item in value.items()}
    raise TypeError("Fabric values must be JSON-compatible (no bytes, non-finite numbers, callables, or custom objects)")


async def _send(message):
    data = (json.dumps(_json_value(message), ensure_ascii=True, allow_nan=False) + "\n").encode("utf-8")
    if len(data) > _MAX_FRAME:
        raise ValueError("Fabric IPC frame exceeds 16 MiB")
    _writer.write(data)
    await _writer.drain()


class _HostError(Exception):
    def __init__(self, message, bash_exit=None):
        super().__init__(message)
        self.bash_exit = bash_exit


async def _call(ref, args):
    global _next_id
    if len(_pending) >= 256:
        raise RuntimeError("Fabric allows at most 256 outstanding host calls")
    _next_id += 1
    call_id = _next_id
    future = asyncio.get_running_loop().create_future()
    _pending[call_id] = future
    try:
        await _send({"type": "call", "id": call_id, "ref": ref, "args": args})
        return await future
    finally:
        _pending.pop(call_id, None)


async def _responses(reader):
    try:
        while True:
            line = await reader.readline()
            if not line:
                raise RuntimeError("Fabric host IPC closed")
            message = json.loads(line)
            if message.get("type") != "response":
                raise RuntimeError("Invalid Fabric host response")
            future = _pending.get(message.get("id"))
            if future is None or future.done():
                continue
            if message.get("ok") is True:
                future.set_result(message.get("value"))
            else:
                future.set_exception(_HostError(message.get("error", "Host call failed"), message.get("bashExit")))
    except Exception as error:
        for future in tuple(_pending.values()):
            if not future.done():
                future.set_exception(error)


_PRIMARY = {"read": "path", "ls": "path", "bash": "command", "powershell": "command", "grep": "pattern", "find": "pattern"}
_POSITIONAL = {"read": ["path", "offset", "limit"], "ls": ["path", "limit"], "grep": ["pattern", "path", "limit"], "find": ["pattern", "path", "limit"], "write": ["path", "content"], "edit": ["path", "oldText", "newText"], "bash": ["command"], "powershell": ["command"]}
_DISCOVERY = {"providers", "catalog", "list", "search", "describe", "call", "models", "progress"}


def _arguments(ref, positional, keywords):
    args = dict(keywords)
    if not positional:
        return args
    if len(positional) == 1 and isinstance(positional[0], dict):
        if args.keys() & positional[0].keys():
            raise TypeError("Duplicate Fabric argument keys")
        return {**positional[0], **args}
    if ref == "tools.search" and len(positional) == 1 and isinstance(positional[0], str):
        return {**args, "query": positional[0]}
    if ref.startswith("pi."):
        name = ref[3:]
        primary = _PRIMARY.get(name)
        if primary and len(positional) == 2 and isinstance(positional[0], str) and isinstance(positional[1], dict):
            return {**positional[1], **args, primary: positional[0]}
        fields = _POSITIONAL.get(name, [])
        if len(positional) <= len(fields):
            args.update(zip(fields, positional))
            if name == "edit" and ("oldText" in args or "newText" in args):
                args["edits"] = [{key: args.pop(key) for key in ("oldText", "newText") if key in args}]
            return args
    raise TypeError("Fabric calls accept a dictionary or keyword arguments; Pi tools also accept their documented positional arguments")


class _Proxy:
    def __init__(self, ref):
        self._ref = ref

    def __getattr__(self, name):
        if name.startswith("__"):
            raise AttributeError(name)
        return _Proxy(self._ref + "." + name)

    async def __call__(self, *positional, **keywords):
        ref = self._ref
        args = _arguments(ref, positional, keywords)
        if ref == "pi.edit" and "edits" not in args and ("oldText" in args or "newText" in args):
            args["edits"] = [{key: args.pop(key) for key in ("oldText", "newText") if key in args}]
        if ref.startswith("tools."):
            name = ref[6:]
            if name not in _DISCOVERY:
                raise AttributeError("tools is discovery/generic calls only; use pi for core tools")
            ref = "fabric.$" + name
        if ref in ("pi.bash", "pi.powershell") and "settle" in args and type(args["settle"]) is not bool:
            raise TypeError("pi shell settle must be a boolean; use settle=True or settle=False")
        settle = ref in ("pi.bash", "pi.powershell") and args.pop("settle", False) is True
        try:
            return await _call(ref, args)
        except _HostError as error:
            exit_info = error.bash_exit
            if settle and isinstance(exit_info, dict) and type(exit_info.get("exitCode")) is int and exit_info["exitCode"] > 0 and isinstance(exit_info.get("output"), str):
                return {"ok": False, "output": exit_info["output"], "details": None, "exitCode": exit_info["exitCode"], "error": str(error)}
            raise


class _Payloads:
    def __init__(self, values):
        self._values = dict(values)

    def __getitem__(self, name):
        if name not in self._values:
            raise KeyError("Payload " + repr(name) + " is missing; pass it in fabric_exec.payloads")
        return self._values[name]

    def __getattr__(self, name):
        return self[name]


def _error_text(error, source):
    # Keep user/library frames and exception chaining, not the embedded bridge.
    rendered = traceback.TracebackException.from_exception(error, limit=-24, capture_locals=False)
    lines = source.splitlines()
    pending = [(rendered, error)]
    seen = set()
    while pending:
        current, original = pending.pop()
        if id(current) in seen:
            continue
        seen.add(id(current))
        internal = set()
        tb = original.__traceback__
        while tb is not None:
            if tb.tb_frame.f_globals is globals():
                internal.add((tb.tb_frame.f_code.co_filename, tb.tb_lineno, tb.tb_frame.f_code.co_name))
            tb = tb.tb_next
        frames = []
        for frame in current.stack:
            if (frame.filename, frame.lineno, frame.name) in internal:
                continue
            if frame.filename == "fabric-exec.py":
                line = lines[frame.lineno - 1] if 0 < frame.lineno <= len(lines) else None
                frame = traceback.FrameSummary(frame.filename, frame.lineno,
                    "<fabric_exec>" if frame.name == "__fabric_program" else frame.name,
                    lookup_line=False, line=line)
            frames.append(frame)
        if isinstance(original, SyntaxError) and original.filename == "fabric-exec.py":
            frames = []
        current.stack = traceback.StackSummary.from_list(frames)
        if current.exc_type is _HostError:
            current.exc_type = RuntimeError
        if len(seen) >= 8:
            current.__cause__ = None
            current.__context__ = None
            if hasattr(current, "exceptions"):
                current.exceptions = None
            continue
        for field in ("__cause__", "__context__"):
            item = getattr(current, field)
            if item is not None:
                pending.append((item, getattr(original, field)))
        pending.extend(zip(getattr(current, "exceptions", None) or [], getattr(original, "exceptions", [])))
    text = "".join(rendered.format())
    if len(text) > 16000:
        text = text[:7900] + "\n[Python traceback truncated]\n" + text[-8000:]
    return text

async def _main():
    global _writer
    # Descriptor 3 is a dedicated inherited socket, never stdout/stderr.
    channel = socket.socket(fileno=3)
    reader, _writer = await asyncio.open_connection(sock=channel, limit=_MAX_FRAME)
    request = json.loads(await reader.readline())
    if request.get("type") != "execute":
        raise RuntimeError("Invalid Fabric execution request")
    response_task = asyncio.create_task(_responses(reader))
    try:
        # macOS does not provide a dependable address-space limit for CPython.
        # Linux bounds allocations; the parent owns the wall-clock deadline.
        if sys.platform.startswith("linux"):
            import resource
            resource.setrlimit(resource.RLIMIT_AS, (request["memoryLimitBytes"], request["memoryLimitBytes"]))
        source = request["code"]
        parsed = ast.parse(source, filename="fabric-exec.py", mode="exec")
        provided = request.get("strings", {})
        missing = set()
        for node in ast.walk(parsed):
            key = None
            if isinstance(node, ast.Attribute) and isinstance(node.value, ast.Name) and node.value.id in ("π", "payloads") and isinstance(node.ctx, ast.Load):
                key = node.attr
            elif isinstance(node, ast.Subscript) and isinstance(node.value, ast.Name) and node.value.id in ("π", "payloads") and isinstance(node.slice, ast.Constant) and isinstance(node.slice.value, str) and isinstance(node.ctx, ast.Load):
                key = node.slice.value
            if key is not None and key not in provided:
                missing.add(key)
        if missing:
            raise KeyError("Pre-execution check: missing payloads " + ", ".join(sorted(missing)) + "; pass these keys in fabric_exec.payloads")
        function = ast.parse("async def __fabric_program():\n    pass\n").body[0]
        function.body = parsed.body or function.body
        function.end_lineno = max(2, len(source.splitlines()))
        program = ast.fix_missing_locations(ast.Module(body=[function], type_ignores=[]))
        namespace = {name: _Proxy(name) for name in ("pi", "tools", "mcp", "extensions", "memory", "state", "schema", "components", "compact", "agents", "mesh")}
        payloads = _Payloads(request.get("strings", {}))
        namespace.update({"π": payloads, "payloads": payloads, "asyncio": asyncio, "__name__": "__fabric_guest__"})
        exec(compile(program, "fabric-exec.py", "exec"), namespace)
        value = await namespace["__fabric_program"]()
        sys.stdout.flush()
        sys.stderr.flush()
        await _send({"type": "result", "result": {"value": value, "terminationReason": "completed"}})
    except BaseException:
        await _send({"type": "result", "result": {"terminationReason": "runtime_error", "error": _error_text(sys.exception() if hasattr(sys, "exception") else sys.exc_info()[1], locals().get("source", ""))}})
    finally:
        response_task.cancel()
        await asyncio.gather(response_task, return_exceptions=True)


try:
    asyncio.run(_main())
except BaseException:
    traceback.print_exc()
    sys.exit(1)
`;
