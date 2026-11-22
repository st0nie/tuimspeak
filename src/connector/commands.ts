/**
 * Encoders for the ts-connector stdin protocol: one command per line.
 * Every free-text field is scrubbed of CR/LF here, and `ConnectorProcess`
 * scrubs the whole line again before writing, so no field can smuggle in a
 * second command.
 */

const oneLine = (text: string): string => text.replace(/[\r\n]+/g, " ").trim();
/** Tab-separated commands: tabs and newlines inside a field become spaces. */
const noTabs = (text: string): string => text.replace(/[\r\n\t]+/g, " ").trim();
const b64 = (text: string): string => Buffer.from(text, "utf8").toString("base64");
const int = (n: number): string => {
  if (!Number.isInteger(n)) throw new TypeError(`expected an integer id, got ${n}`);
  return String(n);
};

export const commands = {
  switchChannel: (channelId: number, password?: string) =>
    `switch ${int(channelId)}${password ? ` ${b64(password)}` : ""}`,
  chat: (message: string) => `chat ${oneLine(message)}`,
  serverChat: (message: string) => `serverchat ${oneLine(message)}`,
  privateMessage: (clientId: number, message: string) => `pm ${int(clientId)} ${oneLine(message)}`,
  poke: (clientId: number, message: string) => `poke ${int(clientId)} ${oneLine(message)}`,
  away: (message: string) => `away ${oneLine(message)}`,
  unaway: () => "unaway",
  muteInput: (muted: boolean) => `muteinput ${muted ? 1 : 0}`,
  muteOutput: (muted: boolean) => `muteoutput ${muted ? 1 : 0}`,
  nickname: (name: string) => `nickname ${oneLine(name)}`,
  /** One 20 ms frame: s16le mono 48 kHz, exactly 960 samples. */
  audio: (pcm: Uint8Array) => `audio ${Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength).toString("base64")}`,
  clientVolume: (clientId: number, factor: number) => `clientvolume ${int(clientId)} ${Number.isFinite(factor) ? factor : 1}`,
  whisper: (channelIds: number[], clientIds: number[]) =>
    channelIds.length === 0 && clientIds.length === 0
      ? "unwhisper"
      : `whisper ${channelIds.map(int).join(",")};${clientIds.map(int).join(",")}`,
  disconnect: (message = "") => `disconnect ${oneLine(message)}`.trimEnd(),

  // §8.3
  whisperPolicy: (block: boolean, exceptionClientIds: number[]) =>
    `whisperpolicy ${block ? "block" : "allow"};${exceptionClientIds.map(int).join(",")}`,

  // §9.2
  clientConnInfo: (clientId: number) => `clientconninfo ${int(clientId)}`,
  serverConnInfo: () => "serverconninfo",

  // §9.3
  moveClient: (clientId: number, channelId: number, password?: string) =>
    `moveclient ${int(clientId)} ${int(channelId)}${password ? ` ${b64(password)}` : ""}`,
  kickFromChannel: (clientId: number, reason: string) => `kickchannel ${int(clientId)} ${oneLine(reason)}`.trimEnd(),
  kickFromServer: (clientId: number, reason: string) => `kickserver ${int(clientId)} ${oneLine(reason)}`.trimEnd(),
  /** 0 seconds bans permanently. */
  ban: (clientId: number, seconds: number, reason: string) =>
    `banclient ${int(clientId)} ${Math.max(0, Math.floor(seconds))} ${oneLine(reason)}`.trimEnd(),
  banList: () => "banlist",
  banDelete: (banId: number) => `bandel ${int(banId)}`,
  banDeleteAll: () => "bandelall",
  complainList: () => "complainlist",
  complainDelete: (targetDbId: number, fromDbId: number) => `complaindel ${int(targetDbId)} ${int(fromDbId)}`,
  complainDeleteAll: (targetDbId: number) => `complaindelall ${int(targetDbId)}`,
  /** Only the fields given are changed; JSON keeps everything on one line. */
  serverEdit: (changes: { name?: string; welcomeMessage?: string; password?: string; maxClients?: number }) =>
    `serveredit ${JSON.stringify(changes)}`,
  serverQueryLogin: (user: string, password: string) => `serverquerylogin ${b64(user)} ${b64(password)}`,

  // §9.4
  serverGroupList: () => "servergrouplist",
  addServerGroup: (groupId: number, clientDbId: number) => `addservergroup ${int(groupId)} ${int(clientDbId)}`,
  removeServerGroup: (groupId: number, clientDbId: number) => `delservergroup ${int(groupId)} ${int(clientDbId)}`,
  channelGroupList: () => "channelgrouplist",
  setChannelGroup: (groupId: number, channelId: number, clientDbId: number) =>
    `setchannelgroup ${int(groupId)} ${int(channelId)} ${int(clientDbId)}`,

  // §9.5
  messageList: () => "messagelist",
  messageGet: (id: number) => `messageget ${int(id)}`,
  messageAdd: (uid: string, subject: string, text: string) => `messageadd ${noTabs(uid)}\t${noTabs(subject)}\t${noTabs(text)}`,
  messageDelete: (id: number) => `messagedel ${int(id)}`,
  messageMarkRead: (id: number) => `messageupdateflag ${int(id)} 1`,

  // §9.6
  fileList: (channelId: number, path: string) => `ftlist ${int(channelId)} ${oneLine(path) || "/"}`,
  fileDownload: (channelId: number, path: string) => `ftdownload ${int(channelId)} ${oneLine(path)}`,
  fileUploadChunk: (channelId: number, path: string, offset: number, total: number, data: Uint8Array) =>
    `ftuploadchunk ${int(channelId)}\t${int(offset)}\t${int(total)}\t${noTabs(path)}\t${Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString("base64")}`,
  fileMkdir: (channelId: number, path: string) => `ftmkdir ${int(channelId)} ${oneLine(path)}`,
  fileDelete: (channelId: number, path: string) => `ftdelete ${int(channelId)} ${oneLine(path)}`,
  fileRename: (channelId: number, from: string, to: string) => `ftrename ${int(channelId)}\t${noTabs(from)}\t${noTabs(to)}`,
};

/** Upload pieces: a multiple of 3 bytes so base64 pieces concatenate (§9.6). */
export const UPLOAD_CHUNK_BYTES = 192 << 10;
export const MAX_UPLOAD_BYTES = 24 << 20;
export const MAX_DOWNLOAD_BYTES = 25 << 20;

/** Text messages are only useful if they have content after scrubbing. */
export function hasContent(message: string): boolean {
  return oneLine(message).length > 0;
}
