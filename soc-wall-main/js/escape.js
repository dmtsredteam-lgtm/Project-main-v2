/* ===========================================================================
 * One escaper, imported everywhere.
 *
 * The wall builds most of its DOM with innerHTML and template literals, which
 * is fine for speed on a kiosk — but every value interpolated that way is a
 * script tag waiting for someone who can reach the hub. Three modules had a
 * local escaper, three did not, and the ones that did not were rendering
 * alert.rule, alert.agent and the origin country names straight from the wire.
 *
 * Anything on the booth LAN can POST to the hub's ingest. A visitor's phone on
 * the show wifi could put `<img src=x onerror=...>` on the big screen. Now the
 * escaper lives in one place and there is no version of it to forget.
 * ========================================================================= */

const ENTITIES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

/** Escapes for both element text and quoted attribute values. */
export const escapeHtml = (value) =>
  String(value ?? "").replace(/[&<>"']/g, (character) => ENTITIES[character]);

/**
 * A finite number, or the fallback.
 *
 * Used at every boundary where a value off the wire is about to have .toFixed()
 * or .toLocaleString() called on it. A string where a number was expected does
 * not throw on arrival — it throws three modules later, inside a render, and
 * takes the rest of that render with it.
 */
export const finite = (value, fallback = 0) => {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
};

/** A plain string, clipped. Guards against an object, an array, or 4 KB of noise. */
export const text = (value, fallback = "", max = 240) => {
  if (value === null || value === undefined) return fallback;
  const string = typeof value === "string" ? value : String(value);
  return (string.length > max ? string.slice(0, max) : string) || fallback;
};
