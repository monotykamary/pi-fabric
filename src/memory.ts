// Lightweight public memory-source entry (pi-fabric/memory): portable source
// registration plus the explicit host client. No extension, UI, or command
// runtime is loaded through this subpath.
export {
  MEMORY_SOURCE_INTERFACE_VERSION,
  MemorySourceError,
  createMemorySourceRegistry,
  defineMemorySource,
} from "./memory/portable.js";
export type {
  MemorySourceAction,
  MemorySourceCoverage,
  MemorySourceErrorCode,
  MemorySourceListPage,
  MemorySourceRecord,
  MemorySourceRegistry,
  MemorySourceRequestContext,
  MemorySourceSessionDescriptor,
  MemorySourceSessionMetadata,
  MemorySourceSnapshot,
  PortableMemorySource,
} from "./memory/portable.js";
export { createMemorySourceClient } from "./memory/client.js";
export type {
  MemorySourceCallOptions,
  MemorySourceClientOptions,
} from "./memory/client.js";
export { memoryActionSchemas } from "./providers/memory-provider.js";
