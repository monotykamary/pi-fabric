// Classic BPF consumed by bubblewrap --seccomp. A read-only root and a new
// network namespace alone still expose host pathname Unix sockets. Deny new
// sockets, endpoint changes, and io_uring's alternate socket path. Existing
// fd3 writes (sendto with a null destination) and local asyncio socketpairs work.
export const linuxCPythonNetworkFilter = (architecture: string): Buffer => {
  const platform = architecture === "x64"
    ? { audit: 0xc000003e, socket: 41, connect: 42, bind: 49, sendto: 44, sendmsg: 46, sendmmsg: 307 }
    : architecture === "arm64"
      ? { audit: 0xc00000b7, socket: 198, connect: 203, bind: 200, sendto: 206, sendmsg: 211, sendmmsg: 269 }
      : undefined;
  if (!platform) throw new Error(`Schema enforce CPython seccomp is unsupported on ${architecture}; no unsandboxed fallback is permitted.`);
  const instructions: Array<[number, number, number, number]> = [];
  const load = (offset: number): void => { instructions.push([0x20, 0, 0, offset]); };
  const equal = (value: number, yes: number, no: number): void => { instructions.push([0x15, yes, no, value]); };
  const ret = (value: number): void => { instructions.push([0x06, 0, 0, value]); };
  const deny = 0x00050001; // SECCOMP_RET_ERRNO | EPERM
  const allow = 0x7fff0000;
  load(4); // seccomp_data.arch
  equal(platform.audit, 1, 0);
  ret(0x80000000); // KILL_PROCESS for alternate syscall ABIs
  load(0); // seccomp_data.nr
  instructions.push([0x45, 0, 1, 0x40000000]); // Refuse x32 ABI syscall numbers.
  ret(deny);
  for (const syscall of [platform.socket, platform.connect, platform.bind, platform.sendmsg, platform.sendmmsg, 425, 426, 427]) {
    equal(syscall, 0, 1);
    ret(deny);
  }
  equal(platform.sendto, 1, 0);
  ret(allow);
  load(48); // sendto argument 4: sockaddr pointer (low word)
  equal(0, 1, 0);
  ret(deny);
  load(52); // high word, both supported architectures are little-endian
  equal(0, 1, 0);
  ret(deny);
  ret(allow);
  const bytes = Buffer.alloc(instructions.length * 8);
  for (const [index, [code, yes, no, value]] of instructions.entries()) {
    bytes.writeUInt16LE(code, index * 8);
    bytes[index * 8 + 2] = yes;
    bytes[index * 8 + 3] = no;
    bytes.writeUInt32LE(value, index * 8 + 4);
  }
  return bytes;
};
