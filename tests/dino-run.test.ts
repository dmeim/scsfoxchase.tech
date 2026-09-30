import { describe, expect, it } from "vitest";
import {
  DINO_RUN, createDinoRun, parseDinoBest, pauseDinoRun, releaseDinoJump,
  restartDinoRun, resumeDinoRun, slamDino, startDinoJump, stepDinoRun,
  type DinoRunState,
} from "../src/lib/minigames/dino-run";
import { minigames } from "../src/data/minigames";

function advance(game: DinoRunState, frames: number): void {
  for (let frame = 0; frame < frames; frame++) stepDinoRun(game, () => 0.5);
}

function collide(game: DinoRunState): void {
  game.obstacles = [{ x: DINO_RUN.dinoX + game.speed, width: 30, height: 50, tall: false }];
  stepDinoRun(game, () => 0.5);
}

function jumpHeight(hold: boolean): number {
  const game = createDinoRun();
  startDinoJump(game);
  if (!hold) releaseDinoJump(game);
  const start = game.dinoY;
  let top = start;
  while (!game.onGround) {
    stepDinoRun(game, () => 0.5);
    top = Math.min(top, game.dinoY);
  }
  return start - top;
}

describe("Dino Run", () => {
  it("has a fixed 16:9 world and a distinct first-party catalog entry", () => {
    expect(DINO_RUN.width / DINO_RUN.height).toBe(16 / 9);
    expect(minigames).toContainEqual(expect.objectContaining({ id: "dino-run", name: "Dino Run" }));
    expect(new Set(minigames.map((game) => game.id)).size).toBe(minigames.length);
  });

  it("starts ready with three lives and a sanitized personal best", () => {
    expect(createDinoRun(21.9)).toMatchObject({
      status: "ready", score: 0, best: 21, hearts: 3, onGround: true,
      dinoY: DINO_RUN.groundY - DINO_RUN.dinoHeight,
    });
    for (const value of [null, "", "bad", "-1", "Infinity", "NaN"]) {
      expect(parseDinoBest(value)).toBe(0);
    }
    expect(parseDinoBest("123.9")).toBe(123);
  });

  it("does not advance ready, paused, or game-over scenes", () => {
    for (const status of ["ready", "paused", "gameover"] as const) {
      const game = { ...createDinoRun(), status };
      const snapshot = structuredClone(game);
      advance(game, 100);
      expect(game).toEqual(snapshot);
    }
  });

  it("preserves the offline runner's short and held jump heights", () => {
    expect(jumpHeight(false)).toBeGreaterThan(80);
    expect(jumpHeight(false)).toBeLessThan(100);
    expect(jumpHeight(true)).toBeGreaterThan(185);
    expect(jumpHeight(true)).toBeLessThan(205);
  });

  it("does not double-jump in the air", () => {
    const game = createDinoRun();
    startDinoJump(game);
    advance(game, 4);
    const velocity = game.velocityY;
    startDinoJump(game);
    expect(game.velocityY).toBe(velocity);
  });

  it("slams down and lands without falling through the ground", () => {
    const game = createDinoRun();
    startDinoJump(game);
    advance(game, 6);
    slamDino(game);
    expect(game.velocityY).toBe(24);
    expect(game.jumpHeld).toBe(false);
    advance(game, 20);
    expect(game.onGround).toBe(true);
    expect(game.dinoY).toBe(DINO_RUN.groundY - DINO_RUN.dinoHeight);
  });

  it("pauses until explicitly resumed and ignores jump/slam while paused", () => {
    const game = createDinoRun();
    startDinoJump(game);
    advance(game, 6);
    pauseDinoRun(game);
    const snapshot = structuredClone(game);
    advance(game, 120);
    startDinoJump(game);
    slamDino(game);
    expect(game).toEqual(snapshot);
    resumeDinoRun(game);
    stepDinoRun(game);
    expect(game.status).toBe("running");
    expect(game.frame).toBe(snapshot.frame + 1);
  });

  it("loses one life at a time with a grace period between hits", () => {
    const game = createDinoRun();
    restartDinoRun(game);
    collide(game);
    expect(game.hearts).toBe(2);
    expect(game.invulnerability).toBe(33);
    collide(game);
    expect(game.hearts).toBe(2);
    expect(game.status).toBe("running");
  });

  it("ends after three hits and records a whole-number personal best", () => {
    const game = createDinoRun(10);
    restartDinoRun(game);
    game.score = 123.1;
    for (let hit = 0; hit < 3; hit++) {
      game.invulnerability = 0;
      collide(game);
    }
    expect(game.status).toBe("gameover");
    expect(game.hearts).toBe(0);
    expect(game.best).toBe(123);
    expect(game.invulnerability).toBe(0);
  });

  it("clears the scene on restart but retains the best score", () => {
    const game = createDinoRun(250);
    restartDinoRun(game);
    advance(game, 120);
    collide(game);
    restartDinoRun(game);
    expect(game).toMatchObject({
      status: "running", score: 0, best: 250, hearts: 3, speed: 6,
      frame: 0, obstacles: [], invulnerability: 0, onGround: true,
    });
  });

  it("keeps a higher existing best after a shorter run", () => {
    const game = createDinoRun(999);
    restartDinoRun(game);
    game.hearts = 1;
    collide(game);
    expect(game.best).toBe(999);
    startDinoJump(game);
    expect(game.status).toBe("running");
    expect(game.best).toBe(999);
    expect(game.onGround).toBe(false);
  });

  it("spawns both obstacle bands and removes offscreen obstacles", () => {
    for (const random of [() => 0, () => 0.999]) {
      const game = createDinoRun();
      restartDinoRun(game);
      game.spawnIn = 1;
      stepDinoRun(game, random);
      const obstacle = game.obstacles[0];
      expect(obstacle.tall).toBe(random() >= 0.45);
      expect(obstacle.height).toBeGreaterThanOrEqual(obstacle.tall ? 99 : 33);
      expect(obstacle.height).toBeLessThanOrEqual(obstacle.tall ? 132 : 50);
      expect(obstacle.x).toBeGreaterThan(DINO_RUN.width);
      game.obstacles = [{ ...obstacle, x: -100 }];
      stepDinoRun(game, random);
      expect(game.obstacles).toEqual([]);
    }
  });

  it("increases difficulty without exceeding the speed cap", () => {
    const game = createDinoRun();
    restartDinoRun(game);
    advance(game, 30);
    expect(game.score).toBeGreaterThan(0);
    expect(game.speed).toBeGreaterThan(6);
    game.score = 10_000;
    stepDinoRun(game);
    expect(game.speed).toBe(13);
  });
});
