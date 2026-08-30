const chartState = new WeakMap();

export function pushSparkValue(canvas, value, color) {
  const history = chartState.get(canvas) ?? [];
  history.push(value);
  if (history.length > 42) history.shift();
  chartState.set(canvas, history);
  drawSparkline(canvas, history, color);
}

function drawSparkline(canvas, history, color) {
  const context = canvas.getContext("2d");
  const width = canvas.width;
  const height = canvas.height;
  context.clearRect(0, 0, width, height);
  if (history.length < 2) return;
  const minimum = Math.min(...history);
  const spread = Math.max(1, Math.max(...history) - minimum);
  const points = history.map((value, index) => ({
    x: (index / Math.max(1, history.length - 1)) * width,
    y: height - 5 - ((value - minimum) / spread) * (height - 12),
  }));
  const gradient = context.createLinearGradient(0, 0, 0, height);
  gradient.addColorStop(0, `${color}45`);
  gradient.addColorStop(1, `${color}00`);
  context.beginPath();
  context.moveTo(points[0].x, height);
  for (const point of points) context.lineTo(point.x, point.y);
  context.lineTo(points.at(-1).x, height);
  context.closePath();
  context.fillStyle = gradient;
  context.fill();
  context.beginPath();
  points.forEach((point, index) => index ? context.lineTo(point.x, point.y) : context.moveTo(point.x, point.y));
  context.strokeStyle = color;
  context.lineWidth = 2;
  context.shadowColor = color;
  context.shadowBlur = 7;
  context.stroke();
}

export function animateNumber(element, target, options = {}) {
  const duration = options.duration ?? 650;
  const start = Number(String(element.textContent).replace(/[^0-9.-]/g, "")) || 0;
  const startedAt = performance.now();
  const format = options.format ?? ((value) => Math.round(value).toLocaleString());
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) {
    element.textContent = format(target);
    return;
  }
  const tick = (now) => {
    const progress = Math.min(1, (now - startedAt) / duration);
    const eased = 1 - (1 - progress) ** 3;
    element.textContent = format(start + (target - start) * eased);
    if (progress < 1) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

