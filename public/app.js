/*
 * Fair Seat Purchase — accessible venue-browsing client (vanilla JS, no deps).
 *
 * Two-level navigation against the Express API:
 *   1. VENUE OVERVIEW — GET /venues/ARENA1/sections rendered as tier-grouped
 *      cards with price badges + availability meters. Counts re-poll every ~8s.
 *   2. SECTION VIEW   — clicking a card opens its seat map (an accessible
 *      keyboard grid), with a live section count polled every ~5s.
 *
 * Accessibility features preserved from the original build:
 * - Seat map is a keyboard grid with roving tabindex + Arrow-key navigation
 *   (Home/End jump within a row); each seat exposes a full descriptive label.
 * - Polite live region announces status; an assertive region announces errors;
 *   countdown milestones are announced sparingly.
 * - Hold/confirmation are focus-trapped dialogs (Escape closes/releases) that
 *   move focus in on open and restore it on close.
 * - Section cards are focusable buttons; leaving a section restores focus to
 *   the originating card.
 *
 * The Fan ID is sent as `x-fan-id` — a stand-in for the upstream eligibility
 * token (placeholder auth).
 */
"use strict";

const VENUE = "ARENA1";
const OVERVIEW_POLL_MS = 8000;
const SECTION_POLL_MS = 5000;

// API base URL. Empty = same-origin (local `npm start`, where Express serves
// both the UI and the API). When the UI is hosted on S3/CloudFront, config.js
// sets window.FSP_API_BASE to the API Gateway URL so requests hit the API.
const API_BASE = (window.FSP_API_BASE || "").replace(/\/+$/, "");

/** Tier ordering + CSS accent variables. Text label is always shown alongside. */
const TIER_ORDER = ["VIP", "Lower", "Club", "Upper", "Balcony"];
const TIER_STYLE = {
  VIP: { color: "var(--tier-vip)", bg: "var(--tier-vip-bg)" },
  Lower: { color: "var(--tier-lower)", bg: "var(--tier-lower-bg)" },
  Club: { color: "var(--tier-club)", bg: "var(--tier-club-bg)" },
  Upper: { color: "var(--tier-upper)", bg: "var(--tier-upper-bg)" },
  Balcony: { color: "var(--tier-balcony)", bg: "var(--tier-balcony-bg)" },
};
function tierStyle(tier) {
  return TIER_STYLE[tier] || { color: "var(--tier-default)", bg: "var(--tier-default-bg)" };
}

const $ = (id) => document.getElementById(id);

const el = {
  fanId: $("fanId"),
  message: $("message"),
  alert: $("alert"),
  // Overview view
  overviewView: $("overviewView"),
  venueName: $("venueName"),
  refreshBtn: $("refreshBtn"),
  overviewEmpty: $("overviewEmpty"),
  tierGroups: $("tierGroups"),
  // Section view
  sectionView: $("sectionView"),
  backBtn: $("backBtn"),
  sectionTitle: $("sectionTitle"),
  sectionAvail: $("sectionAvail"),
  seatmap: $("seatmap"),
  seatmapRegion: $("seatmap-region"),
  // Hold dialog
  holdOverlay: $("holdOverlay"),
  holdDialog: $("holdDialog"),
  holdInfo: $("holdInfo"),
  holdAmount: $("holdAmount"),
  countdown: $("countdown"),
  payBtn: $("payBtn"),
  releaseBtn: $("releaseBtn"),
  // Confirmation dialog
  confirmOverlay: $("confirmOverlay"),
  confirmDialog: $("confirmDialog"),
  confirmInfo: $("confirmInfo"),
  doneBtn: $("doneBtn"),
};

// ── Application state ────────────────────────────────────────────────────────
let overviewPollTimer = null;
let sectionPollTimer = null;
let countdownTimer = null;
let currentSection = null; // { section, tier, price, capacity, available }
let currentHold = null;    // { venue, section, row, seat, txnId, holdExpiration, amount }
let cardEls = new Map();   // section id -> card button element (for focus restore)
let originatingCard = null; // card that opened the section view
let lastFocused = null;    // element to restore focus to when a dialog closes
let lastAnnouncedMinute = -1;

