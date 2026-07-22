// Animated dotted wave background layer (mounted by DotWaveBackground.astro)

type Dot = {
  x: number;
  y: number;
  radius: number;
  color: string;
  phase: number;
  speed: number;
  amplitude: number;
};

export function initDotWaves(): void {
  const canvas = document.querySelector<HTMLCanvasElement>('.dot-wave-canvas');
  if (!canvas || canvas.dataset.dotWavesInit === '1') return;
  canvas.dataset.dotWavesInit = '1';

  const reduceMotion =
    window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  let width = 0;
  let height = 0;
  let dpr = 1;
  let dots: Dot[] = [];
  let animationFrame: number | null = null;

  const spacing = 12;
  const green = 'rgba(18, 95, 49, 0.22)';
  const yellow = 'rgba(246, 215, 36, 0.2)';

  function resize() {
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    width = window.innerWidth;
    height = window.innerHeight;

    canvas.width = Math.ceil(width * dpr);
    canvas.height = Math.ceil(height * dpr);
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
    ctx!.setTransform(dpr, 0, 0, dpr, 0, 0);

    buildDots();
    draw(0);
  }

  function buildDots() {
    dots = [];
    const cols = Math.ceil(width / spacing) + 2;
    const rows = Math.ceil(height / spacing) + 2;

    for (let row = -1; row < rows; row++) {
      for (let col = -1; col < cols; col++) {
        dots.push({
          x: col * spacing,
          y: row * spacing,
          radius: (row + col) % 2 === 0 ? 1.25 : 1,
          color: (row + col) % 2 === 0 ? green : yellow,
          phase: col * 0.65 + row * 0.42,
          speed: 0.0012 + ((row + col) % 5) * 0.00012,
          amplitude: 2.5 + ((row * 3 + col) % 5) * 0.45,
        });
      }
    }
  }

  function draw(time: number) {
    ctx!.clearRect(0, 0, width, height);

    dots.forEach((dot) => {
      const wave = Math.sin(time * dot.speed + dot.phase);
      const crossWave = Math.cos(time * dot.speed * 0.8 + dot.phase * 1.3);
      const x = dot.x + crossWave * dot.amplitude * 0.55;
      const y = dot.y + wave * dot.amplitude;

      ctx!.beginPath();
      ctx!.arc(x, y, dot.radius, 0, Math.PI * 2);
      ctx!.fillStyle = dot.color;
      ctx!.fill();
    });

    if (!reduceMotion) {
      animationFrame = requestAnimationFrame(draw);
    }
  }

  function start() {
    if (!reduceMotion && animationFrame === null) {
      animationFrame = requestAnimationFrame(draw);
    }
  }

  function stop() {
    if (animationFrame !== null) {
      cancelAnimationFrame(animationFrame);
      animationFrame = null;
    }
  }

  window.addEventListener('resize', resize);
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      stop();
    } else {
      start();
    }
  });

  resize();
  start();
}
