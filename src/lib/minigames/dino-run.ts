export const DINO_RUN = {
  width: 800,
  height: 450,
  groundY: 378,
  dinoX: 48,
  dinoWidth: 44,
  dinoHeight: 48,
  maxHearts: 3,
  stepMs: 1000 / 60,
  maxStepsPerFrame: 5,
  bestScoreKey: "offline-dino-best",
} as const;

export type DinoRunStatus = "ready" | "running" | "paused" | "gameover";

export interface DinoObstacle {
  x: number;
  width: number;
  height: number;
  tall: boolean;
}

export interface DinoRunState {
  status: DinoRunStatus;
  score: number;
  best: number;
  speed: number;
  frame: number;
  dinoY: number;
  velocityY: number;
  onGround: boolean;
  jumpHeld: boolean;
  hearts: number;
  invulnerability: number;
  obstacles: DinoObstacle[];
  spawnIn: number;
}

export function parseDinoBest(value: string | null): number {
  const score = Number(value);
  return Number.isFinite(score) && score > 0 ? Math.floor(score) : 0;
}

export function createDinoRun(best = 0): DinoRunState {
  return {
    status: "ready",
    score: 0,
    best: parseDinoBest(String(best)),
    speed: 6,
    frame: 0,
    dinoY: DINO_RUN.groundY - DINO_RUN.dinoHeight,
    velocityY: 0,
    onGround: true,
    jumpHeld: false,
    hearts: DINO_RUN.maxHearts,
    invulnerability: 0,
    obstacles: [],
    spawnIn: 80,
  };
}

export function restartDinoRun(game: DinoRunState): void {
  Object.assign(game, createDinoRun(game.best), { status: "running" });
}

export function startDinoJump(game: DinoRunState): void {
  if (game.status === "paused") return;
  if (game.status !== "running") restartDinoRun(game);
  if (!game.onGround) return;
  game.velocityY = -15.5;
  game.onGround = false;
  game.jumpHeld = true;
}

export function releaseDinoJump(game: DinoRunState): void {
  if (!game.jumpHeld) return;
  game.jumpHeld = false;
  // Preserve the offline runner's short-hop cut on early release.
  if (!game.onGround && game.velocityY < -10.5) game.velocityY = -10.5;
}

export function slamDino(game: DinoRunState): void {
  if (game.status !== "running" || game.onGround) return;
  game.jumpHeld = false;
  game.velocityY = Math.max(24, game.velocityY);
}

export function pauseDinoRun(game: DinoRunState): void {
  if (game.status !== "running") return;
  releaseDinoJump(game);
  game.status = "paused";
}

export function resumeDinoRun(game: DinoRunState): void {
  if (game.status === "paused") game.status = "running";
}

function hitsDino(game: DinoRunState, obstacle: DinoObstacle): boolean {
  const x = DINO_RUN.dinoX + 8;
  const y = game.dinoY + 6;
  const width = DINO_RUN.dinoWidth - 14;
  const height = DINO_RUN.dinoHeight - 10;
  const obstacleX = obstacle.x + 2;
  const obstacleY = DINO_RUN.groundY - obstacle.height;
  return x < obstacleX + obstacle.width - 4 &&
    x + width > obstacleX &&
    y < obstacleY + obstacle.height &&
    y + height > obstacleY;
}

function spawnDinoObstacle(game: DinoRunState, random: () => number): void {
  const tall = random() >= 0.45;
  const minHeight = tall ? 99 : 33;
  const heightRange = tall ? 34 : 18;
  game.obstacles.push({
    x: DINO_RUN.width + 10,
    width: (tall ? 16 : 22) + Math.floor(random() * (tall ? 10 : 14)),
    height: minHeight + Math.floor(random() * heightRange),
    tall,
  });
}

function takeDinoHit(game: DinoRunState): void {
  game.hearts -= 1;
  game.jumpHeld = false;
  if (game.hearts === 0) {
    game.status = "gameover";
    game.invulnerability = 0;
    game.best = Math.max(game.best, Math.floor(game.score));
    return;
  }
  game.invulnerability = 33;
}

// Fixed 60 Hz simulation: viewport size and display refresh rate never change physics.
export function stepDinoRun(game: DinoRunState, random = Math.random): void {
  if (game.status !== "running") return;
  game.frame += 1;
  game.score += 0.15 * (game.speed / 6);
  game.speed = Math.min(13, 6 + game.score / 120);
  if (game.invulnerability > 0) game.invulnerability -= 1;

  game.velocityY += game.velocityY < 0 ? 0.6 : 0.9;
  game.dinoY += game.velocityY;
  if (game.dinoY >= DINO_RUN.groundY - DINO_RUN.dinoHeight) {
    game.dinoY = DINO_RUN.groundY - DINO_RUN.dinoHeight;
    game.velocityY = 0;
    game.onGround = true;
    game.jumpHeld = false;
  }

  game.spawnIn -= 1;
  if (game.spawnIn <= 0) {
    spawnDinoObstacle(game, random);
    game.spawnIn = 55 + Math.floor(random() * 70) - Math.min(25, game.score / 8);
  }

  for (const obstacle of game.obstacles) obstacle.x -= game.speed;
  game.obstacles = game.obstacles.filter((obstacle) => obstacle.x + obstacle.width > -10);

  if (game.invulnerability === 0 && game.obstacles.some((obstacle) => hitsDino(game, obstacle))) {
    takeDinoHit(game);
  }
}