// ── Helpers ─────────────────────────────────────────────────────────────────

function randomFanId() {
  return "FAN#" + Math.random().toString(36).slice(2, 8).toUpperCase();
}

function setMessage(text, kind) {
  el.message.textContent = text || "";
  el.message.className = "message" + (kind ? " " + kind : "");
}

/** Announce an error in the assertive live region (screen readers interrupt). */
function announceError(text) {
  el.alert.textContent = "";
  // Re-assign on next tick so repeated identical messages are still announced.
  window.requestAnimationFrame(() => { el.alert.textContent = text; });
  setMessage(text, "error");
}

function fanId() {
  if (!el.fanId.value.trim()) el.fanId.value = randomFanId();
  return el.fanId.value.trim();
}

function money(amount) {
  const n = Number(amount);
  if (Number.isNaN(n)) return String(amount);
  return "$" + n.toLocaleString("en-US");
}

async function api(method, path, body, withFan) {
  const headers = {};
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (withFan) headers["x-fan-id"] = fanId();
  const res = await fetch(API_BASE + path, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let payload = null;
  try { payload = await res.json(); } catch (_e) { payload = null; }
  if (!res.ok) {
    const err = new Error((payload && payload.error) || ("HTTP " + res.status));
    err.status = res.status;
    err.code = payload && payload.code;
    throw err;
  }
  return payload;
}

function friendlyError(err, context) {
  switch (err && err.status) {
    case 409: return "That seat was just taken. Please choose another.";
    case 402: return "Payment was declined. Your seat stays held until it expires.";
    case 404: return "That seat or transaction could not be found.";
    case 401: return "Missing Fan ID. Enter a Fan ID and try again.";
    case 400: return "That request was not valid.";
    case 503: return "The service is busy. Please try again in a moment.";
    default: return (context ? context + ": " : "") + ((err && err.message) || "Unexpected error.");
  }
}

function sortKey(a, b) {
  const na = Number(a), nb = Number(b);
  if (!Number.isNaN(na) && !Number.isNaN(nb)) return na - nb;
  return String(a).localeCompare(String(b));
}

function sectionBase(section) {
  return "/venues/" + encodeURIComponent(VENUE) + "/sections/" + encodeURIComponent(section);
}

// ══ VENUE OVERVIEW ═══════════════════════════════════════════════════════════

/** Fetch the section catalog and render tier-grouped cards. */
async function loadOverview(opts) {
  const quiet = opts && opts.quiet;
  if (!quiet) setMessage("Loading sections…");
  try {
    const sections = await api("GET", "/venues/" + encodeURIComponent(VENUE) + "/sections");
    renderOverview(sections);
    if (!quiet) {
      setMessage(
        sections.length
          ? "Loaded " + sections.length + " section" + (sections.length === 1 ? "" : "s") + " for " + VENUE + "."
          : "No sections available for " + VENUE + " right now.",
      );
    }
    startOverviewPolling();
  } catch (err) {
    announceError(friendlyError(err, "Could not load sections"));
    el.overviewEmpty.hidden = false;
    el.overviewEmpty.textContent = "Could not load sections. Use Refresh to try again.";
  }
}

/** Render the section catalog as labelled, tier-grouped, clickable cards. */
function renderOverview(sections) {
  el.tierGroups.innerHTML = "";
  cardEls = new Map();

  if (!Array.isArray(sections) || sections.length === 0) {
    el.overviewEmpty.hidden = false;
    el.overviewEmpty.textContent = "No sections to show.";
    return;
  }
  el.overviewEmpty.hidden = true;

  // Group by tier while preserving the API's price-desc order within each tier.
  const groups = new Map();
  for (const s of sections) {
    const tier = s.tier || "Other";
    if (!groups.has(tier)) groups.set(tier, []);
    groups.get(tier).push(s);
  }

  // Known tiers first (in canonical order), then any extras alphabetically.
  const orderedTiers = [
    ...TIER_ORDER.filter((t) => groups.has(t)),
    ...[...groups.keys()].filter((t) => !TIER_ORDER.includes(t)).sort(),
  ];

  for (const tier of orderedTiers) {
    const style = tierStyle(tier);
    const sectionsInTier = groups.get(tier);

    const group = document.createElement("section");
    group.className = "tier-group";
    group.style.setProperty("--tier-color", style.color);
    group.style.setProperty("--tier-bg", style.bg);
    const headingId = "tier-" + tier.replace(/[^a-z0-9]/gi, "");
    group.setAttribute("aria-labelledby", headingId);

    const head = document.createElement("div");
    head.className = "tier-group-head";
    const badge = document.createElement("h3");
    badge.className = "tier-badge";
    badge.id = headingId;
    badge.textContent = tier;
    const count = document.createElement("span");
    count.className = "tier-count";
    count.textContent = sectionsInTier.length + " section" + (sectionsInTier.length === 1 ? "" : "s");
    head.appendChild(badge);
    head.appendChild(count);
    group.appendChild(head);

    const grid = document.createElement("div");
    grid.className = "card-grid";
    for (const s of sectionsInTier) {
      grid.appendChild(buildSectionCard(s, style));
    }
    group.appendChild(grid);
    el.tierGroups.appendChild(group);
  }
}

/** Build one clickable, keyboard-focusable section card. */
function buildSectionCard(s, style) {
  const card = document.createElement("button");
  card.type = "button";
  card.className = "section-card";
  card.style.setProperty("--tier-color", style.color);
  card.style.setProperty("--tier-bg", style.bg);
  card.dataset.section = s.section;
  cardEls.set(s.section, card);

  const top = document.createElement("div");
  top.className = "card-top";

  const idWrap = document.createElement("div");
  const id = document.createElement("div");
  id.className = "card-id";
  id.textContent = s.section;
  const tier = document.createElement("span");
  tier.className = "card-tier";
  tier.textContent = s.tier;
  idWrap.appendChild(id);
  idWrap.appendChild(tier);

  const price = document.createElement("span");
  price.className = "price-badge";
  price.textContent = money(s.price);

  top.appendChild(idWrap);
  top.appendChild(price);

  const availText = document.createElement("p");
  availText.className = "card-avail-text";
  const strong = document.createElement("strong");
  strong.textContent = s.available + " / " + s.capacity;
  availText.appendChild(strong);
  availText.appendChild(document.createTextNode(" available"));

  const meter = document.createElement("div");
  meter.className = "meter";
  meter.setAttribute("role", "presentation");
  const fill = document.createElement("div");
  fill.className = "meter-fill";
  const pct = s.capacity > 0 ? Math.round((s.available / s.capacity) * 100) : 0;
  fill.style.width = pct + "%";
  meter.appendChild(fill);

  card.appendChild(top);
  card.appendChild(availText);
  card.appendChild(meter);

  if (s.available <= 0) card.classList.add("sold-out");

  card.setAttribute(
    "aria-label",
    "View seats in section " + s.section + ", " + s.tier + ", " + money(s.price) +
      ", " + s.available + " of " + s.capacity + " available.",
  );

  card.addEventListener("click", () => openSection(s));
  return card;
}

/** Poll the overview counts without rebuilding the DOM (updates in place). */
async function refreshOverviewCounts() {
  try {
    const sections = await api("GET", "/venues/" + encodeURIComponent(VENUE) + "/sections");
    for (const s of sections) {
      const card = cardEls.get(s.section);
      if (!card) continue;
      const strong = card.querySelector(".card-avail-text strong");
      const fill = card.querySelector(".meter-fill");
      if (strong) strong.textContent = s.available + " / " + s.capacity;
      const pct = s.capacity > 0 ? Math.round((s.available / s.capacity) * 100) : 0;
      if (fill) fill.style.width = pct + "%";
      card.classList.toggle("sold-out", s.available <= 0);
      card.setAttribute(
        "aria-label",
        "View seats in section " + s.section + ", " + s.tier + ", " + money(s.price) +
          ", " + s.available + " of " + s.capacity + " available.",
      );
    }
  } catch (_err) {
    /* Silent — polling failures should not interrupt the user. */
  }
}

function startOverviewPolling() {
  stopOverviewPolling();
  overviewPollTimer = setInterval(refreshOverviewCounts, OVERVIEW_POLL_MS);
}
function stopOverviewPolling() {
  if (overviewPollTimer) clearInterval(overviewPollTimer);
  overviewPollTimer = null;
}

// ── View switching ───────────────────────────────────────────────────────────

function showOverview() {
  stopSectionPolling();
  currentSection = null;
  el.sectionView.hidden = true;
  el.overviewView.hidden = false;
  startOverviewPolling();
  refreshOverviewCounts();
  // Restore focus to the card that opened the section view, if still present.
  if (originatingCard && document.contains(originatingCard)) {
    originatingCard.focus();
  }
  originatingCard = null;
}

function openSection(s) {
  originatingCard = cardEls.get(s.section) || document.activeElement;
  currentSection = s;
  stopOverviewPolling();
  el.overviewView.hidden = true;
  el.sectionView.hidden = false;
  el.sectionTitle.textContent =
    "Section " + s.section + " — " + s.tier + " — " + money(s.price);
  el.seatmap.innerHTML = "";
  const loading = document.createElement("p");
  loading.className = "empty-note";
  loading.textContent = "Loading seats…";
  el.seatmap.appendChild(loading);
  el.sectionAvail.textContent = "Loading availability…";
  el.seatmapRegion.focus();
  loadSeatMap();
}

// ══ SECTION VIEW — seat map + availability ══════════════════════════════════

// "row|seat" -> button element, so poll updates can recolour seats in place
// (preserving keyboard focus) instead of rebuilding the whole grid.
let seatEls = new Map();

async function loadSeatMap(opts) {
  const quiet = opts && opts.quiet;
  if (!currentSection) return;
  const section = currentSection.section;
  if (!quiet) setMessage("Loading seats…");
  try {
    const seats = await api("GET", sectionBase(section) + "/seats");
    renderSeatMap(seats);
    updateAvailLabel(countAvailable(seats));
    if (!quiet) {
      setMessage("Loaded " + seats.length + " seat" + (seats.length === 1 ? "" : "s") + " in section " + section + ".");
    }
    startSectionPolling();
  } catch (err) {
    announceError(friendlyError(err, "Could not load seats"));
    renderSeatMap([]);
  }
}

function countAvailable(seats) {
  return seats.reduce((n, s) => n + (s.status === "available" ? 1 : 0), 0);
}

/**
 * Render EVERY seat in the section as an accessible grid of labelled buttons,
 * colour-coded by status: green = available, purple = held (booking in
 * progress), red = sold (booked). Only available seats can be activated to
 * hold. Status is conveyed by a glyph + full text label, never colour alone.
 */
function renderSeatMap(seats) {
  el.seatmap.innerHTML = "";
  seatEls = new Map();
  const section = currentSection ? currentSection.section : "";
  const priceLabel = currentSection ? money(currentSection.price) : "";

  if (!Array.isArray(seats) || seats.length === 0) {
    const p = document.createElement("p");
    p.className = "empty-note";
    p.textContent = "No seats to show.";
    el.seatmap.appendChild(p);
    return;
  }

  const rows = new Map();
  for (const s of seats) {
    const row = String(s.row);
    if (!rows.has(row)) rows.set(row, []);
    rows.get(row).push(s);
  }

  let firstSeatBtn = null;
  for (const row of [...rows.keys()].sort(sortKey)) {
    const rowEl = document.createElement("div");
    rowEl.className = "seat-row";
    rowEl.setAttribute("role", "row");

    const label = document.createElement("span");
    label.className = "row-label";
    label.id = "rowlabel-" + row;
    label.setAttribute("role", "rowheader");
    label.textContent = "Row " + row;
    rowEl.appendChild(label);

    const seatsInRow = rows.get(row).sort((a, b) => sortKey(a.seat, b.seat));
    for (const s of seatsInRow) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.setAttribute("role", "gridcell");
      btn.dataset.row = String(s.row);
      btn.dataset.seat = String(s.seat);
      // Roving tabindex: only the first seat is tabbable; Arrow keys move focus
      // across ALL seats (including held/sold) so the whole map is perceivable.
      btn.tabIndex = firstSeatBtn ? -1 : 0;
      btn.append(document.createTextNode(String(s.seat)));
      btn.addEventListener("click", () => onSeatClick(String(s.row), String(s.seat)));
      applySeatStatus(btn, s.status, section, priceLabel);
      rowEl.appendChild(btn);
      seatEls.set(row + "|" + String(s.seat), btn);
      if (!firstSeatBtn) firstSeatBtn = btn;
    }
    el.seatmap.appendChild(rowEl);
  }

  enableGridKeyboard();
}

