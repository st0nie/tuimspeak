import type { ConnectRequest } from "../app/controller.ts";

/**
 * Accepts `host`, `host:port` and
 * `ts3server://host?port=&nickname=&password=&channel=&token=` links (§9.1).
 */
export function parseAddress(input: string): Partial<ConnectRequest> & { address: string } {
  const text = input.trim();
  if (!/^ts3server:\/\//i.test(text)) return { address: text };
  const url = new URL(text.replace(/^ts3server:/i, "http:"));
  const q = url.searchParams;
  const port = q.get("port") ?? url.port;
  return {
    address: port ? `${url.hostname}:${port}` : url.hostname,
    nickname: q.get("nickname") ?? undefined,
    serverPassword: q.get("password") ?? undefined,
    defaultChannel: q.get("channel") ?? undefined,
    privilegeKey: q.get("token") ?? undefined,
  };
}
