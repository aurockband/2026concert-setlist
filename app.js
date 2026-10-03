/* Concert setlist - all frontend behaviour. Vanilla JS, no build step.
 *
 * How a concert reaches the phone:
 *   production  ->  data.enc (AES-GCM, key from the #k= part of the QR URL)
 *   --dev build ->  data.json (plain, served from localhost)
 * Either way the decrypted setlist is cached in localStorage so the page keeps
 * working after the URL fragment is gone (home screen, refresh, airplane mode).
 */

const BUILD = "ff9152eef6";           // replaced by tools/build.py
const KEY_FILE = "data.enc";         // encrypted payload (production builds)
const PLAIN_FILE = "data.json";      // payload for `build.py --dev`
const SCALE_STEPS = [0.85, 1, 1.15, 1.3, 1.5];
const STORE_KEY = `concert:key:${BUILD}`;
const STORE_DATA = `concert:data:${BUILD}`;
const STORE_SCALE = "concert:scale";

const $ = (id) => document.getElementById(id);
const views = ["setlist", "song", "fallback"].map((name) => $(`view-${name}`));

/** Escape untrusted concert text before putting it into innerHTML. */
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => (
  { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
));

let DATA = null;                     // the concert, once decrypted/loaded
let index = -1;                      // index of the open song, -1 = setlist

// --- data loading ----------------------------------------------------------

/** Derive the AES-GCM key from the passphrase, exactly like tools/build.py. */
async function deriveKey(passphrase, salt) {
  const base = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(passphrase), "PBKDF2", false, ["deriveKey"],
  );
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt, iterations: 200000, hash: "SHA-256" },
    base, { name: "AES-GCM", length: 128 }, false, ["decrypt"],
  );
}

/** data.enc is base64 of salt(16) | iv(12) | ciphertext+tag. */
async function decrypt(b64, passphrase) {
  const bytes = Uint8Array.from(atob(b64.trim()), (c) => c.charCodeAt(0));
  if (bytes.length < 29) throw new Error("payload too short");
  const key = await deriveKey(passphrase, bytes.slice(0, 16));
  const plain = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: bytes.slice(16, 28) }, key, bytes.slice(28),
  );
  return JSON.parse(new TextDecoder().decode(plain));
}

async function getText(path) {
  const res = await fetch(path, { cache: "no-cache" });
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
  return res.text();
}

/** Fetch + decrypt (or plainly fetch, in dev) the concert data. */
async function loadData() {
  const passphrase = new URLSearchParams(location.hash.slice(1)).get("k")
    || localStorage.getItem(STORE_KEY);
  if (passphrase) {
    const data = await decrypt(await getText(KEY_FILE), passphrase);
    localStorage.setItem(STORE_KEY, passphrase);
    return data;
  }
  // No key: only a --dev build has readable data here.
  const res = await fetch(PLAIN_FILE, { cache: "no-cache" });
  if (!res.ok) throw new Error(`${PLAIN_FILE}: HTTP ${res.status}`);
  return res.json();
}

async function boot() {
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("sw.js").catch(() => {});
  }

  let data;
  try {
    data = await loadData();
  } catch (err) {
    // No key, wrong key, or no payload at all: fall back to whatever we already
    // decrypted on this phone, otherwise show the friendly screen.
    const cached = localStorage.getItem(STORE_DATA);
    if (cached) {
      try { data = JSON.parse(cached); } catch { /* corrupted cache */ }
    } else {
      // Raw error text only helps while building; the audience just gets the
      // friendly screen below.
      if (BUILD.startsWith("dev")) $("fallback-detail").textContent = String(err.message || err);
      return show("fallback");
    }
  }

  DATA = data;
  localStorage.setItem(STORE_DATA, JSON.stringify(data));
  document.documentElement.lang = data.lang || "en";
  document.title = data.title || "Concert setlist";
  renderSetlist();
  const wanted = new URLSearchParams(location.search).get("s");
  const found = DATA.songs.findIndex((s) => s.id === wanted);
  if (found >= 0) openSong(found, false);
  else show("setlist");
}