/** Apply a seat's status to its button: colour class, glyph, and full label. */
function applySeatStatus(btn, status, section, priceLabel) {
  btn.classList.remove("seat", "seat-available", "seat-held", "seat-sold");
  btn.classList.add("seat", "seat-" + status);
  btn.dataset.status = status;
  let word;
  if (status === "sold") word = "booked, sold";
  else if (status === "held") word = "booking in progress, held";
  else word = "available";
  if (status === "available") btn.removeAttribute("aria-disabled");
  else btn.setAttribute("aria-disabled", "true");
  const activate = status === "available" ? " Activate to hold this seat." : "";
  btn.setAttribute(
    "aria-label",
    "Section " + section + ", Row " + btn.dataset.row + ", Seat " + btn.dataset.seat +
      ", " + priceLabel + ", " + word + "." + activate,
  );
}

/** Handle a seat activation: only available seats can be held. */
function onSeatClick(row, seat) {
  const btn = seatEls.get(row + "|" + seat);
  const status = btn ? btn.dataset.status : "available";
  if (status !== "available") {
    announceError(status === "sold"
      ? "That seat is already booked."
      : "That seat is being booked by someone else right now.");
    return;
  }
  holdSeat(row, seat);
}

/** Update seat colours in place from a fresh /seats poll (keeps focus). */
function updateSeatStatuses(seats) {
  if (!seatEls || seatEls.size === 0) { renderSeatMap(seats); return; }
  const section = currentSection ? currentSection.section : "";
  const priceLabel = currentSection ? money(currentSection.price) : "";
  for (const s of seats) {
    const btn = seatEls.get(String(s.row) + "|" + String(s.seat));
    if (btn && btn.dataset.status !== s.status) {
      applySeatStatus(btn, s.status, section, priceLabel);
    }
  }
}

