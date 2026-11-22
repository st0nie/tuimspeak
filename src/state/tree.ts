import type { ChannelInfo, ClientInfo, Snapshot } from "../connector/protocol.ts";

export type TreeRow =
  | { kind: "server"; depth: 0; key: string }
  | { kind: "channel"; depth: number; key: string; channel: ChannelInfo; hasChildren: boolean; expanded: boolean; clientCount: number; spacer: Spacer | null }
  | { kind: "client"; depth: number; key: string; client: ClientInfo };

export interface Spacer {
  align: "left" | "center" | "right" | "repeat";
  text: string;
}

/**
 * TeamSpeak "spacer" channels: top-level channels named like
 * `[spacer0]`, `[cspacer]Title`, `[rspacer]x`, `[*spacer]-`. They render as
 * decoration instead of a channel name.
 */
export function parseSpacer(channel: ChannelInfo): Spacer | null {
  if (channel.parent !== 0) return null;
  const m = /^\[([clr*]?)spacer[^\]]*\](.*)$/i.exec(channel.name);
  if (!m) return null;
  const flag = m[1]!.toLowerCase();
  const align = flag === "c" ? "center" : flag === "r" ? "right" : flag === "*" ? "repeat" : "left";
  return { align, text: m[2] ?? "" };
}

function byOrder(a: ChannelInfo, b: ChannelInfo): number {
  return a.order - b.order || a.id - b.id;
}

/** TS3 lists clients alphabetically within a channel (talk power ordering is not exposed by the connector). */
function byName(a: ClientInfo, b: ClientInfo): number {
  return a.name.localeCompare(b.name, undefined, { sensitivity: "base" }) || a.id - b.id;
}

export interface TreeOptions {
  collapsed: Record<number, true>;
  showQueryClients: boolean;
  /** Case-insensitive filter; matching rows stay visible with their parent channels. */
  filter?: string;
}

/** Flattens the snapshot into the rows the tree renders, in display order. */
export function buildTree(snapshot: Snapshot, options: TreeOptions): TreeRow[] {
  const children = new Map<number, ChannelInfo[]>();
  for (const ch of snapshot.channels) {
    const list = children.get(ch.parent);
    if (list) list.push(ch);
    else children.set(ch.parent, [ch]);
  }
  for (const list of children.values()) list.sort(byOrder);

  const clientsIn = new Map<number, ClientInfo[]>();
  for (const c of snapshot.clients) {
    if (c.isQuery && !options.showQueryClients) continue;
    const list = clientsIn.get(c.channel);
    if (list) list.push(c);
    else clientsIn.set(c.channel, [c]);
  }
  for (const list of clientsIn.values()) list.sort(byName);

  const filter = options.filter?.trim().toLowerCase() || "";
  const matches = (name: string) => name.toLowerCase().includes(filter);

  // With a filter, a channel is shown when it, a client in it, or a descendant matches.
  const visibleCache = new Map<number, boolean>();
  const subtreeMatches = (ch: ChannelInfo): boolean => {
    const cached = visibleCache.get(ch.id);
    if (cached !== undefined) return cached;
    const result =
      matches(ch.name) ||
      (clientsIn.get(ch.id) ?? []).some((c) => matches(c.name)) ||
      (children.get(ch.id) ?? []).some(subtreeMatches);
    visibleCache.set(ch.id, result);
    return result;
  };

  const rows: TreeRow[] = [{ kind: "server", depth: 0, key: "server" }];
  const walk = (parent: number, depth: number) => {
    for (const ch of children.get(parent) ?? []) {
      if (filter && !subtreeMatches(ch)) continue;
      const clients = clientsIn.get(ch.id) ?? [];
      const subChannels = children.get(ch.id) ?? [];
      const hasChildren = clients.length > 0 || subChannels.length > 0;
      // A filter forces everything that matches open.
      const expanded = filter ? true : !options.collapsed[ch.id];
      rows.push({
        kind: "channel",
        depth,
        key: `ch:${ch.id}`,
        channel: ch,
        hasChildren,
        expanded,
        clientCount: clients.length,
        spacer: parseSpacer(ch),
      });
      if (!expanded) continue;
      for (const c of clients) {
        if (filter && !matches(c.name) && !matches(ch.name)) continue;
        rows.push({ kind: "client", depth: depth + 1, key: `cl:${c.id}`, client: c });
      }
      walk(ch.id, depth + 1);
    }
  };
  walk(0, 1);
  return rows;
}

export function findChannelPath(snapshot: Snapshot, channelId: number): ChannelInfo[] {
  const byId = new Map(snapshot.channels.map((c) => [c.id, c]));
  const path: ChannelInfo[] = [];
  let current = byId.get(channelId);
  while (current) {
    path.unshift(current);
    current = current.parent ? byId.get(current.parent) : undefined;
  }
  return path;
}
