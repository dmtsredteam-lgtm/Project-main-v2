/**
 * GISEC Arena — the live leaderboard for every booth game.
 *
 * Fills the whole lower deck. An earlier version rotated one board at a time
 * through a small panel, which meant a visitor who wanted to know where they
 * placed on Phish Hunter had to stand and wait for it to come round — and three
 * of the four games were invisible at any given moment. Every board is now on
 * screen at once: the overall standings on the left, wider and heavier, then a
 * column per game.
 *
 * A score that lands pulses its row once, so a player watching from the stand
 * sees their own name arrive rather than having to hunt for it.
 */

import { registerDetail } from "./details.js";
import { escapeHtml, finite } from "./escape.js";
import { shortTime, TZ_LABEL } from "./clock.js";

const ORDER = ["redteam", "phish", "soc", "breach"];

const META = {
  phish:   { label: "PHISH HUNTER",   accent: "cyan",     rows: 8, surface: "TABLET",
    note: "Spot the fake sender in sixty seconds" },
  soc:     { label: "ALERT RUSH",     accent: "emerald",  rows: 8, surface: "TABLET",
    note: "Escalate the real threats, clear the noise" },
  breach:  { label: "BREACH POINT",   accent: "purple",   rows: 8, surface: "TABLET",
    note: "Find the weakest link before our pentesters would" },
  redteam: { label: "RED TEAM OP",    accent: "critical", rows: 8, surface: "LAPTOPS",
    note: "Five-stage breach of the target network" },
};

const pad = (value) => String(value).padStart(2, "0");
/* The escaper now lives in escape.js so alerts.js, ticker.js and health.js
   cannot drift from it — three of them had no escaper at all. */

/** Red Team rows carry objectives and a clock; arcade rows are a point total. */
function subline(game, row) {
  if (game === "redteam") {
    const seconds = row.meta?.seconds ?? 0;
    return `${row.meta?.flags ?? 0}/5 OBJECTIVES · ${pad(Math.floor(seconds / 60))}:${pad(seconds % 60)}`
      + (row.meta?.finished ? " ✓" : "");
  }
  return `BEST OF ${shortTime(new Date(finite(row.t, Date.now())))} ${TZ_LABEL}`;
}

