import pkg from "../package.json" with { type: "json" };

/** The release version, compiled into the executable (architecture §12.1). */
export const VERSION: string = pkg.version;
