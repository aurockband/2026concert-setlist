/* Service worker: precache the whole concert, then serve it from the cache.
 *
 * tools/build.py fills in ff9152eef6 (cache name) and ["app.js", "data.enc", "icons/cue-cheer.svg", "icons/cue-clap.svg", "icons/cue-jump.svg", "icons/cue-singalong.svg", "icons/icon-192.png", "icons/icon-512.png", "index.html", "manifest.webmanifest", "poster.jpg", "style.css", "theme.css"] (the file
 * list) before copying this file into dist/. A new concert deploy changes the
 * build hash, so the new worker installs, and the old cache is deleted when it
 * activates - which happens on the next page load, without interrupting the
 * current one.
 */

const CACHE = "setlist-ff9152eef6";
const DEV = false;                  // true in `--dev` builds: the local server wins
const ASSETS = ["app.js", "data.enc", "icons/cue-cheer.svg", "icons/cue-clap.svg", "icons/cue-jump.svg", "icons/cue-singalong.svg", "icons/icon-192.png", "icons/icon-512.png", "index.html", "manifest.webmanifest", "poster.jpg", "style.css", "theme.css"];

const url = (path) => new URL(path, self.location);

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(ASSETS)));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(caches.keys().then((names) => Promise.all(
    names.filter((name) => name !== CACHE).map((name) => caches.delete(name)),
  )));
});

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;
  event.respondWith((async () => {
    // While iterating on a concert, always ask the server first so edits show
    // up on reload; the cache is only there for when the server is gone.
    if (DEV) {
      try {
        return await fetch(event.request);
      } catch (err) {
        const fresh = await caches.match(event.request);
        if (fresh) return fresh;
        if (event.request.mode === "navigate") {
          const shell = await caches.match(url("index.html"));
          if (shell) return shell;
        }
        throw err;
      }
    }
    const hit = await caches.match(event.request);
    if (hit) return hit;
    try {
      return await fetch(event.request);
    } catch (err) {
      // Offline and not in the cache: any page load still opens the app.
      if (event.request.mode === "navigate") {
        const shell = await caches.match(url("index.html"));
        if (shell) return shell;
      }
      throw err;
    }
  })());
});