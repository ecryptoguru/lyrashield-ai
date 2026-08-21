import { describe, it, expect } from "vitest";
import { validateUpdaterManifest } from "./validate-updater-manifest.mjs";

const validManifest = {
  version: "0.1.0",
  notes: "LyraShield Local/Desktop v0.1.0",
  pub_date: "2026-08-22T00:00:00Z",
  platforms: {
    "darwin-aarch64": {
      signature: "dW50cnVzdGVkIGNvbW1lbnQ6IHNpZ25hdHVyZSBkYXRhIHNpZ25hdHVyZSBkYXRhIGFiY2RlZmc=",
      url: "https://github.com/ecryptoguru/lyrashield-ai/releases/download/v0.1.0/LyraShield_0.1.0_universal.dmg.tar.gz",
    },
    "darwin-x86_64": {
      signature: "dW50cnVzdGVkIGNvbW1lbnQ6IHNpZ25hdHVyZSBkYXRhIHNpZ25hdHVyZSBkYXRhIGFiY2RlZmc=",
      url: "https://github.com/ecryptoguru/lyrashield-ai/releases/download/v0.1.0/LyraShield_0.1.0_universal.dmg.tar.gz",
    },
    "windows-x86_64": {
      signature: "dW50cnVzdGVkIGNvbW1lbnQ6IHNpZ25hdHVyZSB3aW5kb3dzIHNpZ25hdHVyZSBkYXRhIHdpbmRvd3M=",
      url: "https://github.com/ecryptoguru/lyrashield-ai/releases/download/v0.1.0/LyraShield_0.1.0_x64-setup.exe",
    },
  },
};

describe("validateUpdaterManifest", () => {
  it("accepts valid manifest with matching expected version", () => {
    expect(() => validateUpdaterManifest(validManifest, { expectedVersion: "0.1.0" })).not.toThrow();
  });

  it("fails when required platform missing", () => {
    const m = structuredClone(validManifest);
    // @ts-expect-error
    delete m.platforms["windows-x86_64"];
    expect(() => validateUpdaterManifest(m, { expectedVersion: "0.1.0" })).toThrow(/windows-x86_64/);
  });

  it("fails when signature empty (empty sig guard)", () => {
    const m = structuredClone(validManifest);
    m.platforms["darwin-aarch64"].signature = "";
    expect(() => validateUpdaterManifest(m, { expectedVersion: "0.1.0" })).toThrow(/signature: required non-empty/);
  });

  it("fails when url empty (empty url guard)", () => {
    const m = structuredClone(validManifest);
    m.platforms["windows-x86_64"].url = "   ";
    expect(() => validateUpdaterManifest(m, { expectedVersion: "0.1.0" })).toThrow(/url: required non-empty/);
  });

  it("fails when manifest malformed (missing version)", () => {
    const m = structuredClone(validManifest);
    // @ts-expect-error
    delete m.version;
    expect(() => validateUpdaterManifest(m)).toThrow(/version: required/);
  });

  it("fails when JSON malformed equivalent (non-object)", () => {
    // @ts-expect-error
    expect(() => validateUpdaterManifest(null)).toThrow(/non-null object/);
    // @ts-expect-error
    expect(() => validateUpdaterManifest("not json")).toThrow(/non-null object/);
  });

  it("fails on version mismatch (tag != manifest)", () => {
    expect(() => validateUpdaterManifest(validManifest, { expectedVersion: "0.2.0" })).toThrow(/!= expected/);
  });

  it("fails on tauri.conf version drift", () => {
    expect(() =>
      validateUpdaterManifest(validManifest, { expectedVersion: "0.1.0", tauriConfVersion: "0.1.1" })
    ).toThrow(/tauri.conf/);
  });

  it("fails when url does not contain expected version (asset/version mismatch)", () => {
    const m = structuredClone(validManifest);
    m.platforms["darwin-aarch64"].url =
      "https://github.com/ecryptoguru/lyrashield-ai/releases/download/v0.9.9/other.tar.gz";
    expect(() => validateUpdaterManifest(m, { expectedVersion: "0.1.0" })).toThrow(/must contain version/);
  });

  it("fails when private key material leaked into manifest", () => {
    const m = structuredClone(validManifest);
    // @ts-expect-error
    m.notes = "-----BEGIN PRIVATE KEY-----";
    expect(() => validateUpdaterManifest(m, { expectedVersion: "0.1.0" })).toThrow(/private key/);
  });

  it("fails when pub_date malformed", () => {
    const m = structuredClone(validManifest);
    m.pub_date = "not-a-date";
    expect(() => validateUpdaterManifest(m, { expectedVersion: "0.1.0" })).toThrow(/pub_date/);
  });

  it("fails when signature too short (catches || echo fallback)", () => {
    const m = structuredClone(validManifest);
    m.platforms["darwin-aarch64"].signature = "x";
    expect(() => validateUpdaterManifest(m, { expectedVersion: "0.1.0" })).toThrow(/too short/);
  });
});
