import { resolve } from "node:path";

export interface ServerConfig {
  apiToken: string;
  host: string;
  port: number;
  stateFile: string;
  publicDir: string;
  logLevel: string;
}

function parsePort(value: string | undefined): number {
  const port = Number(value ?? "3000");
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("PORT must be an integer between 1 and 65535");
  }
  return port;
}

export function loadConfig(environment = process.env): ServerConfig {
  const apiToken = environment.KITCHEN_DISPLAY_API_TOKEN;
  if (!apiToken || apiToken.length < 32) {
    throw new Error(
      "KITCHEN_DISPLAY_API_TOKEN must contain at least 32 characters",
    );
  }

  return {
    apiToken,
    host: environment.HOST ?? "127.0.0.1",
    port: parsePort(environment.PORT),
    stateFile: resolve(environment.STATE_FILE ?? "data/state.json"),
    publicDir: resolve(environment.PUBLIC_DIR ?? "dist/client"),
    logLevel: environment.LOG_LEVEL ?? "info",
  };
}
