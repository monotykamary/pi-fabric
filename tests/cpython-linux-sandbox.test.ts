import { describe, expect, it } from "vitest";
import { linuxCPythonNetworkFilter } from "../src/runtime/cpython-linux-sandbox.js";

// Interpret the small classic-BPF instruction subset to test every security
// branch on macOS CI too; Linux runtime tests additionally install the filter.
const evaluate = (filter: Buffer, architecture: number, syscall: number, address = 0n): number => {
  const input = Buffer.alloc(64);
  input.writeUInt32LE(syscall, 0);
  input.writeUInt32LE(architecture, 4);
  input.writeBigUInt64LE(address, 48);
  let accumulator = 0;
  for (let pc = 0; pc < filter.length / 8; pc++) {
    const offset = pc * 8;
    const operation = filter.readUInt16LE(offset);
    const yes = filter[offset + 2]!;
    const no = filter[offset + 3]!;
    const value = filter.readUInt32LE(offset + 4);
    switch (operation) {
      case 0x20: accumulator = input.readUInt32LE(value); break;
      case 0x15: pc += accumulator === value ? yes : no; break;
      case 0x45: pc += (accumulator & value) !== 0 ? yes : no; break;
      case 0x06: return value;
      default: throw new Error(`Unexpected BPF instruction ${operation}`);
    }
  }
  throw new Error("BPF did not terminate");
};

const denied = 0x00050001;
const allowed = 0x7fff0000;

describe.each([
  { architecture: "x64", audit: 0xc000003e, forbidden: [41, 42, 49, 46, 307, 425, 426, 427], sendto: 44, localPair: 53 },
  { architecture: "arm64", audit: 0xc00000b7, forbidden: [198, 203, 200, 211, 269, 425, 426, 427], sendto: 206, localPair: 199 },
])("CPython Linux seccomp $architecture", ({ architecture, audit, forbidden, sendto, localPair }) => {
  const filter = linuxCPythonNetworkFilter(architecture);
  it("denies socket creation, endpoint changes, message destinations and io_uring", () => {
    for (const syscall of forbidden) expect(evaluate(filter, audit, syscall)).toBe(denied);
  });
  it("allows writes to inherited fd3 and asyncio local socketpairs", () => {
    expect(evaluate(filter, audit, sendto)).toBe(allowed);
    expect(evaluate(filter, audit, localPair)).toBe(allowed);
    expect(evaluate(filter, audit, 1)).toBe(allowed);
  });
  it("denies low/high-word destination addresses even from socketpairs", () => {
    expect(evaluate(filter, audit, sendto, 1n)).toBe(denied);
    expect(evaluate(filter, audit, sendto, 1n << 32n)).toBe(denied);
  });
  it("kills alternate ABI execution and refuses x32 syscall numbers", () => {
    expect(evaluate(filter, 0x40000003, 1)).toBe(0x80000000);
    expect(evaluate(filter, audit, 0x40000000 + sendto)).toBe(denied);
  });
});

it("fails closed on unsupported Linux architectures", () => {
  expect(() => linuxCPythonNetworkFilter("ppc64")).toThrow("no unsandboxed fallback");
});
