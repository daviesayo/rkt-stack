import { mock } from "bun:test";
import * as realFs from "node:fs/promises";

const originalWriteFile = realFs.writeFile.bind(realFs);
const originalReadFile = realFs.readFile.bind(realFs);

function isIdentityTmp(path: unknown): boolean {
  return String(path).endsWith(`.identity.json.${process.pid}.tmp`);
}

function isIdentityCache(path: unknown): boolean {
  return String(path).endsWith(".identity.json");
}

export type IdentityWriteMockOptions = {
  delayMs?: number;
  failOnCall?: number | null;
  /** Every identity-cache read throws ENOENT so concurrent callers must write. */
  forceCacheMiss?: boolean;
  onWriteEnter?: () => string | void;
  onWriteExit?: (label?: string) => void;
};

const mockState = {
  active: false,
  delayMs: 0,
  failOnCall: null as number | null,
  forceCacheMiss: false,
  writeCallCount: 0,
  onWriteEnter: undefined as IdentityWriteMockOptions["onWriteEnter"],
  onWriteExit: undefined as IdentityWriteMockOptions["onWriteExit"],
};

mock.module("node:fs/promises", () => ({
  ...realFs,
  readFile: async (
    path: Parameters<typeof realFs.readFile>[0],
    ...rest: Parameters<typeof realFs.readFile> extends [unknown, ...infer R] ? R : never
  ) => {
    if (mockState.active && mockState.forceCacheMiss && isIdentityCache(path)) {
      const err = new Error("ENOENT") as NodeJS.ErrnoException;
      err.code = "ENOENT";
      throw err;
    }
    return originalReadFile(path, ...rest);
  },
  writeFile: async (
    path: Parameters<typeof realFs.writeFile>[0],
    ...rest: Parameters<typeof realFs.writeFile> extends [unknown, ...infer R] ? R : never
  ) => {
    if (!mockState.active || !isIdentityTmp(path)) {
      return originalWriteFile(path, ...rest);
    }
    mockState.writeCallCount++;
    const label = mockState.onWriteEnter?.();
    try {
      if (mockState.failOnCall != null && mockState.failOnCall === mockState.writeCallCount) {
        throw new Error("simulated identity cache write failure");
      }
      if (mockState.delayMs > 0) {
        await new Promise((r) => setTimeout(r, mockState.delayMs));
      }
      return originalWriteFile(path, ...rest);
    } finally {
      mockState.onWriteExit?.(typeof label === "string" ? label : undefined);
    }
  },
}));

export function installIdentityWriteMock(options: IdentityWriteMockOptions = {}) {
  mockState.active = true;
  mockState.delayMs = options.delayMs ?? 0;
  mockState.failOnCall = options.failOnCall ?? null;
  mockState.forceCacheMiss = options.forceCacheMiss ?? false;
  mockState.writeCallCount = 0;
  mockState.onWriteEnter = options.onWriteEnter;
  mockState.onWriteExit = options.onWriteExit;

  return {
    get writeCallCount() {
      return mockState.writeCallCount;
    },
  };
}

export function restoreIdentityWriteMock(): void {
  mockState.active = false;
  mockState.delayMs = 0;
  mockState.failOnCall = null;
  mockState.forceCacheMiss = false;
  mockState.writeCallCount = 0;
  mockState.onWriteEnter = undefined;
  mockState.onWriteExit = undefined;
}
