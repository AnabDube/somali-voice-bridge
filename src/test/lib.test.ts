import { describe, it, expect } from "vitest";
import {
  MAX_AUDIO_FILE_BYTES,
  extensionForMime,
  pickRecorderMimeType,
  validateAudioFile,
} from "@/lib/audio";
import { friendlyAuthError } from "@/lib/authErrors";

describe("validateAudioFile", () => {
  const file = (name: string, type: string, size = 1024) => ({ name, type, size });

  it("accepts supported audio types", () => {
    expect(validateAudioFile(file("a.mp3", "audio/mpeg"))).toBeNull();
    expect(validateAudioFile(file("a.wav", "audio/wav"))).toBeNull();
    expect(validateAudioFile(file("a.webm", "audio/webm"))).toBeNull();
  });

  it("accepts a known extension when the browser reports no MIME type", () => {
    expect(validateAudioFile(file("voice.m4a", ""))).toBeNull();
  });

  it("rejects non-audio files", () => {
    expect(validateAudioFile(file("notes.pdf", "application/pdf"))).toMatch(/unsupported/i);
  });

  it("rejects files over the size limit and allows files at it", () => {
    expect(validateAudioFile(file("big.mp3", "audio/mpeg", MAX_AUDIO_FILE_BYTES + 1))).toMatch(/too large/i);
    expect(validateAudioFile(file("ok.mp3", "audio/mpeg", MAX_AUDIO_FILE_BYTES))).toBeNull();
  });
});

describe("pickRecorderMimeType", () => {
  it("prefers webm/opus when supported", () => {
    expect(pickRecorderMimeType(() => true)).toBe("audio/webm;codecs=opus");
  });

  it("falls back to mp4 on Safari-like browsers", () => {
    expect(pickRecorderMimeType((t) => t === "audio/mp4")).toBe("audio/mp4");
  });

  it("defaults to webm when nothing reports support", () => {
    expect(pickRecorderMimeType(() => false)).toBe("audio/webm");
  });
});

describe("extensionForMime", () => {
  it("maps MIME types to file extensions, ignoring codec parameters", () => {
    expect(extensionForMime("audio/webm;codecs=opus")).toBe("webm");
    expect(extensionForMime("audio/mp4")).toBe("m4a");
    expect(extensionForMime("audio/mpeg")).toBe("mp3");
    expect(extensionForMime("audio/x-wav")).toBe("wav");
  });
});

describe("friendlyAuthError", () => {
  it("replaces bare network failures with an actionable message", () => {
    expect(friendlyAuthError({ message: "Failed to fetch" })).toMatch(/can't reach the server/i);
    expect(friendlyAuthError({ name: "AuthRetryableFetchError", message: "x" })).toMatch(/can't reach the server/i);
    expect(friendlyAuthError(new TypeError("NetworkError when attempting to fetch resource."))).toMatch(
      /can't reach the server/i,
    );
  });

  it("passes real auth errors through unchanged", () => {
    expect(friendlyAuthError({ message: "Invalid login credentials" })).toBe("Invalid login credentials");
  });

  it("handles empty input", () => {
    expect(friendlyAuthError(undefined)).toMatch(/something went wrong/i);
  });
});