function show(name) {
  for (const view of views) view.hidden = view.id !== `view-${name}`;
  $("loading").hidden = true;
  window.scrollTo(0, 0);
}

// --- rendering -------------------------------------------------------------

/** A cue type's label, from the concert's legend, or a friendly default. */
function cueLabel(type) {
  const found = DATA.legend?.find((item) => item.cue === type);
  if (found?.label) return found.label;
  return String(type).replace(/[-_]/g, " ").trim();
}

/** Cue icon as a CSS mask so CSS can tint it (works for unknown cue types too). */
function cueIcon(type) {
  const tint = `var(--cue-${esc(type)}, var(--accent))`;
  return `<span class="cue-icon" style="--cue:${tint};--icon:url('icons/cue-${esc(type)}.svg')"></span>`;
}

/** Show the concert's optional logo, whichever format they supplied. */
async function showLogo() {
  const logo = $("logo");
  for (const name of ["logo.svg", "logo.png"]) {
    try {
      await new Promise((resolve, reject) => {
        logo.onload = resolve;
        logo.onerror = reject;
        logo.src = name;
      });
      logo.hidden = false;
      return;
    } catch { /* not that format, try the next one */ }
  }
}

function renderSetlist() {
  showLogo();
  $("title").textContent = DATA.title || "";
  $("subtitle").textContent = DATA.subtitle || "";
  $("subtitle").hidden = !DATA.subtitle;

  const dateEl = $("date");
  if (DATA.date) {
    // Append T00:00:00 so a YYYY-MM-DD string is not shifted by the time zone.
    const when = new Date(`${DATA.date}T00:00:00`);
    dateEl.textContent = Number.isNaN(+when)
      ? DATA.date
      : new Intl.DateTimeFormat(DATA.lang || undefined, { dateStyle: "full" }).format(when);
  } else {
    dateEl.hidden = true;
  }

  $("intro").textContent = DATA.intro || "";
  $("intro").hidden = !DATA.intro;

  const legend = $("legend");
  legend.innerHTML = (DATA.legend || [])
    .map((item) => `<li>${cueIcon(item.cue)}${esc(item.label || cueLabel(item.cue))}</li>`)
    .join("");
  legend.hidden = !legend.children.length;

  let encoreShown = false;
  $("songs").innerHTML = DATA.songs.map((song, i) => {
    const divider = song.encore && !encoreShown ? (encoreShown = true, '<li class="encore">Encore</li>') : "";
    const cues = [...new Set((song.sections || []).map((s) => s.cue).filter(Boolean))];
    const meta = [song.artist, song.note].filter(Boolean).map(esc).join(" · ");
    const playing = DATA.nowPlaying === song.id ? " ★" : "";
    return `${divider}<li>
      <button type="button" data-index="${i}">
        <span class="num">${i + 1}</span>
        <span class="meta">
          <span class="name">${esc(song.title)}${playing}</span>
          ${meta ? `<span class="artist">${meta}</span>` : ""}
        </span>
        ${cues.length ? `<span class="cues">${cues.map(cueIcon).join("")}</span>` : ""}
      </button></li>`;
  }).join("");
}

