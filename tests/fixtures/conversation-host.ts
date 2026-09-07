import * as host from "@earendil-works/pi-coding-agent";
import { initializeConversationHost } from "../../src/ui/conversation-host.js";

// Direct component tests bypass the eager controller's host injection.
initializeConversationHost(host);