/** Update the section availability count display. */
function updateAvailLabel(available) {
  if (!currentSection) return;
  currentSection.available = available;
  el.sectionAvail.textContent = available + " of " + currentSection.capacity + " seats available";
}

/** Arrow-key / Home / End navigation across the seat grid (roving tabindex). */
function enableGridKeyboard() {
  el.seatmap.onkeydown = (e) => {
    const keys = ["ArrowRight", "ArrowLeft", "ArrowUp", "ArrowDown", "Home", "End"];
    if (!keys.includes(e.key)) return;
    const current = document.activeElement;
    if (!current || !current.classList.contains("seat")) return;

    const rowsEls = [...el.seatmap.querySelectorAll(".seat-row")];
    const rowEl = current.closest(".seat-row");
    const rowIndex = rowsEls.indexOf(rowEl);
    const seatsInRow = [...rowEl.querySelectorAll(".seat")];
    const colIndex = seatsInRow.indexOf(current);
    let target = null;

    if (e.key === "ArrowRight") target = seatsInRow[colIndex + 1];
    else if (e.key === "ArrowLeft") target = seatsInRow[colIndex - 1];
    else if (e.key === "Home") target = seatsInRow[0];
    else if (e.key === "End") target = seatsInRow[seatsInRow.length - 1];
    else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      const nextRow = rowsEls[rowIndex + (e.key === "ArrowDown" ? 1 : -1)];
      if (nextRow) {
        const nextSeats = [...nextRow.querySelectorAll(".seat")];
        target = nextSeats[Math.min(colIndex, nextSeats.length - 1)];
      }
    }

    if (target) {
      e.preventDefault();
      current.tabIndex = -1;
      target.tabIndex = 0;
      target.focus();
    }
  };
}

