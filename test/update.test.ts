import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { assetName, compareVersions, currentPlatform, installRelease, managedVersionDir, parseChecksum, switchLauncher } from "../src/update.ts";

describe("update helpers (§12.4)", () => {
  test("version comparison, including pre-releases", () => {
    expect(compareVersions("0.2.0", "0.1.9")).toBe(1);
    expect(compareVersions("v1.0.0", "1.0.0")).toBe(0);
    expect(compareVersions("1.0.0-rc.1", "1.0.0")).toBe(-1);
    expect(compareVersions("1.10.0", "1.9.3")).toBe(1);
  });

  test("platforms and asset names", () => {
    expect(currentPlatform("darwin", "arm64")).toBe("darwin-arm64");
    expect(currentPlatform("linux", "x64")).toBe("linux-x64");
    expect(currentPlatform("win32", "x64")).toBe("windows-x64");
    expect(currentPlatform("win32", "arm64")).toBeNull();
    expect(currentPlatform("freebsd", "x64")).toBeNull();
    expect(assetName("windows-x64")).toBe("tuimspeak-windows-x64.zip");
    expect(assetName("linux-arm64")).toBe("tuimspeak-linux-arm64.tar.gz");
  });

  test("a copy is managed when it runs from a version directory", () => {
    const versions = resolve("/d/tuimspeak/versions");
    expect(managedVersionDir(join(versions, "0.1.0", "tuimspeak"), versions)).toBe(join(versions, "0.1.0"));
    expect(managedVersionDir(resolve("/usr/local/bin/tuimspeak"), versions)).toBeNull();
  });

  test("checksum files", () => {
    const hash = "a".repeat(64);
    expect(parseChecksum(`${hash.toUpperCase()}  tuimspeak-linux-x64.tar.gz\n`)).toBe(hash);
    expect(() => parseChecksum("nope")).toThrow();
  });

  test("the Windows launcher is a .cmd running the version's exe", () => {
    const dir = mkdtempSync(join(tmpdir(), "tuim-launch-"));
    const launcher = join(dir, "bin", "tuimspeak.cmd");
    switchLauncher("C:\\v\\0.2.0", launcher, "win32");
    expect(readFileSync(launcher, "utf8")).toContain('"C:\\v\\0.2.0');
    expect(readFileSync(launcher, "utf8")).toContain("tuimspeak.exe\" %*");
  });
});

describe.skipIf(process.platform === "win32")("installRelease (§12.2)", () => {
  test("downloads, verifies, unpacks, switches the symlink and prunes", async () => {
    const root = mkdtempSync(join(tmpdir(), "tuim-install-"));
    const stage = join(root, "stage", "tuimspeak-linux-x64");
    mkdirSync(stage, { recursive: true });
    writeFileSync(join(stage, "tuimspeak"), "#!/bin/sh\necho new\n");
    chmodSync(join(stage, "tuimspeak"), 0o755);
    const archive = join(root, "tuimspeak-linux-x64.tar.gz");
    expect(spawnSync("tar", ["-czf", archive, "-C", join(root, "stage"), "tuimspeak-linux-x64"]).status).toBe(0);
    const bytes = readFileSync(archive);
    const sum = `${createHash("sha256").update(bytes).digest("hex")}  tuimspeak-linux-x64.tar.gz\n`;

    const versionsDir = join(root, "versions");
    mkdirSync(join(versionsDir, "0.0.1"), { recursive: true });
    mkdirSync(join(versionsDir, "0.0.2"), { recursive: true });
    const launcher = join(root, "bin", "tuimspeak");
    const fetchImpl = (async (url: string) => new Response(url.endsWith(".sha256") ? sum : bytes)) as unknown as typeof fetch;
    const release = {
      version: "0.2.0",
      assets: [
        { name: "tuimspeak-linux-x64.tar.gz", url: "https://x/tuimspeak-linux-x64.tar.gz" },
        { name: "tuimspeak-linux-x64.tar.gz.sha256", url: "https://x/tuimspeak-linux-x64.tar.gz.sha256" },
      ],
    };
    const target = await installRelease(release, { fetchImpl, versionsDir, launcher, platform: "linux-x64", keep: [join(versionsDir, "0.0.2")] });
    expect(target).toBe(join(versionsDir, "0.2.0"));
    expect(readlinkSync(launcher)).toBe(join(target, "tuimspeak"));
    expect(existsSync(join(versionsDir, "0.0.1"))).toBe(false);
    expect(existsSync(join(versionsDir, "0.0.2"))).toBe(true);

    const bad = (async (url: string) => new Response(url.endsWith(".sha256") ? `${"0".repeat(64)}  x\n` : bytes)) as unknown as typeof fetch;
    await expect(installRelease(release, { fetchImpl: bad, versionsDir, launcher, platform: "linux-x64" })).rejects.toThrow("checksum mismatch");
  });
});
