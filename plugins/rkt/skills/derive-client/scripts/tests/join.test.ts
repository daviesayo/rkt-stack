import { expect, test } from "bun:test";
import { applyJoins } from "../src/lib/join";
import { getPath } from "../src/lib/render";

const join = { key: "client_id", endpoint: "get.clients.id", select: ["name"], as: "client", onError: "blank" as const };

test("attaches selected fields from the lookup under `as`", async () => {
  const rows = [{ date: "d1", client_id: 7 }, { date: "d2", client_id: 8 }];
  const lookup = async (_ep: string, key: string) => ({ name: `C${key}`, secret: "x" });
  const out = await applyJoins(rows, [join], lookup);
  expect(out[0].client).toEqual({ name: "C7" }); // only `select` fields kept
  expect(out[1].client).toEqual({ name: "C8" });
});

test("dedups: distinct keys drive distinct lookups", async () => {
  const rows = [{ client_id: 7 }, { client_id: 7 }, { client_id: 8 }];
  const seen: string[] = [];
  const lookup = async (_ep: string, key: string) => { seen.push(key); return { name: key }; };
  await applyJoins(rows, [join], lookup);
  expect(seen.sort()).toEqual(["7", "8"]); // 7 looked up once despite two rows
});

test("rejects an array-valued key rather than mis-joining", async () => {
  const rows = [{ client_id: [1, 2] }];
  await expect(applyJoins(rows, [join], async () => ({}))).rejects.toThrow(/array-valued/i);
});

test("onError blank leaves the attachment empty", async () => {
  const rows = [{ client_id: 7 }];
  const lookup = async () => { throw new Error("404"); };
  const out = await applyJoins(rows, [join], lookup);
  expect(out[0].client).toEqual({});
});

test("onError key falls back to the raw key value", async () => {
  const rows = [{ client_id: 7 }];
  const j = { ...join, onError: "key" as const };
  const out = await applyJoins(rows, [j], async () => { throw new Error("404"); });
  expect(out[0].client).toBe("7");
});

test("onError fail aborts the whole command", async () => {
  const rows = [{ client_id: 7 }];
  const j = { ...join, onError: "fail" as const };
  await expect(applyJoins(rows, [j], async () => { throw new Error("404"); })).rejects.toThrow(/404|join/i);
});

test("a missing key resolves to blank without a lookup", async () => {
  const rows = [{ date: "d1" }];
  let called = false;
  const lookup = async () => { called = true; return {}; };
  const out = await applyJoins(rows, [join], lookup);
  expect(out[0].client).toEqual({});
  expect(called).toBe(false);
});

test("dotted select fields nest so getPath can read them back", async () => {
  const rows = [{ client_id: 1 }];
  const j = { key: "client_id", endpoint: "get.clients.id", select: ["address.city"], as: "client", onError: "blank" as const };
  const lookup = async () => ({ address: { city: "Sydney" } });
  const out = await applyJoins(rows, [j], lookup);
  expect(getPath(out[0], "client.address.city")).toBe("Sydney");
});

test("a missing key does NOT abort even under onError fail (no lookup was attempted)", async () => {
  const rows = [{ date: "d1" }]; // no client_id
  const j = { ...join, onError: "fail" as const };
  let called = false;
  const out = await applyJoins(rows, [j], async () => { called = true; return {}; });
  expect(out[0].client).toEqual({}); // blank, not thrown
  expect(called).toBe(false); // fail governs failed lookups, not absent references
});
