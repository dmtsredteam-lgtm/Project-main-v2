import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { fullStamp } from "./clock.js";
import { feature } from "topojson-client";
import worldAtlas from "world-atlas/countries-50m.json";

const DEG = Math.PI / 180;
const HQ = [25.2048, 55.2708];
const MAX_ARCS = 24;
const ARC_POINTS = 72;
const countryFeatures = feature(worldAtlas, worldAtlas.objects.countries).features;

const cityNodes = [
  ["Dubai", 25.2048, 55.2708], ["London", 51.5072, -0.1276], ["Frankfurt", 50.1109, 8.6821], ["New York", 40.7128, -74.0060],
  ["Ashburn", 39.0438, -77.4874], ["São Paulo", -23.5505, -46.6333], ["Lagos", 6.5244, 3.3792], ["Johannesburg", -26.2041, 28.0473],
  ["Riyadh", 24.7136, 46.6753], ["Mumbai", 19.0760, 72.8777], ["Singapore", 1.3521, 103.8198], ["Beijing", 39.9042, 116.4074],
  ["Tokyo", 35.6762, 139.6503], ["Seoul", 37.5665, 126.9780], ["Sydney", -33.8688, 151.2093], ["Moscow", 55.7558, 37.6173],
];
/* No static country names.
 *
 * Labelling every landmass filled the globe with type that never changes and
 * competes with the thing that does — the live source markers, which name the
 * city and country of each attack as it lands. Borders still carry the
 * geography. Add names back here if a quieter globe is wanted. */
const labeledCountries = new Set([]);

const LABEL_SHORT = {
  "United States of America": "USA",
  "United Arab Emirates": "UAE",
  "United Kingdom": "UK",
};
const labelText = (name) => LABEL_SHORT[name] ?? name;

function latLonVector(lat, lon, radius = 1) {
  const phi = (90 - lat) * DEG;
  const theta = (lon + 180) * DEG;
  return new THREE.Vector3(-radius * Math.sin(phi) * Math.cos(theta), radius * Math.cos(phi), radius * Math.sin(phi) * Math.sin(theta));
}

function vectorLatLon(vector) {
  const normalized = vector.clone().normalize();
  const latitude = Math.asin(THREE.MathUtils.clamp(normalized.y, -1, 1)) / DEG;
  const theta = Math.atan2(normalized.z, -normalized.x);
  let longitude = theta / DEG - 180;
  if (longitude < -180) longitude += 360;
  if (longitude > 180) longitude -= 360;
  return [latitude, longitude];
}

function polygonRings(geometry) {
  if (geometry.type === "Polygon") return [geometry.coordinates];
  if (geometry.type === "MultiPolygon") return geometry.coordinates;
  return [];
}

function pointInRing(longitude, latitude, ring) {
  let inside = false;
  for (let index = 0, previous = ring.length - 1; index < ring.length; previous = index, index += 1) {
    let x1 = ring[index][0];
    let x2 = ring[previous][0];
    while (x1 - longitude > 180) x1 -= 360;
    while (x1 - longitude < -180) x1 += 360;
    while (x2 - longitude > 180) x2 -= 360;
    while (x2 - longitude < -180) x2 += 360;
    const y1 = ring[index][1];
    const y2 = ring[previous][1];
    if ((y1 > latitude) !== (y2 > latitude) && longitude < ((x2 - x1) * (latitude - y1)) / ((y2 - y1) || 1e-9) + x1) inside = !inside;
  }
  return inside;
}

function countryAtLocation(latitude, longitude) {
  return countryFeatures.find((country) => polygonRings(country.geometry).some((polygon) => {
    if (!pointInRing(longitude, latitude, polygon[0])) return false;
    return !polygon.slice(1).some((hole) => pointInRing(longitude, latitude, hole));
  }));
}

function countryLinePositions(country, radius = 1.012) {
  const positions = [];
  for (const polygon of polygonRings(country.geometry)) {
    for (const ring of polygon) {
      for (let index = 1; index < ring.length; index += 1) {
        const previous = ring[index - 1];
        const current = ring[index];
        if (Math.abs(previous[0] - current[0]) > 180) continue;
        positions.push(...latLonVector(previous[1], previous[0], radius).toArray(), ...latLonVector(current[1], current[0], radius).toArray());
      }
    }
  }
  return positions;
}

function createCountryBorders(world) {
  const positions = countryFeatures.flatMap((country) => countryLinePositions(country));
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  const material = new THREE.LineBasicMaterial({ color: 0x8eeeff, transparent: true, opacity: .34, blending: THREE.AdditiveBlending, depthWrite: false });
  const borders = new THREE.LineSegments(geometry, material);
  world.add(borders);

  const highlightGeometry = new THREE.BufferGeometry();
  const highlightMaterial = new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: .95, blending: THREE.AdditiveBlending, depthWrite: false });
  const highlight = new THREE.LineSegments(highlightGeometry, highlightMaterial);
  highlight.visible = false;
  world.add(highlight);
  return {
    highlight(country) {
      if (!country) { highlight.visible = false; return; }
      highlight.geometry.dispose();
      highlight.geometry = new THREE.BufferGeometry();
      highlight.geometry.setAttribute("position", new THREE.Float32BufferAttribute(countryLinePositions(country, 1.018), 3));
      highlight.visible = true;
    },
  };
}

