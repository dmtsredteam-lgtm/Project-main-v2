const registry = new Map();
let initialized = false;
let activeTrigger = null;
let closeTimer = null;

const elements = {};

function text(value, fallback = "—") {
  if (value === null || value === undefined || value === "") return fallback;
  return String(value);
}

function createElement(tag, className, content) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (content !== undefined) element.textContent = text(content);
  return element;
}

function renderMetrics(metrics = []) {
  elements.metrics.replaceChildren();
  for (const metric of metrics.slice(0, 8)) {
    const card = createElement("div", `detail-metric ${metric.tone ?? ""}`.trim());
    card.append(createElement("span", "", metric.label), createElement("strong", "", metric.value));
    elements.metrics.append(card);
  }
}

function renderSections(sections = []) {
  elements.content.replaceChildren();
  for (const section of sections) {
    const card = createElement("section", "detail-section");
    card.append(createElement("h3", "", section.title));
    const list = createElement("dl", "");
    for (const item of section.items ?? []) {
      const row = createElement("div", "detail-row");
      row.append(createElement("dt", "", item.label ?? item[0]), createElement("dd", "", item.value ?? item[1]));
      list.append(row);
    }
    card.append(list);
    elements.content.append(card);
  }
}

function renderPayload(payload) {
  elements.eyebrow.textContent = text(payload.eyebrow, "INVESTIGATION VIEW");
  elements.title.textContent = text(payload.title, "Security detail");
  elements.subtitle.textContent = text(payload.subtitle ?? payload.description, "Correlated operational context");
  elements.status.textContent = text(payload.status, "ACTIVE");
  elements.status.className = `detail-status ${payload.statusTone ?? ""}`.trim();
  elements.source.textContent = text(payload.source, "DMATICS CORRELATION ENGINE");
  elements.recommendation.textContent = text(payload.recommendation, "Continue monitoring and validate associated telemetry.");
  renderMetrics(payload.metrics);
  renderSections(payload.sections);
}

/* The registry is keyed by detail id, and one of the six call sites uses a
 * hub-controlled value (`origin-${alert.srcCountry}`). With a well-behaved hub
 * that is a dozen ISO codes; with a buggy one sending a session id per event it
 * is one ~1 KB entry per alert, forever. Cap it — the panels re-register their
 * payloads on every render, so dropping the map costs nothing but a click that
 * lands in the same second as the flush. */
const MAX_DETAILS = 300;

export function registerDetail(id, payload) {
  if (registry.size >= MAX_DETAILS && !registry.has(String(id))) registry.clear();
  registry.set(String(id), payload);
  return String(id);
}

export function makeDetailTrigger(element, id, payload) {
  registerDetail(id, payload);
  element.dataset.detailId = String(id);
  element.tabIndex = element.tabIndex >= 0 ? element.tabIndex : 0;
  element.setAttribute("role", "button");
  element.setAttribute("aria-haspopup", "dialog");
  return element;
}

export function openDetail(payload, trigger = document.activeElement) {
  if (!initialized) initDetailSystem();
  if (!payload) return;
  clearTimeout(closeTimer);
  activeTrigger = trigger instanceof HTMLElement ? trigger : null;
  renderPayload(payload);
  elements.layer.hidden = false;
  document.body.classList.add("detail-open");
  requestAnimationFrame(() => {
    elements.layer.classList.add("is-open");
    elements.dialog.focus({ preventScroll: true });
  });
}

export function closeDetail() {
  if (!initialized || elements.layer.hidden) return;
  elements.layer.classList.remove("is-open");
  document.body.classList.remove("detail-open");
  closeTimer = setTimeout(() => {
    elements.layer.hidden = true;
    activeTrigger?.focus?.({ preventScroll: true });
    activeTrigger = null;
  }, matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : 400);
}

function openFromTrigger(trigger) {
  const registered = registry.get(trigger.dataset.detailId);
  const payload = typeof registered === "function" ? registered() : registered;
  if (payload) openDetail(payload, trigger);
}

export function initDetailSystem() {
  if (initialized) return;
  initialized = true;
  Object.assign(elements, {
    layer: document.getElementById("detail-layer"),
    dialog: document.getElementById("detail-dialog"),
    eyebrow: document.getElementById("detail-eyebrow"),
    title: document.getElementById("detail-title"),
    subtitle: document.getElementById("detail-subtitle"),
    status: document.getElementById("detail-status"),
    metrics: document.getElementById("detail-metrics"),
    content: document.getElementById("detail-content"),
    source: document.getElementById("detail-source"),
    recommendation: document.getElementById("detail-recommendation"),
  });
  document.addEventListener("click", (event) => {
    const closeControl = event.target.closest("[data-detail-close]");
    if (closeControl) { closeDetail(); return; }
    const trigger = event.target.closest("[data-detail-id]");
    if (trigger) openFromTrigger(trigger);
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !elements.layer.hidden) { closeDetail(); return; }
    if (event.key === "Tab" && !elements.layer.hidden) {
      const focusable = [...elements.dialog.querySelectorAll("button:not([disabled]), [href], [tabindex]:not([tabindex='-1'])")];
      if (!focusable.length) { event.preventDefault(); elements.dialog.focus(); return; }
      const first = focusable[0];
      const last = focusable.at(-1);
      if (event.shiftKey && (document.activeElement === first || document.activeElement === elements.dialog)) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
      return;
    }
    if (event.key !== "Enter" && event.key !== " ") return;
    const trigger = event.target.closest?.("[data-detail-id]");
    if (!trigger) return;
    event.preventDefault();
    openFromTrigger(trigger);
  });
}
