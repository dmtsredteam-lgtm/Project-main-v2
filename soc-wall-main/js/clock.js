/**
 * Wall time.
 *
 * Every timestamp on the screen reads the venue's local clock, not UTC. A SOC
 * wall that says 04:25 while the hall clock says 08:25 is the first thing a
 * visitor notices and the last thing you want them to notice — the whole
 * surface has to look like it is actually watching something.
 *
 * The zone is configurable (`SOC_CONFIG.timezone`), so the same build runs a
 * stand in Riyadh or Singapore by editing one unbundled line. Formatting goes
 * through Intl, so daylight-saving and offset changes are handled by the
 * browser rather than by arithmetic here.
 */

const TZ = globalThis.SOC_CONFIG?.timezone || "Asia/Dubai";
export const TZ_LABEL = globalThis.SOC_CONFIG?.timezoneLabel || "GST";

/** Intl formatters are expensive to construct and cheap to reuse. */
const build = (options) => {
  try {
    return new Intl.DateTimeFormat("en-GB", { timeZone: TZ, hour12: false, ...options });
  } catch {
    // An unknown zone must not take the wall down; fall back to the host clock.
    console.warn(`Unknown timezone "${TZ}" — falling back to this machine's clock.`);
    return new Intl.DateTimeFormat("en-GB", { hour12: false, ...options });
  }
};

const hms = build({ hour: "2-digit", minute: "2-digit", second: "2-digit" });
const hm = build({ hour: "2-digit", minute: "2-digit" });
const ymd = build({ day: "2-digit", month: "short", year: "numeric" });

/** 14:07:52 */
export const clockTime = (date = new Date()) => hms.format(date);

/** 14:07 */
export const shortTime = (date = new Date()) => hm.format(date);

/** 14:07:52 GST */
export const stamp = (date = new Date()) => `${hms.format(date)} ${TZ_LABEL}`;

/** 22 AUG 2026 · GST */
export const wallDate = (date = new Date()) => `${ymd.format(date).toUpperCase()} · ${TZ_LABEL}`;

/** 22 AUG 2026 14:07:52 GST — for the investigation dialog, where precision reads as evidence. */
export const fullStamp = (date = new Date()) =>
  `${ymd.format(date).toUpperCase()} ${hms.format(date)} ${TZ_LABEL}`;
