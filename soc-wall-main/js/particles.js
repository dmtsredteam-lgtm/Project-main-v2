export function initParticleField(canvas) {
  const context = canvas.getContext("2d", { alpha: true });
  const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const particles = [];
  let width = 0;
  let height = 0;
  let frame = 0;

  function resize() {
    const ratio = Math.min(devicePixelRatio, 1.5);
    width = innerWidth;
    height = innerHeight;
    canvas.width = Math.floor(width * ratio);
    canvas.height = Math.floor(height * ratio);
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    particles.length = 0;
    const count = Math.min(110, Math.floor((width * height) / 21_000));
    for (let index = 0; index < count; index += 1) {
      particles.push({ x: Math.random() * width, y: Math.random() * height, size: Math.random() * 1.2 + .2, speed: Math.random() * .08 + .02, alpha: Math.random() * .28 + .06 });
    }
  }

  function render() {
    context.clearRect(0, 0, width, height);
    for (const particle of particles) {
      context.fillStyle = `rgba(126, 221, 255, ${particle.alpha})`;
      context.fillRect(particle.x, particle.y, particle.size, particle.size);
      if (!reducedMotion) {
        particle.y -= particle.speed;
        particle.x += Math.sin((frame + particle.y) * .002) * .02;
        if (particle.y < -4) particle.y = height + 4;
      }
    }
    frame += 1;
    requestAnimationFrame(render);
  }

  addEventListener("resize", resize, { passive: true });
  resize();
  render();
}

