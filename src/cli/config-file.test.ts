import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  ConfigFileError,
  configFilePath,
  configFilePermSummary,
  readConfigFile,
  writeConfigFile,
} from "./config-file.ts";

describe("configFilePath", () => {
  it("lands under $HOME/.config/nocturne", () => {
    expect(configFilePath("/tmp/fakehome")).toBe(
      "/tmp/fakehome/.config/nocturne/config.json",
    );
  });
});

describe("readConfigFile", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "nocturne-config-"));
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("returns {} for a missing file", () => {
    expect(readConfigFile(join(tmp, "config.json"))).toEqual({});
  });

  it("parses a valid file", () => {
    const path = join(tmp, "config.json");
    writeFileSync(
      path,
      JSON.stringify({ model: "gpt-4o-mini", out_dir: "/x" }),
    );
    expect(readConfigFile(path)).toEqual({
      model: "gpt-4o-mini",
      out_dir: "/x",
    });
  });

  it("rejects malformed JSON", () => {
    const path = join(tmp, "config.json");
    writeFileSync(path, "{not json");
    expect(() => readConfigFile(path)).toThrow(ConfigFileError);
  });

  it("rejects unknown keys (strict schema)", () => {
    const path = join(tmp, "config.json");
    writeFileSync(path, JSON.stringify({ hello: "world" }));
    expect(() => readConfigFile(path)).toThrow(ConfigFileError);
  });

  it("rejects non-URL base_url", () => {
    const path = join(tmp, "config.json");
    writeFileSync(path, JSON.stringify({ base_url: "not-a-url" }));
    expect(() => readConfigFile(path)).toThrow(ConfigFileError);
  });

  it("accepts language: 'en'", () => {
    const path = join(tmp, "config.json");
    writeFileSync(path, JSON.stringify({ language: "en" }));
    const data = readConfigFile(path);
    expect(data.language).toBe("en");
  });

  it("accepts language: 'zh'", () => {
    const path = join(tmp, "config.json");
    writeFileSync(path, JSON.stringify({ language: "zh" }));
    const data = readConfigFile(path);
    expect(data.language).toBe("zh");
  });

  it("rejects language: 'fr' (not in enum)", () => {
    const path = join(tmp, "config.json");
    writeFileSync(path, JSON.stringify({ language: "fr" }));
    expect(() => readConfigFile(path)).toThrow(ConfigFileError);
  });

  it("rejects language: 'english' (long form not accepted)", () => {
    const path = join(tmp, "config.json");
    writeFileSync(path, JSON.stringify({ language: "english" }));
    expect(() => readConfigFile(path)).toThrow(ConfigFileError);
  });

  it("rejects language: '' (empty string rejected by enum)", () => {
    const path = join(tmp, "config.json");
    writeFileSync(path, JSON.stringify({ language: "" }));
    expect(() => readConfigFile(path)).toThrow(ConfigFileError);
  });

  it("succeeds with language undefined when not set", () => {
    const path = join(tmp, "config.json");
    writeFileSync(path, JSON.stringify({}));
    const data = readConfigFile(path);
    expect(data.language).toBeUndefined();
  });
});

describe("writeConfigFile", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "nocturne-config-"));
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("creates the file with mode 0600", () => {
    const path = join(tmp, ".config", "nocturne", "config.json");
    writeConfigFile({ model: "deepseek-chat" }, path);
    const st = statSync(path);
    expect(st.mode & 0o777).toBe(0o600);
  });

  it("merges with existing values", () => {
    const path = join(tmp, "config.json");
    writeConfigFile({ model: "deepseek-chat" }, path);
    writeConfigFile({ out_dir: "/custom" }, path);
    expect(readConfigFile(path)).toEqual({
      model: "deepseek-chat",
      out_dir: "/custom",
    });
  });

  it("explicit undefined removes a key", () => {
    const path = join(tmp, "config.json");
    writeConfigFile({ model: "deepseek-chat", out_dir: "/x" }, path);
    writeConfigFile({ model: undefined }, path);
    expect(readConfigFile(path)).toEqual({ out_dir: "/x" });
  });

  it("configFilePermSummary returns null for missing file, octal for existing", () => {
    const path = join(tmp, "config.json");
    expect(configFilePermSummary(path)).toBeNull();
    writeConfigFile({ model: "x" }, path);
    expect(configFilePermSummary(path)).toBe("0600");
  });
});