/** Poll all seats and recolour them in place, and refresh the count. */
async function refreshSeats() {
  if (!currentSection) return;
  try {
    const seats = await api("GET", sectionBase(currentSection.section) + "/seats");
    updateSeatStatuses(seats);
    updateAvailLabel(countAvailable(seats));
  } catch (_err) {
    /* Silent — a transient poll failure should not disrupt the user. */
  }
}

function startSectionPolling() {
  stopSectionPolling();
  sectionPollTimer = setInterval(refreshSeats, SECTION_POLL_MS);
}
function stopSectionPolling() {
  if (sectionPollTimer) clearInterval(sectionPollTimer);
  sectionPollTimer = null;
}

// ══ HOLD ═════════════════════════════════════════════════════════════════════

async function holdSeat(row, seat) {
  if (!currentSection) return;
  const venue = VENUE;
  const section = currentSection.section;
  lastFocused = document.activeElement;
  setMessage("Holding seat…");
  try {
    const result = await api("POST", "/holds", { venue, section, row, seat }, true);
    currentHold = {
      venue, section, row, seat,
      txnId: result.txnId,
      holdExpiration: result.holdExpiration,
      amount: result.amount != null ? result.amount : result.price,
    };
    openHoldDialog();
    setMessage("");
    await refreshSeats();
  } catch (err) {
    announceError(friendlyError(err, "Could not hold seat"));
    if (err.status === 409) await refreshSeats();
  }
}

