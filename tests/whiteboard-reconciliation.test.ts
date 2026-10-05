import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import { elementWins, mergeSceneElements, type SceneElement } from "../src/lib/whiteboard-sync";

const installedEditor = readFileSync(
  "node_modules/@excalidraw/excalidraw/dist/dev/index.js",
  "utf8",
);
const rule = installedEditor.match(
  /var shouldDiscardRemoteElement = ([\s\S]*?);\nvar validateIndicesThrottled/,
);
if (!rule) throw new Error("Could not locate the installed Excalidraw conflict rule.");
const discardRemote = runInNewContext(`(${rule[1]})`) as (
  state: Record<string, unknown>,
  local: SceneElement,
  remote: SceneElement,
) => boolean;

describe("server/editor element conflict agreement", () => {
  it.each([
    { localVersion: 3, remoteVersion: 3, localNonce: 10, remoteNonce: 20 },
    { localVersion: 3, remoteVersion: 3, localNonce: 20, remoteNonce: 10 },
    { localVersion: 3, remoteVersion: 4, localNonce: 10, remoteNonce: 20 },
    { localVersion: 4, remoteVersion: 3, localNonce: 20, remoteNonce: 10 },
  ])("matches the installed editor for %j", ({
    localVersion, remoteVersion, localNonce, remoteNonce,
  }) => {
    const local = { id: "shape", version: localVersion, versionNonce: localNonce, x: 100 };
    const remote = { id: "shape", version: remoteVersion, versionNonce: remoteNonce, x: 200 };
    const editorWinner = discardRemote({}, local, remote) ? local : remote;
    expect(mergeSceneElements([local], [remote]).next).toEqual([editorWinner]);
  });

  it("converges independently of delivery order, including deletion conflicts", () => {
    const first = { id: "shape", version: 3, versionNonce: 10, isDeleted: true };
    const second = { id: "shape", version: 3, versionNonce: 20, isDeleted: false };
    expect(mergeSceneElements([first], [second]).next).toEqual([first]);
    expect(mergeSceneElements([second], [first]).next).toEqual([first]);
  });

  it("does not accept exact replays or let a lower version win by nonce", () => {
    const current = { id: "shape", version: 3, versionNonce: 10 };
    expect(elementWins({ ...current }, current)).toBe(false);
    expect(elementWins({ ...current, version: 2, versionNonce: 1 }, current)).toBe(false);
    expect(mergeSceneElements([current], [{ ...current }]).accepted).toEqual([]);
  });
});