function renderSong() {
  const song = DATA.songs[index];
  $("song-title").textContent = song.title || "";
  $("song-meta").textContent = [song.artist, song.note].filter(Boolean).join(" · ");
  $("song-meta").hidden = !$("song-meta").textContent;

  $("song-body").innerHTML = (song.sections || []).map((section) => {
    const text = section.text
      ? `<p class="lyrics">${esc(section.text)}</p>`
      : "";
    if (!section.cue) {
      return `${section.label ? `<h3 class="section-label">${esc(section.label)}</h3>` : ""}${text}`;
    }
    // Cue section: a loud banner with icon + label, lyrics (if any) underneath.
    return `<div class="cue" data-cue="${esc(section.cue)}">
      <p class="cue-head">${cueIcon(section.cue)}${esc(cueLabel(section.cue))}</p>
      ${section.label ? `<h3 class="section-label">${esc(section.label)}</h3>` : ""}
      ${text}
    </div>`;
  }).join("") || '<p class="lyrics">No lyrics for this one.</p>';

  $("prev").disabled = index === 0;
  $("next").disabled = index >= DATA.songs.length - 1;
  for (const button of $("songs").querySelectorAll("button")) {
    button.setAttribute("aria-current", String(Number(button.dataset.index) === index));
  }
}

function openSong(i, push = true) {
  index = i;
  renderSong();
  show("song");
  if (push) {
    // Keep the #k= fragment so a refresh (or copy/paste) still unlocks the app.
    history.pushState({ song: i }, "", `${location.pathname}?s=${i}${location.hash}`);
  }
}

function openSetlist(push = true) {
  index = -1;
  show("setlist");
  if (push) history.pushState({}, "", `${location.pathname}${location.hash}`);
}

// --- small extras ----------------------------------------------------------

/** A-/A+ text size, remembered between visits. */
function applyScale() {
  const step = Number(localStorage.getItem(STORE_SCALE) || 1);
  document.documentElement.style.setProperty("--text-scale", SCALE_STEPS[step] || 1);
}

function bumpScale(delta) {
  const step = Number(localStorage.getItem(STORE_SCALE) || 1);
  const next = Math.min(SCALE_STEPS.length - 1, Math.max(0, step + delta));
  localStorage.setItem(STORE_SCALE, next);
  applyScale();
}

/** Keep the screen awake while the setlist is open (Android Chrome, desktop). */
let wakeLock = null;
async function toggleWake(on) {
  if (on && "wakeLock" in navigator) wakeLock = await navigator.wakeLock.request("screen");
  else if (wakeLock) { await wakeLock.release(); wakeLock = null; }
}
document.addEventListener("visibilitychange", async () => {
  // Browsers drop the lock when the tab is hidden; take it back if we had one.
  if (document.visibilityState === "visible" && wakeLock && wakeLock.released) {
    try { wakeLock = await navigator.wakeLock.request("screen"); } catch { /* denied */ }
  }
});

// --- wiring ----------------------------------------------------------------

$("songs").addEventListener("click", (event) => {
  const button = event.target.closest("button[data-index]");
  if (button) openSong(Number(button.dataset.index));
});
$("back").addEventListener("click", () => openSetlist());
$("prev").addEventListener("click", () => openSong(Math.max(0, index - 1)));
$("next").addEventListener("click", () => openSong(Math.min(DATA.songs.length - 1, index + 1)));
$("font-up").addEventListener("click", () => bumpScale(1));
$("font-down").addEventListener("click", () => bumpScale(-1));
$("wake").addEventListener("click", async (event) => {
  const on = event.currentTarget.getAttribute("aria-pressed") !== "true";
  event.currentTarget.setAttribute("aria-pressed", String(on));
  try { await toggleWake(on); } catch { event.currentTarget.setAttribute("aria-pressed", "false"); }
});

window.addEventListener("popstate", () => {
  const wanted = new URLSearchParams(location.search).get("s");
  const found = DATA ? DATA.songs.findIndex((s) => s.id === wanted) : -1;
  if (found >= 0) openSong(found, false); else openSetlist(false);
});

// Swipe left/right to move between songs.
let touchX = 0;
$("view-song").addEventListener("touchstart", (e) => { touchX = e.changedTouches[0].clientX; }, { passive: true });
$("view-song").addEventListener("touchend", (e) => {
  const dx = e.changedTouches[0].clientX - touchX;
  if (Math.abs(dx) > 60) (dx < 0 ? $("next") : $("prev")).click();
}, { passive: true });

applyScale();
boot();