function openHoldDialog() {
  el.holdInfo.textContent =
    "Section " + currentHold.section + ", Row " + currentHold.row +
    ", Seat " + currentHold.seat + ". Complete payment before the timer runs out.";
  el.holdAmount.textContent = money(currentHold.amount);
  el.holdOverlay.hidden = false;
  el.payBtn.disabled = false;
  el.releaseBtn.disabled = false;
  lastAnnouncedMinute = -1;
  startCountdown();
  trapFocus(el.holdDialog);
  el.payBtn.focus();
}

function closeHoldDialog() {
  el.holdOverlay.hidden = true;
  stopCountdown();
  releaseFocusTrap();
}

function startCountdown() {
  stopCountdown();
  const tick = () => {
    if (!currentHold) return;
    const remaining = Math.floor(currentHold.holdExpiration - Date.now() / 1000);
    if (remaining <= 0) {
      el.countdown.textContent = "expired";
      el.payBtn.disabled = true;
      el.releaseBtn.disabled = true;
      stopCountdown();
      announceError("Your hold has expired. The seat is available to others again.");
      closeHoldDialog();
      restoreFocus();
      loadSeatMap({ quiet: true });
      return;
    }
    const m = Math.floor(remaining / 60);
    const s = remaining % 60;
    el.countdown.textContent = m + " min " + String(s).padStart(2, "0") + " sec";
    // Announce at each whole minute and in the final 10 seconds, without spamming.
    if (m !== lastAnnouncedMinute && (remaining % 60 === 0 || remaining === 10)) {
      lastAnnouncedMinute = m;
      el.countdown.setAttribute("aria-live", "polite");
      window.setTimeout(() => el.countdown.setAttribute("aria-live", "off"), 1200);
    }
  };
  tick();
  countdownTimer = setInterval(tick, 1000);
}
function stopCountdown() {
  if (countdownTimer) clearInterval(countdownTimer);
  countdownTimer = null;
}

// ══ PAY / RELEASE ════════════════════════════════════════════════════════════

