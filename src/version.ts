import pkg from '../package.json' with { type: 'json' };

/** Reported to MCP clients as the server version. */
export const APP_VERSION: string = pkg.version;