function traceProjectedRing(context, ring, width, height, wrapOffset) {
  if (!ring.length) return;
  let previousLongitude = ring[0][0];
  let unwrappedLongitude = previousLongitude;
  context.moveTo(((unwrappedLongitude + 180) / 360 + wrapOffset) * width, ((90 - ring[0][1]) / 180) * height);
  for (let index = 1; index < ring.length; index += 1) {
    const longitude = ring[index][0];
    let delta = longitude - previousLongitude;
    if (delta > 180) delta -= 360;
    if (delta < -180) delta += 360;
    unwrappedLongitude += delta;
    context.lineTo(((unwrappedLongitude + 180) / 360 + wrapOffset) * width, ((90 - ring[index][1]) / 180) * height);
    previousLongitude = longitude;
  }
  context.closePath();
}

function createEarthTexture() {
  const canvas = document.createElement("canvas");
  canvas.width = 2048;
  canvas.height = 1024;
  const context = canvas.getContext("2d");
  const ocean = context.createLinearGradient(0, 0, 0, canvas.height);
  ocean.addColorStop(0, "#061a2c");
  ocean.addColorStop(.52, "#09283b");
  ocean.addColorStop(1, "#04131f");
  context.fillStyle = ocean;
  context.fillRect(0, 0, canvas.width, canvas.height);
  const horizonGlow = context.createRadialGradient(canvas.width * .5, canvas.height * .48, 20, canvas.width * .5, canvas.height * .48, canvas.width * .55);
  horizonGlow.addColorStop(0, "rgba(32, 118, 145, .14)");
  horizonGlow.addColorStop(1, "rgba(0, 0, 0, 0)");
  context.fillStyle = horizonGlow;
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.strokeStyle = "rgba(89, 221, 255, .07)";
  context.lineWidth = 1;
  for (let longitude = 0; longitude <= 360; longitude += 15) {
    const x = (longitude / 360) * canvas.width;
    context.beginPath(); context.moveTo(x, 0); context.lineTo(x, canvas.height); context.stroke();
  }
  for (let latitude = 0; latitude <= 180; latitude += 15) {
    const y = (latitude / 180) * canvas.height;
    context.beginPath(); context.moveTo(0, y); context.lineTo(canvas.width, y); context.stroke();
  }
  countryFeatures.forEach((country, countryIndex) => {
    for (const polygon of polygonRings(country.geometry)) {
      for (const offset of [-1, 0, 1]) {
        context.beginPath();
        for (const ring of polygon) traceProjectedRing(context, ring, canvas.width, canvas.height, offset);
        const hue = 188 + (countryIndex % 7) * 2.2;
        const lightness = 19 + (countryIndex % 5) * 1.6;
        context.fillStyle = `hsla(${hue}, 48%, ${lightness}%, .9)`;
        context.strokeStyle = "rgba(143, 235, 255, .24)";
        context.lineWidth = .8;
        context.fill("evenodd");
        context.stroke();
      }
    }
  });
  for (const [, latitude, longitude] of cityNodes) {
    const x = ((longitude + 180) / 360) * canvas.width;
    const y = ((90 - latitude) / 180) * canvas.height;
    const glow = context.createRadialGradient(x, y, 0, x, y, 8);
    glow.addColorStop(0, "rgba(218, 251, 255, .9)");
    glow.addColorStop(.24, "rgba(84, 231, 255, .5)");
    glow.addColorStop(1, "rgba(84, 231, 255, 0)");
    context.fillStyle = glow;
    context.fillRect(x - 8, y - 8, 16, 16);
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4;
  return texture;
}

function createCloudTexture() {
  const canvas = document.createElement("canvas");
  canvas.width = 1024;
  canvas.height = 512;
  const context = canvas.getContext("2d");
  let seed = 9_731;
  const random = () => { seed = (seed * 16_807) % 2_147_483_647; return (seed - 1) / 2_147_483_646; };
  for (let band = 0; band < 14; band += 1) {
    const centerY = canvas.height * (.16 + band * .052) + (random() - .5) * 26;
    const direction = band % 2 ? 1 : -1;
    for (let cloud = 0; cloud < 25; cloud += 1) {
      const x = random() * canvas.width;
      const y = centerY + Math.sin((x / canvas.width) * Math.PI * 4 + band) * 22 * direction + (random() - .5) * 30;
      const radiusX = 18 + random() * 62;
      const radiusY = 4 + random() * 16;
      const gradient = context.createRadialGradient(x, y, 0, x, y, radiusX);
      gradient.addColorStop(0, `rgba(195, 235, 247, ${.08 + random() * .12})`);
      gradient.addColorStop(1, "rgba(195, 235, 247, 0)");
      context.fillStyle = gradient;
      context.beginPath();
      context.ellipse(x, y, radiusX, radiusY, random() * .45 - .22, 0, Math.PI * 2);
      context.fill();
    }
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.wrapS = THREE.RepeatWrapping;
  return texture;
}

function createCityLights(world) {
  const positions = new Float32Array(cityNodes.length * 3);
  cityNodes.forEach(([, latitude, longitude], index) => latLonVector(latitude, longitude, 1.024).toArray(positions, index * 3));
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  const material = new THREE.PointsMaterial({ color: 0xbdf7ff, size: .021, transparent: true, opacity: .95, blending: THREE.AdditiveBlending, depthWrite: false, sizeAttenuation: true });
  const lights = new THREE.Points(geometry, material);
  world.add(lights);
  return lights;
}

function countryRepresentativePosition(country) {
  const rings = polygonRings(country.geometry).flat();
  const ring = rings.reduce((largest, candidate) => candidate.length > largest.length ? candidate : largest, []);
  const average = new THREE.Vector3();
  for (const [longitude, latitude] of ring) average.add(latLonVector(latitude, longitude));
  return average.normalize().multiplyScalar(1.05);
}

function createCountryLabels(container) {
  return countryFeatures.filter((country) => labeledCountries.has(country.properties?.name)).map((country) => {
    const label = document.createElement("span");
    label.className = "country-geo-label";
    label.textContent = labelText(country.properties.name);
    label.hidden = true;
    container.append(label);
    return { country, label, position: countryRepresentativePosition(country) };
  });
}

function greatCirclePoints(from, to) {
  const start = latLonVector(from[0], from[1], 1.015);
  const end = latLonVector(to[0], to[1], 1.015);
  const startDirection = start.clone().normalize();
  const endDirection = end.clone().normalize();
  const dot = THREE.MathUtils.clamp(startDirection.dot(endDirection), -1, 1);
  const angle = Math.acos(dot);
  const sine = Math.sin(angle);
  const altitude = .12 + Math.min(.45, angle * .22);
  const points = [];
  for (let index = 0; index < ARC_POINTS; index += 1) {
    const progress = index / (ARC_POINTS - 1);
    const vector = sine > 1e-5
      ? startDirection.clone().multiplyScalar(Math.sin((1 - progress) * angle) / sine).addScaledVector(endDirection, Math.sin(progress * angle) / sine)
      : startDirection.clone().lerp(endDirection, progress).normalize();
    vector.multiplyScalar(1.015 + Math.sin(progress * Math.PI) * altitude);
    points.push(vector);
  }
  return points;
}

function createStars(scene) {
  const count = 850;
  const positions = new Float32Array(count * 3);
  for (let index = 0; index < count; index += 1) {
    const radius = 5 + Math.random() * 5;
    const theta = Math.random() * Math.PI * 2;
    const phi = Math.acos(2 * Math.random() - 1);
    positions[index * 3] = radius * Math.sin(phi) * Math.cos(theta);
    positions[index * 3 + 1] = radius * Math.cos(phi);
    positions[index * 3 + 2] = radius * Math.sin(phi) * Math.sin(theta);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  const material = new THREE.PointsMaterial({ color: 0x83dcff, size: .012, transparent: true, opacity: .55, sizeAttenuation: true, depthWrite: false });
  scene.add(new THREE.Points(geometry, material));
}

function createArcPool(scene) {
  const pulseGeometry = new THREE.SphereGeometry(.018, 10, 10);
  return Array.from({ length: MAX_ARCS }, () => {
    const positions = new Float32Array(ARC_POINTS * 3);
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    geometry.setDrawRange(0, 0);
    const lineMaterial = new THREE.LineBasicMaterial({ color: 0x54e7ff, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false });
    const line = new THREE.Line(geometry, lineMaterial);
    const pulseMaterial = new THREE.MeshBasicMaterial({ color: 0x54e7ff, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false });
    const pulse = new THREE.Mesh(pulseGeometry, pulseMaterial);
    line.visible = false;
    pulse.visible = false;
    scene.add(line, pulse);
    return { line, pulse, positions, points: [], progress: 0, speed: 0, active: false, critical: false };
  });
}

function createImpactPool(scene) {
  const geometry = new THREE.RingGeometry(.018, .028, 32);
  return Array.from({ length: 12 }, () => {
    const material = new THREE.MeshBasicMaterial({ color: 0x54e7ff, transparent: true, opacity: 0, side: THREE.DoubleSide, blending: THREE.AdditiveBlending, depthWrite: false });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.visible = false;
    scene.add(mesh);
    return { mesh, progress: 0, active: false };
  });
}

function createLocationMarkerPool(world, container) {
  const dotGeometry = new THREE.SphereGeometry(.032, 14, 14);
  const ringGeometry = new THREE.RingGeometry(.042, .052, 28);
  return Array.from({ length: MAX_ARCS }, () => {
    const group = new THREE.Group();
    const dotMaterial = new THREE.MeshBasicMaterial({ color: 0x54e7ff, transparent: true, opacity: .95, blending: THREE.AdditiveBlending, depthWrite: false });
    const ringMaterial = new THREE.MeshBasicMaterial({ color: 0x54e7ff, transparent: true, opacity: .5, side: THREE.DoubleSide, blending: THREE.AdditiveBlending, depthWrite: false });
    const dot = new THREE.Mesh(dotGeometry, dotMaterial);
    const ring = new THREE.Mesh(ringGeometry, ringMaterial);
    const label = document.createElement("div");
    const labelTitle = document.createElement("strong");
    const labelCoordinates = document.createElement("span");
    label.className = "attack-location-label";
    label.hidden = true;
    label.append(labelTitle, labelCoordinates);
    container.append(label);
    group.add(dot, ring);
    group.visible = false;
    world.add(group);
    const marker = { group, dot, ring, label, labelTitle, labelCoordinates, alert: null, age: 0, sequence: -1 };
    dot.userData.locationMarker = marker;
    return marker;
  });
}

function orientMarker(marker, position) {
  marker.group.position.copy(position);
  marker.group.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), position.clone().normalize());
}

export function initGlobe(container, options = {}) {
  const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(34, 1, .1, 100);
  camera.position.set(0, .08, 4.25);
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: "high-performance" });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5));
  renderer.setClearColor(0x000000, 0);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  container.append(renderer.domElement);

  const world = new THREE.Group();
  scene.add(world);

  /* The protected perimeter is Dubai, every arc converges there, and the impact
   * ring plays there — so Dubai is what the wall has to be looking at. The old
   * fixed rotation happened to face the Atlantic, which put the one place
   * anything happens on the far side of the planet. */
  const WORLD_UP = new THREE.Vector3(0, 1, 0);
  function orientOnHq() {
    const hqDirection = latLonVector(HQ[0], HQ[1]).normalize();
    const cameraDirection = camera.position.clone().normalize();
    const quaternion = new THREE.Quaternion().setFromUnitVectors(hqDirection, cameraDirection);
    // A slight downward tilt so the northern hemisphere reads as the top of a
    // globe rather than a flat disc.
    quaternion.premultiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), -0.11));
    return quaternion;
  }
  const hqQuaternion = orientOnHq();
  world.quaternion.copy(hqQuaternion);
  const initialWorldQuaternion = hqQuaternion.clone();
  createStars(scene);

  const earthTexture = createEarthTexture();
  earthTexture.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
  const earth = new THREE.Mesh(
    new THREE.SphereGeometry(1, 96, 96),
    new THREE.MeshPhongMaterial({ map: earthTexture, color: 0xc8f7ff, emissive: 0x061927, emissiveIntensity: .48, shininess: 14 }),
  );
  world.add(earth);
  const borderSystem = createCountryBorders(world);
  const countryLabels = createCountryLabels(container);
  const cityLights = createCityLights(world);
  const clouds = new THREE.Mesh(new THREE.SphereGeometry(1.008, 72, 72), new THREE.MeshPhongMaterial({ map: createCloudTexture(), color: 0xbdeeff, transparent: true, opacity: .22, blending: THREE.AdditiveBlending, depthWrite: false }));
  world.add(clouds);

  const wire = new THREE.Mesh(new THREE.SphereGeometry(1.006, 36, 18), new THREE.MeshBasicMaterial({ color: 0x49d9ff, wireframe: true, transparent: true, opacity: .055, depthWrite: false }));
  world.add(wire);
  const atmosphere = new THREE.Mesh(new THREE.SphereGeometry(1.065, 64, 64), new THREE.ShaderMaterial({
    vertexShader: `varying vec3 vNormal; varying vec3 vPositionNormal; void main(){ vNormal=normalize(normalMatrix*normal); vPositionNormal=normalize((modelViewMatrix*vec4(position,1.0)).xyz); gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0); }`,
    fragmentShader: `varying vec3 vNormal; varying vec3 vPositionNormal; void main(){ float intensity=pow(0.74-dot(vNormal,vPositionNormal),3.0); gl_FragColor=vec4(0.22,0.82,1.0,1.0)*intensity*0.82; }`,
    blending: THREE.AdditiveBlending, side: THREE.BackSide, transparent: true, depthWrite: false,
  }));
  world.add(atmosphere);

  const hqPosition = latLonVector(HQ[0], HQ[1], 1.025);
  const hq = new THREE.Mesh(new THREE.SphereGeometry(.026, 16, 16), new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: .95 }));
  hq.position.copy(hqPosition);
  world.add(hq);

  scene.add(new THREE.HemisphereLight(0x8eeeff, 0x02050a, 1.5));
  const keyLight = new THREE.DirectionalLight(0x89eaff, 3.1);
  keyLight.position.set(-3, 2, 4);
  scene.add(keyLight);
  const rimLight = new THREE.PointLight(0x8b5cff, 4, 9);
  rimLight.position.set(3, -.5, 2);
  scene.add(rimLight);

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = .055;
  controls.enablePan = false;
  controls.minDistance = 3.2;
  controls.maxDistance = 5.6;
  /* OrbitControls' own auto-rotate spins the camera right around, which parks
   * Dubai behind the planet for half of every cycle. Instead the globe sways
   * slowly around the Dubai-facing orientation: continuous motion, but the
   * perimeter never leaves the screen. Dragging takes over, and the sway eases
   * back in a few seconds after the last touch. */
  controls.autoRotate = false;

  /* Whether the globe moves at all.
   *
   * `prefers-reduced-motion` alone was the wrong gate here: a booth machine
   * with desktop animations turned down showed a completely static globe and
   * looked broken. The config decides, and only "auto" defers to the OS. */
  const motionSetting = globalThis.SOC_CONFIG?.globeMotion ?? true;
  const swayEnabled = motionSetting === "auto" ? !reducedMotion : motionSetting !== false;

  const SWAY_AMPLITUDE = 0.50;      // radians — about 29 degrees either way
  const SWAY_SPEED = 0.11;          // one full sweep every ~57 seconds
  const SWAY_RESUME_MS = 6_000;     // idle time before the globe drifts back
  const SWAY_EASE = 0.06;           // how hard the globe is pulled to the target
  let lastInteraction = 0;
  const swayQuaternion = new THREE.Quaternion();
  const targetQuaternion = new THREE.Quaternion();

  /* Only real input pauses the sway. An earlier version also listened for
   * "change", which OrbitControls fires on every damped settle — including the
   * ones our own updates cause — so the pause never expired and the globe
   * never moved. */
  controls.addEventListener("start", () => { lastInteraction = performance.now(); });
  controls.addEventListener("end", () => { lastInteraction = performance.now(); });

  /* Driven off the wall clock, not off accumulated frame deltas.
   * The render loop clamps delta to 50ms so a stutter cannot make the globe
   * jump; the side effect is that on a machine rendering at 15fps, accumulated
   * time runs at a quarter speed and the globe barely moves. A booth screen on
   * integrated graphics is exactly that machine, so the sway reads real time
   * and looks the same on every box. */
  const swayOrigin = performance.now();
  function driftTowardHq() {
    if (!swayEnabled) return;
    const now = performance.now();
    if (now - lastInteraction < SWAY_RESUME_MS) return;
    const seconds = (now - swayOrigin) / 1000;
    swayQuaternion.setFromAxisAngle(WORLD_UP, Math.sin(seconds * SWAY_SPEED) * SWAY_AMPLITUDE);
    targetQuaternion.copy(swayQuaternion).multiply(hqQuaternion);
    // Slerped rather than assigned, so returning from a drag glides back to
    // Dubai instead of snapping.
    world.quaternion.slerp(targetQuaternion, SWAY_EASE);
  }

  const arcs = createArcPool(world);
  const impacts = createImpactPool(world);
  const locationMarkers = createLocationMarkerPool(world, container);
  let nextArc = 0;
  let nextImpact = 0;
  let nextMarker = 0;
  let markerSequence = 0;
  let elapsed = 0;

  const readout = document.getElementById("geo-readout");
  const countryLabel = document.getElementById("geo-country");
  const latitudeLabel = document.getElementById("geo-latitude");
  const longitudeLabel = document.getElementById("geo-longitude");
  const detailLabel = document.getElementById("geo-detail");
  const hostLabel = document.getElementById("geo-host");
  const classLabelEl = document.getElementById("geo-class");
  const levelLabel = document.getElementById("geo-level");
  const riskLabel = document.getElementById("geo-risk");
  const statusLabel = document.getElementById("geo-status");

  function showLocation({ latitude, longitude, country, detail, attack = false, host = "—", tclass = "—", level = "—", risk = "—", status = "READY" }) {
    countryLabel.textContent = country?.properties?.name ?? country ?? "INTERNATIONAL WATERS";
    latitudeLabel.textContent = `LAT ${Math.abs(latitude).toFixed(5)}° ${latitude >= 0 ? "N" : "S"}`;
    longitudeLabel.textContent = `LON ${Math.abs(longitude).toFixed(5)}° ${longitude >= 0 ? "E" : "W"}`;
    detailLabel.textContent = detail ?? "Country boundary selected";
    hostLabel.textContent = host;
    classLabelEl.textContent = tclass;
    levelLabel.textContent = level;
    riskLabel.textContent = risk;
    statusLabel.textContent = status;
    readout.classList.toggle("is-attack", attack);
  }

  function placeLocationMarker(alert, critical) {
    const marker = locationMarkers[nextMarker];
    nextMarker = (nextMarker + 1) % locationMarkers.length;
    marker.alert = alert;
    marker.age = 0;
    marker.sequence = markerSequence;
    markerSequence += 1;
    marker.group.visible = true;
    marker.dot.material.color.setHex(critical ? 0xff496c : 0x54e7ff);
    marker.ring.material.color.setHex(critical ? 0xff496c : 0x54e7ff);
    marker.dot.material.opacity = .95;
    marker.ring.material.opacity = .52;
    const country = countryAtLocation(alert.srcLat, alert.srcLon)?.properties?.name ?? alert.srcCountryName ?? alert.srcCountry;
    marker.label.classList.toggle("critical", critical);
    marker.labelTitle.textContent = `${alert.srcCity && alert.srcCity !== "Unknown location" ? `${alert.srcCity} · ` : ""}${country}`;
    marker.labelCoordinates.textContent = `${alert.srcLat.toFixed(5)}°, ${alert.srcLon.toFixed(5)}°`;
    marker.group.scale.setScalar(1);
    orientMarker(marker, latLonVector(alert.srcLat, alert.srcLon, 1.028));
  }

  function spawnImpact(critical) {
    const impact = impacts[nextImpact];
    nextImpact = (nextImpact + 1) % impacts.length;
    impact.active = true;
    impact.progress = 0;
    impact.mesh.visible = true;
    impact.mesh.position.copy(hqPosition);
    impact.mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), hqPosition.clone().normalize());
    impact.mesh.material.color.setHex(critical ? 0xff496c : 0x54e7ff);
  }

  function spawnAttack(alert) {
    if (!Number.isFinite(alert.srcLat) || !Number.isFinite(alert.srcLon)) return;
    const slot = arcs[nextArc];
    nextArc = (nextArc + 1) % arcs.length;
    slot.points = greatCirclePoints([alert.srcLat, alert.srcLon], HQ);
    slot.points.forEach((point, index) => point.toArray(slot.positions, index * 3));
    slot.line.geometry.attributes.position.needsUpdate = true;
    slot.line.geometry.setDrawRange(0, 0);
    slot.progress = 0;
    slot.speed = .17 + Math.random() * .09;
    slot.active = true;
    slot.critical = alert.level >= 13;
    slot.line.visible = true;
    slot.pulse.visible = true;
    slot.line.material.color.setHex(slot.critical ? 0xff496c : 0x54e7ff);
    slot.pulse.material.color.setHex(slot.critical ? 0xff496c : 0x54e7ff);
    slot.line.material.opacity = slot.critical ? .7 : .46;
    slot.pulse.material.opacity = 1;
    placeLocationMarker(alert, slot.critical);
  }

  function setZoom(distance) {
    camera.position.setLength(THREE.MathUtils.clamp(distance, controls.minDistance, controls.maxDistance));
    controls.update();
  }

  for (const button of document.querySelectorAll("[data-globe-action]")) {
    button.addEventListener("click", () => {
      const action = button.dataset.globeAction;
      if (action === "zoom-in") setZoom(camera.position.length() * .82);
      if (action === "zoom-out") setZoom(camera.position.length() * 1.2);
      if (action === "reset") {
        camera.position.set(0, .08, 4.25);
        world.quaternion.copy(initialWorldQuaternion);
        lastInteraction = 0;
        borderSystem.highlight(null);
        controls.target.set(0, 0, 0);
        controls.update();
        showLocation({ latitude: HQ[0], longitude: HQ[1], country: "UNITED ARAB EMIRATES", detail: "Protected perimeter · Dubai" });
      }
    });
  }

  const raycaster = new THREE.Raycaster();
  const pointer = new THREE.Vector2();
  let pointerStart = null;

  function setPointer(event) {
    const bounds = renderer.domElement.getBoundingClientRect();
    pointer.x = ((event.clientX - bounds.left) / bounds.width) * 2 - 1;
    pointer.y = -((event.clientY - bounds.top) / bounds.height) * 2 + 1;
    raycaster.setFromCamera(pointer, camera);
  }

  function inspectLocation(event) {
    setPointer(event);
    const earthHit = raycaster.intersectObject(earth, false)[0];
    const markerHits = raycaster.intersectObjects(locationMarkers.filter((marker) => marker.group.visible).map((marker) => marker.dot), false);
    if (markerHits.length && (!earthHit || markerHits[0].distance <= earthHit.distance + .04)) {
      const marker = markerHits[0].object.userData.locationMarker;
      const alert = marker.alert;
      const country = countryAtLocation(alert.srcLat, alert.srcLon);
      borderSystem.highlight(country);
      showLocation({ latitude: alert.srcLat, longitude: alert.srcLon, country: country ?? alert.srcCountryName ?? alert.srcCountry, detail: `${alert.srcCity ?? "Unknown location"} / ${alert.rule}`, attack: true, host: alert.agent, tclass: alert.tclass, level: `L${alert.level}`, risk: `${alert.risk}/100`, status: alert.status });
      options.onInspect?.({
        eyebrow: "LIVE ATTACK POINT", title: alert.rule, subtitle: `${alert.srcCity ?? "Unknown location"}, ${country?.properties?.name ?? alert.srcCountryName ?? alert.srcCountry}`, status: alert.status ?? "INVESTIGATING", statusTone: alert.status === "Contained" ? "good" : "hot",
        metrics: [{ label: "Risk", value: `${alert.risk}/100`, tone: alert.risk >= 85 ? "hot" : "warning" }, { label: "Confidence", value: `${alert.confidence}%` }, { label: "Severity", value: `L${alert.level}`, tone: alert.level >= 13 ? "hot" : "warning" }, { label: "Class", value: alert.category ?? alert.tclass }],
        sections: [{ title: "Attack telemetry", items: [{ label: "Rule", value: alert.rule }, { label: "Affected host", value: alert.agent }, { label: "Category", value: alert.category }, { label: "Observed", value: fullStamp(new Date(alert.ts)) }] }, { title: "Exact plotted location", items: [{ label: "City", value: alert.srcCity }, { label: "Country", value: country?.properties?.name ?? alert.srcCountryName }, { label: "Latitude", value: alert.srcLat.toFixed(5) }, { label: "Longitude", value: alert.srcLon.toFixed(5) }] }],
        source: "GLOBAL THREAT VECTOR", recommendation: "Correlate this source with intelligence, validate the affected asset, and contain active access if confirmed.",
      });
      return;
    }
    if (!earthHit) return;
    const localPoint = world.worldToLocal(earthHit.point.clone());
    const [latitude, longitude] = vectorLatLon(localPoint);
    const country = countryAtLocation(latitude, longitude);
    borderSystem.highlight(country);
    showLocation({ latitude, longitude, country, host: country?.id ?? "—", tclass: "GEO", level: "GEO", risk: "N/A", status: "SELECTED" });
    options.onInspect?.({
      eyebrow: "GEOSPATIAL COUNTRY VIEW", title: country?.properties?.name ?? "International waters", subtitle: "Selected position on the global threat surface", status: country ? "COUNTRY SELECTED" : "GLOBAL POSITION",
      metrics: [{ label: "Latitude", value: latitude.toFixed(5) }, { label: "Longitude", value: longitude.toFixed(5) }, { label: "Country", value: country?.properties?.name ?? "N/A" }, { label: "Boundary", value: country ? "ADMIN-0" : "MARITIME" }],
      sections: [{ title: "Selected coordinates", items: [{ label: "Country", value: country?.properties?.name ?? "International waters" }, { label: "Latitude", value: `${Math.abs(latitude).toFixed(5)}° ${latitude >= 0 ? "N" : "S"}` }, { label: "Longitude", value: `${Math.abs(longitude).toFixed(5)}° ${longitude >= 0 ? "E" : "W"}` }] }, { title: "Available analysis", items: [{ label: "Attack points", value: "Click visible source markers" }, { label: "Zoom", value: "Wheel, pinch, or controls" }, { label: "Rotate", value: "Drag globe surface" }] }],
      source: "DMATICS GEOSPATIAL ENGINE", recommendation: "Select an active attack marker in this region to inspect its rule, host, confidence, and risk context.",
    });
  }

  renderer.domElement.addEventListener("pointerdown", (event) => { pointerStart = [event.clientX, event.clientY]; });
  renderer.domElement.addEventListener("pointerup", (event) => {
    const start = pointerStart;
    pointerStart = null;
    if (!start || Math.hypot(event.clientX - start[0], event.clientY - start[1]) > 5) return;
    inspectLocation(event);
  });
  renderer.domElement.addEventListener("pointercancel", () => { pointerStart = null; });

  function focusLocation(latitude, longitude, detail = "Requested coordinates") {
    const currentDirection = latLonVector(latitude, longitude).applyQuaternion(world.quaternion).normalize();
    const cameraDirection = camera.position.clone().normalize();
    world.quaternion.premultiply(new THREE.Quaternion().setFromUnitVectors(currentDirection, cameraDirection));
    setZoom(3.35);
    const country = countryAtLocation(latitude, longitude);
    borderSystem.highlight(country);
    showLocation({ latitude, longitude, country, detail });
  }

  showLocation({ latitude: HQ[0], longitude: HQ[1], country: "UNITED ARAB EMIRATES", detail: "Protected perimeter · Dubai" });

  function resize() {
    const { width, height } = container.getBoundingClientRect();
    const pixelBudgetRatio = Math.sqrt(4_000_000 / Math.max(1, width * height));
    renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5, pixelBudgetRatio));
    renderer.setSize(Math.max(1, width), Math.max(1, height), false);
    camera.aspect = Math.max(1, width) / Math.max(1, height);
    camera.updateProjectionMatrix();
  }

  const clock = new THREE.Clock();
  const markerWorldPosition = new THREE.Vector3();
  const projectedMarkerPosition = new THREE.Vector3();
  const markerOutward = new THREE.Vector3();
  const markerTowardCamera = new THREE.Vector3();
  const countryWorldPosition = new THREE.Vector3();
  const projectedCountryPosition = new THREE.Vector3();
  let animationFrame = 0;
  function render() {
    const delta = Math.min(clock.getDelta(), .05);
    elapsed += delta;
    driftTowardHq();
    if (!reducedMotion) {
      wire.rotation.y += delta * .018;
      clouds.rotation.y += delta * .012;
      clouds.rotation.z = Math.sin(elapsed * .06) * .012;
      cityLights.material.opacity = .78 + Math.sin(elapsed * 1.25) * .16;
      atmosphere.scale.setScalar(1 + Math.sin(elapsed * .7) * .004);
      hq.scale.setScalar(1 + Math.sin(elapsed * 3.4) * .22);
    }
    for (const slot of arcs) {
      if (!slot.active) continue;
      slot.progress += delta * slot.speed;
      const pointIndex = Math.min(ARC_POINTS - 1, Math.floor(slot.progress * (ARC_POINTS - 1)));
      slot.line.geometry.setDrawRange(Math.max(0, pointIndex - 34), Math.min(35, pointIndex + 1));
      slot.pulse.position.copy(slot.points[pointIndex]);
      if (slot.progress >= 1) {
        slot.active = false;
        slot.line.visible = false;
        slot.pulse.visible = false;
        spawnImpact(slot.critical);
      }
    }
    for (const impact of impacts) {
      if (!impact.active) continue;
      impact.progress += delta * 1.3;
      impact.mesh.scale.setScalar(1 + impact.progress * 5.5);
      impact.mesh.material.opacity = Math.max(0, .85 - impact.progress);
      if (impact.progress >= 1) { impact.active = false; impact.mesh.visible = false; }
    }
    for (const marker of locationMarkers) {
      if (!marker.group.visible) continue;
      marker.age += delta;
      if (!reducedMotion) {
        const pulse = 1 + Math.sin(elapsed * 4 + marker.age) * .16;
        marker.ring.scale.setScalar(pulse);
      }
      if (marker.age > 55) {
        const opacity = Math.max(0, 1 - (marker.age - 55) / 8);
        marker.dot.material.opacity = opacity;
        marker.ring.material.opacity = opacity * .5;
        if (marker.age >= 63) marker.group.visible = false;
      }
    }
    controls.update();
    world.updateMatrixWorld(true);
    for (const marker of locationMarkers) {
      let visible = marker.group.visible && marker.sequence >= markerSequence - 4 && marker.age <= 45;
      if (visible) {
        marker.group.getWorldPosition(markerWorldPosition);
        markerOutward.copy(markerWorldPosition).normalize();
        markerTowardCamera.copy(camera.position).sub(markerWorldPosition).normalize();
        projectedMarkerPosition.copy(markerWorldPosition).project(camera);
        visible = markerOutward.dot(markerTowardCamera) >= .04 && Math.abs(projectedMarkerPosition.x) <= .93 && Math.abs(projectedMarkerPosition.y) <= .88 && projectedMarkerPosition.z <= 1;
      }
      if (marker.label.hidden === visible) marker.label.hidden = !visible;
      if (visible) marker.label.style.transform = `translate3d(${(projectedMarkerPosition.x * .5 + .5) * container.clientWidth}px,${(-projectedMarkerPosition.y * .5 + .5) * container.clientHeight}px,0) translate(9px,-50%)`;
    }
    const showCountryLabels = camera.position.length() < 4.5;
    for (const entry of countryLabels) {
      let visible = showCountryLabels;
      if (visible) {
        countryWorldPosition.copy(entry.position);
        world.localToWorld(countryWorldPosition);
        markerOutward.copy(countryWorldPosition).normalize();
        markerTowardCamera.copy(camera.position).sub(countryWorldPosition).normalize();
        projectedCountryPosition.copy(countryWorldPosition).project(camera);
        visible = markerOutward.dot(markerTowardCamera) >= .1 && Math.abs(projectedCountryPosition.x) <= .88 && Math.abs(projectedCountryPosition.y) <= .82;
      }
      if (entry.label.hidden === visible) entry.label.hidden = !visible;
      if (visible) entry.label.style.transform = `translate3d(${(projectedCountryPosition.x * .5 + .5) * container.clientWidth}px,${(-projectedCountryPosition.y * .5 + .5) * container.clientHeight}px,0) translate(-50%,-50%)`;
    }
    renderer.render(scene, camera);
    animationFrame = requestAnimationFrame(render);
  }

  addEventListener("resize", resize, { passive: true });
  const resizeObserver = new ResizeObserver(resize);
  resizeObserver.observe(container);
  resize();
  render();
  return {
    spawnAttack,
    focusLocation,
    activeCount: () => arcs.filter((slot) => slot.active).length,
    dispose() {
      cancelAnimationFrame(animationFrame);
      resizeObserver.disconnect();
      controls.dispose();
      renderer.dispose();
      countryLabels.forEach((entry) => entry.label.remove());
      locationMarkers.forEach((marker) => marker.label.remove());
    },
  };
}
