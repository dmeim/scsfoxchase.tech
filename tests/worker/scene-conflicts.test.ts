import { afterEach, describe, expect, it } from "vitest";
import {
  connectAndAuth,
  frameHasElement,
  newBoardId,
  randomHostSecret,
  rectangleElement,
  type TestSocket,
} from "./helpers/harness";

const sockets: TestSocket[] = [];
afterEach(() => {
  while (sockets.length) sockets.pop()?.close();
});

async function mutate(socket: TestSocket, elements: unknown[]) {
  const mutationId = crypto.randomUUID();
  socket.send({ type: "scene:update", mutationId, elements, full: true });
  return socket.waitForFrame((frame) =>
    frame.type === "scene:ack" && frame.mutationId === mutationId,
  );
}

describe("persisted collaboration conflicts and replacement deletions", () => {
  it.each([[10, 20], [20, 10]])(
    "persists the lower nonce when equal-version edits arrive %i then %i",
    async (firstNonce, secondNonce) => {
      const boardId = newBoardId();
      const hostSecret = randomHostSecret();
      const first = await connectAndAuth(boardId, hostSecret);
      const second = await connectAndAuth(boardId, hostSecret);
      sockets.push(first, second);
      const shape = rectangleElement();
      await mutate(first, [{ ...shape, versionNonce: firstNonce, x: firstNonce }]);
      const ack = await mutate(second, [{ ...shape, versionNonce: secondNonce, x: secondNonce }]);
      expect(ack.status).toBe(secondNonce < firstNonce ? "applied" : "noop");

      const reopened = await connectAndAuth(boardId, "");
      sockets.push(reopened);
      const scene = await reopened.waitForFrame((frame) =>
        frame.type === "scene:sync" && frameHasElement(frame, shape.id),
      );
      expect(scene.elements).toEqual([
        expect.objectContaining({ id: shape.id, versionNonce: 10, x: 10 }),
      ]);
    },
  );

  it("persists consecutive background-only saves using each acknowledged revision", async () => {
    const boardId = newBoardId();
    const owner = await connectAndAuth(boardId, randomHostSecret());
    sockets.push(owner);
    let baseRevision = 0;
    for (const viewBackgroundColor of ["#111111", "#222222"]) {
      const mutationId = crypto.randomUUID();
      owner.send({
        type: "scene:update", mutationId, elements: [], full: false, baseRevision,
        databaseJson: JSON.stringify({
          type: "excalidraw", version: 2, elements: [], appState: { viewBackgroundColor },
        }),
      });
      const ack = await owner.waitForFrame((frame) =>
        frame.type === "scene:ack" && frame.mutationId === mutationId,
      );
      expect(ack.status).toBe("applied");
      expect(ack.revision).toBe(baseRevision + 1);
      baseRevision = ack.revision as number;
    }
    const reopened = await connectAndAuth(boardId, "");
    sockets.push(reopened);
    const scene = await reopened.waitForFrame((frame) => frame.type === "scene:sync");
    expect(scene.appState).toEqual({ viewBackgroundColor: "#222222" });
  });

  it("keeps omitted shapes deleted after importing a replacement and then an empty scene", async () => {
    const boardId = newBoardId();
    const owner = await connectAndAuth(boardId, randomHostSecret());
    sockets.push(owner);
    const old = rectangleElement();
    const imported = rectangleElement();
    await mutate(owner, [old]);
    const oldDeleted = { ...old, version: 2, versionNonce: 2, isDeleted: true };
    await mutate(owner, [oldDeleted, imported]);
    await mutate(owner, [
      oldDeleted,
      { ...imported, version: 2, versionNonce: 2, isDeleted: true },
    ]);

    const reopened = await connectAndAuth(boardId, "");
    sockets.push(reopened);
    const scene = await reopened.waitForFrame((frame) =>
      frame.type === "scene:sync" && frameHasElement(frame, old.id),
    );
    expect(scene.elements).toHaveLength(2);
    expect((scene.elements as Array<{ isDeleted?: boolean }>).every((element) =>
      element.isDeleted === true,
    )).toBe(true);
  });
});
