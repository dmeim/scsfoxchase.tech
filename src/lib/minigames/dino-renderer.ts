import { DINO_RUN, type DinoObstacle, type DinoRunState } from "./dino-run";

interface DinoColors {
  ink: string;
  primary: string;
  muted: string;
  background: string;
}

function readDinoColors(canvas: HTMLCanvasElement): DinoColors {
  const styles = getComputedStyle(canvas);
  const read = (name: string, fallback: string) => styles.getPropertyValue(name).trim() || fallback;
  return {
    ink: read("--text-color", "#333"),
    primary: read("--minigame-accent", "#125F31"),
    muted: read("--border-color", "#ddd"),
    background: read("--light-bg", "#f9f9f9"),
  };
}

function drawDino(ctx: CanvasRenderingContext2D, game: DinoRunState, colors: DinoColors): void {
  if (game.invulnerability > 0 && Math.floor(game.invulnerability / 4) % 2 === 0) return;
  const x = DINO_RUN.dinoX;
  const y = game.dinoY;
  ctx.fillStyle = game.status === "gameover" || game.invulnerability > 0 ? "#c62828" : colors.ink;
  ctx.fillRect(x + 8, y + 14, 28, 22);
  ctx.fillRect(x + 26, y + 2, 18, 16);
  ctx.fillRect(x + 40, y + 8, 4, 6);
  ctx.fillStyle = colors.background;
  ctx.fillRect(x + 36, y + 6, 3, 3);
  ctx.fillStyle = game.status === "gameover" || game.invulnerability > 0 ? "#c62828" : colors.ink;
  ctx.fillRect(x + 18, y + 22, 8, 3);
  const running = game.status === "running" && game.onGround;
  const leg = Math.floor(game.frame / 6) % 2 === 0;
  ctx.fillRect(x + 12, y + 36, 6, running && leg ? 8 : 12);
  ctx.fillRect(x + 26, y + 36, 6, running && !leg ? 8 : 12);
  ctx.fillRect(x, y + 20, 10, 4);
}

function drawCactus(ctx: CanvasRenderingContext2D, obstacle: DinoObstacle, colors: DinoColors): void {
  const { x, width, height, tall } = obstacle;
  const y = DINO_RUN.groundY - height;
  ctx.fillStyle = colors.primary;
  ctx.fillRect(x + width * 0.35, y, width * 0.3, height);
  if (!tall) return;
  ctx.fillRect(x, y + height * 0.35, width * 0.4, width * 0.28);
  ctx.fillRect(x, y + height * 0.35, width * 0.22, height * 0.28);
  ctx.fillRect(x + width * 0.55, y + height * 0.22, width * 0.45, width * 0.28);
  ctx.fillRect(x + width * 0.75, y + height * 0.22, width * 0.22, height * 0.32);
}

function drawCloud(ctx: CanvasRenderingContext2D, x: number, y: number): void {
  ctx.fillRect(x, y + 8, 48, 8);
  ctx.fillRect(x + 8, y, 16, 16);
  ctx.fillRect(x + 24, y + 4, 16, 12);
}

export function createDinoRenderer(canvas: HTMLCanvasElement, game: DinoRunState) {
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("A 2D canvas context is required for Dino Run.");
  const context = ctx;
  let colors = readDinoColors(canvas);

  function draw(): void {
    context.setTransform(canvas.width / DINO_RUN.width, 0, 0, canvas.height / DINO_RUN.height, 0, 0);
    context.clearRect(0, 0, DINO_RUN.width, DINO_RUN.height);
    context.fillStyle = colors.background;
    context.fillRect(0, 0, DINO_RUN.width, DINO_RUN.height);

    context.fillStyle = colors.muted;
    context.globalAlpha = 0.55;
    const cloudOffset = (game.frame * 0.25) % (DINO_RUN.width + 100);
    drawCloud(context, ((240 - cloudOffset + 900) % 900) - 50, 105);
    drawCloud(context, ((620 - cloudOffset + 900) % 900) - 50, 155);
    context.globalAlpha = 1;

    context.fillStyle = colors.muted;
    context.fillRect(0, DINO_RUN.groundY, DINO_RUN.width, 2);
    const tickOffset = (game.frame * game.speed) % 24;
    for (let x = -tickOffset; x < DINO_RUN.width; x += 24) {
      context.fillRect(x, DINO_RUN.groundY + 6, 10, 2);
    }
    for (const obstacle of game.obstacles) drawCactus(context, obstacle, colors);
    drawDino(context, game, colors);
  }

  function resize(): void {
    const bounds = canvas.getBoundingClientRect();
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.max(1, Math.round(bounds.width * ratio));
    canvas.height = Math.max(1, Math.round(bounds.height * ratio));
    context.imageSmoothingEnabled = false;
    draw();
  }

  const observer = new ResizeObserver(resize);
  observer.observe(canvas);
  const themeObserver = new MutationObserver(() => {
    colors = readDinoColors(canvas);
    draw();
  });
  themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
  window.addEventListener("resize", resize);
  resize();

  return {
    draw,
    destroy() {
      observer.disconnect();
      themeObserver.disconnect();
      window.removeEventListener("resize", resize);
    },
  };
}
