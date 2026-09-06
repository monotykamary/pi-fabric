import { spawnSync } from "node:child_process";

export const pythonBackends = ["monty", "cpython"] as const;
const python = spawnSync("python3", ["-I", "-B", "-c", "import sys; sys.exit(0 if sys.implementation.name == 'cpython' and sys.version_info >= (3, 10) else 1)"]);
export const availablePythonBackends = {
  cpython: python.status === 0,
  monty: await import("@pydantic/monty/node").then(() => true, () => false),
};