export function createArenaPanel(elements) {
  const { board, players, stations, runs } = elements;
  if (!board) return { update() {}, setStations() {}, flash() {}, destroy() {} };

  let data = { boards: {}, totals: {} };
  let stationList = [];
  let highlight = null;          // { game, name } — pulses once

  function registerColumnDetail(game, rows) {
    const meta = META[game];
    registerDetail(`arena-${game}`, {
      eyebrow: "GISEC ARENA LEADERBOARD",
      title: meta.label,
      subtitle: meta.note,
      status: rows.length ? "LIVE BOARD" : "AWAITING PLAYERS",
      statusTone: rows.length ? "good" : "warning",
      metrics: [
        { label: "Ranked players", value: pad(rows.length) },
        { label: "Top score", value: rows[0] ? escapeHtml(finite(rows[0].s).toLocaleString()) : "—", tone: "good" },
        { label: "Leader", value: rows[0]?.n ?? "—" },
        { label: "Played on", value: meta.surface ?? "ALL SURFACES" },
      ],
      sections: [
        { title: "Board", items: rows.slice(0, 10).map((row, position) => ({ label: `${pad(position + 1)} ${row.n}`, value: escapeHtml(finite(row.s).toLocaleString()) })) },
        { title: "Arena activity", items: [
          { label: "Unique visitors", value: data.totals?.players ?? 0 },
          { label: "Red team runs", value: data.totals?.runs ?? 0 },
          { label: "Contained by the SOC", value: data.totals?.busts ?? 0 },
          { label: "Full compromises", value: data.totals?.wins ?? 0 },
        ] },
      ],
      source: "DMATICS ARENA HUB",
      recommendation: "Beat the board at the DMATICS stand — the top operator of the day takes the trophy at close.",
    });
  }

  function column(game) {
    const meta = META[game];
    const rows = (data.boards?.[game] ?? []).slice(0, meta.rows);
    registerColumnDetail(game, data.boards?.[game] ?? []);

    /* A board with three names on it used to leave two thirds of its column
     * empty, and a half-filled panel reads as broken rather than as early in
     * the day. The unclaimed ranks are drawn as dimmed placeholders instead, so
     * every column is the same height from the moment the doors open and the
     * board visibly has room left in it — which is the thing that makes a
     * visitor want their name on it. */
    const ghosts = Array.from({ length: Math.max(0, meta.rows - rows.length) }, (unused, index) =>
      `<div class="arena-row is-ghost" aria-hidden="true">
        <span class="arena-rank">${pad(rows.length + index + 1)}</span>
        <span class="arena-slot"></span>
      </div>`).join("");

    const body = rows.length
      ? rows.map((row, position) => {
          const isNew = highlight && highlight.game === game && highlight.name === row.n;
          return `<div class="arena-row${position === 0 ? " is-lead" : ""}${isNew ? " is-new" : ""}">
            <span class="arena-rank">${pad(position + 1)}</span>
            <em class="arena-who">${escapeHtml(row.n)}<small>${escapeHtml(subline(game, row))}</small></em>
            <b class="arena-points">${escapeHtml(finite(row.s).toLocaleString())}</b>
          </div>`;
        }).join("") + ghosts
      : `<div class="arena-empty"><span>NO RUNS YET</span><small>${escapeHtml(meta.note)}</small></div>`;

    return `<section class="arena-col ${meta.accent}${game === "overall" ? " is-overall" : ""}"
        data-detail-id="arena-${game}" role="button" tabindex="0" aria-haspopup="dialog"
        aria-label="${escapeHtml(meta.label)} leaderboard">
      <header class="arena-col-head">
        <strong>${escapeHtml(meta.label)}</strong>
        <span>${meta.surface ? escapeHtml(meta.surface) : `${pad((data.boards?.[game] ?? []).length)} RANKED`}</span>
      </header>
      <div class="arena-rows">${body}</div>
    </section>`;
  }

  function render() {
    board.innerHTML = ORDER.map(column).join("");
    if (players) players.textContent = pad(data.totals?.players ?? 0);
    if (runs) {
      const totals = data.totals ?? {};
      runs.textContent = `${pad(totals.runs ?? 0)} RUNS · ${pad(totals.wins ?? 0)} FULL CLEARS · ${pad(totals.busts ?? 0)} CONTAINED`;
    }
  }

  function renderStations() {
    if (!stations) return;
    if (!stationList.length) {
      stations.innerHTML = `<span class="arena-station"><i></i>STATIONS IDLE · AWAITING OPERATORS</span>`;
      return;
    }
    stations.innerHTML = stationList.slice(0, 4).map((station) => {
      const tone = station.posture === "CONTAINED" || station.posture === "THROTTLED" ? "hot"
        : station.posture === "WATCHED" ? "warning"
        : station.posture === "COMPROMISED" ? "warning"
        : station.active ? "good" : "";
      return `<span class="arena-station ${tone}"><i></i>${escapeHtml(station.id)}
        <b>${escapeHtml(station.player ?? "—")}</b>
        <em>${escapeHtml(station.posture ?? "CLEAR")}</em></span>`;
    }).join("");
  }

  render();
  renderStations();

  return {
    /** Full board payload from the hub (`hello` snapshot or a `score` event). */
    update(payload) {
      if (!payload) return;
      if (payload.boards) data = { boards: payload.boards, totals: payload.totals ?? data.totals };
      render();
    },

    /** A score just landed — pulse the player's row on that board. */
    flash(game, entry) {
      if (!META[game] || !entry) return;
      highlight = { game, name: entry.n };
      render();
      setTimeout(() => {
        if (highlight && highlight.name === entry.n) { highlight = null; render(); }
      }, 6_000);
    },

    setStations(list) {
      /* Number(undefined) is NaN, and a comparator that returns NaN gives
       * implementation-defined order — the station chips reshuffled at random
       * between renders whenever a payload was missing `active` or `lastSeen`. */
      stationList = [...list].sort((left, right) =>
        (Number(!!right.active) - Number(!!left.active))
        || (finite(right.lastSeen) - finite(left.lastSeen)));
      renderStations();
    },

    destroy() {},
  };
}