async function pay() {
  if (!currentHold) return;
  el.payBtn.disabled = true;
  el.releaseBtn.disabled = true;
  setMessage("Processing payment…");
  try {
    const result = await api("POST", "/payments", {
      venue: currentHold.venue, section: currentHold.section,
      row: currentHold.row, seat: currentHold.seat,
      txnId: currentHold.txnId, processorResult: "success",
    }, true);
    closeHoldDialog();
    openConfirmDialog(result);
    setMessage("");
    await refreshSeats();
  } catch (err) {
    announceError(friendlyError(err, "Payment failed"));
    el.payBtn.disabled = false;
    el.releaseBtn.disabled = false;
  }
}

async function release() {
  if (!currentHold) return;
  el.payBtn.disabled = true;
  el.releaseBtn.disabled = true;
  setMessage("Releasing seat…");
  const held = currentHold;
  try {
    await api("POST", "/releases", {
      venue: held.venue, section: held.section, row: held.row, seat: held.seat,
    }, true);
    currentHold = null;
    closeHoldDialog();
    restoreFocus();
    setMessage("Seat " + held.row + "-" + held.seat + " released. It is available again.", "ok");
    await refreshSeats();
  } catch (err) {
    announceError(friendlyError(err, "Could not release seat"));
    el.payBtn.disabled = false;
    el.releaseBtn.disabled = false;
  }
}

// ══ CONFIRMATION ═════════════════════════════════════════════════════════════

function openConfirmDialog(result) {
  const txn = (result && result.transaction) || {};
  const seat = (result && result.seat) || {};
  const amount = (txn.Amount != null ? txn.Amount : (currentHold && currentHold.amount));
  el.confirmInfo.textContent =
    "Seat " + (seat.Row || (currentHold && currentHold.row)) + "-" +
    (seat.Seat_Number || (currentHold && currentHold.seat)) +
    " is now " + (seat.Seat_Status || "sold") + ". " +
    (amount != null ? "You were charged " + money(amount) + ". " : "") +
    "Transaction " + (txn.SK || (currentHold && currentHold.txnId)) +
    " is " + (txn.Txn_State || "confirmed") + ".";
  currentHold = null;
  el.confirmOverlay.hidden = false;
  trapFocus(el.confirmDialog);
  el.doneBtn.focus();
}

function closeConfirmDialog() {
  el.confirmOverlay.hidden = true;
  releaseFocusTrap();
}

// ══ Focus management for dialogs ═════════════════════════════════════════════

let trapHandler = null;

function trapFocus(dialog) {
  const focusables = () =>
    [...dialog.querySelectorAll("button, [href], input, select, textarea, [tabindex]:not([tabindex='-1'])")]
      .filter((n) => !n.disabled && n.offsetParent !== null);
  trapHandler = (e) => {
    if (e.key === "Escape") {
      e.preventDefault();
      // Escape releases a hold, or dismisses the confirmation.
      if (!el.holdOverlay.hidden) { release(); }
      else if (!el.confirmOverlay.hidden) { closeConfirmDialog(); setMessage(""); showOverview(); }
      return;
    }
    if (e.key !== "Tab") return;
    const items = focusables();
    if (items.length === 0) return;
    const first = items[0], last = items[items.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  };
  document.addEventListener("keydown", trapHandler, true);
}

function releaseFocusTrap() {
  if (trapHandler) document.removeEventListener("keydown", trapHandler, true);
  trapHandler = null;
}

function restoreFocus() {
  if (lastFocused && document.contains(lastFocused)) {
    lastFocused.focus();
  } else {
    el.seatmapRegion.focus();
  }
}

// ══ Wiring ═══════════════════════════════════════════════════════════════════

el.refreshBtn.addEventListener("click", () => loadOverview());
el.backBtn.addEventListener("click", () => {
  setMessage("");
  showOverview();
});
el.payBtn.addEventListener("click", pay);
el.releaseBtn.addEventListener("click", release);
el.doneBtn.addEventListener("click", () => {
  closeConfirmDialog();
  setMessage("");
  showOverview(); // Close the confirmation and return home to the venue overview.
});

el.venueName.textContent = VENUE;
el.fanId.value = randomFanId();
loadOverview();
