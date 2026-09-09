import fs from "node:fs";
import path from "node:path";

/**
 * Move an unreadable JSON document aside so the original path can be
 * recreated, without deleting evidence the operator may still want.
 */
export const quarantineDamagedFile = (filePath: string): string | undefined => {
  const destination = path.join(
    path.dirname(filePath),
    `${path.basename(filePath)}.damaged.${process.pid}.${Date.now()}`,
  );
  try {
    fs.renameSync(filePath, destination);
    return destination;
  } catch {
    return undefined;
  }
};
