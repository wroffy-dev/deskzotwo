/**
 * A booking page over any website (owner, 18 Nov 2026 — Dreamteam's "Schedule a demo"): one script tag, and a button,
 * link or form marked `data-deskzo-book` opens the page in a pop-up over the site, the email already typed there filled
 * in. Served at /api/booking/public/book.js, the same for every workspace and page — the tag says which — so it reads
 * nothing and is cached a while. The page itself answers framed (src/proxy.ts lets /book/ be framed, as /forms/).
 *
 *   <script src="https://<workspace>/api/booking/public/book.js" data-page="demo" async></script>
 *   <button data-deskzo-book>Book a demo</button>
 *   <form data-deskzo-book><input name="email"><button>Schedule a demo</button></form>
 *   DeskzoBooking.open({ email: "a@b.com", name: "Asha", page: "demo" })
 *
 * `data-links` on the tag: a CSS selector for links the site already has that should open it too —
 * deskzo.com's "/contact?topic=demo".
 */

export function bookingEmbedSnippet(origin: string, slug: string): string {
  return `<script src="${origin}/api/booking/public/book.js" data-page="${slug}" async></script>\n<button data-deskzo-book>Book a meeting</button>`;
}

export const BOOKING_SCRIPT = `(function () {
  var tag = document.currentScript;
  if (!tag || window.DeskzoBooking) return;
  var base;
  try { base = new URL(tag.src).origin; } catch (e) { return; }
  var page = tag.getAttribute("data-page") || "";
  var links = tag.getAttribute("data-links") || "";
  var slug = /^[a-z0-9][a-z0-9-]{2,40}$/;
  var shade = null;

  var box = null;
  function close() {
    if (shade && shade.parentNode) shade.parentNode.removeChild(shade);
    shade = null;
    box = null;
    document.removeEventListener("keydown", onKey);
  }
  // The page says how tall it is; the pop-up is that tall, up to the screen's height.
  window.addEventListener("message", function (e) {
    if (e.origin !== base || !box || !e.data || e.data.type !== "deskzo-booking-size") return;
    var h = Number(e.data.height);
    if (h > 0) box.style.height = Math.min(h, window.innerHeight - 32) + "px";
  });
  function onKey(e) { if (e.key === "Escape") close(); }

  function open(opts) {
    opts = opts || {};
    var which = opts.page || page;
    if (!slug.test(which)) return;
    close();
    var q = "?embed=1";
    if (opts.email) q += "&email=" + encodeURIComponent(String(opts.email).slice(0, 254));
    if (opts.name) q += "&name=" + encodeURIComponent(String(opts.name).slice(0, 120));
    shade = document.createElement("div");
    shade.setAttribute("role", "dialog");
    shade.setAttribute("aria-modal", "true");
    shade.setAttribute("aria-label", "Book a meeting");
    shade.style.cssText = "position:fixed;inset:0;z-index:2147483646;background:rgba(15,23,42,.55);display:flex;align-items:center;justify-content:center;padding:16px";
    box = document.createElement("div");
    box.style.cssText = "position:relative;width:760px;max-width:100%;height:min(640px, calc(100vh - 32px));transition:height .15s ease;background:#fff;border-radius:16px;box-shadow:0 24px 60px rgba(0,0,0,.35);overflow:hidden";
    var x = document.createElement("button");
    x.type = "button";
    x.setAttribute("aria-label", "Close");
    x.textContent = "\\u00d7";
    x.style.cssText = "position:absolute;top:10px;right:12px;z-index:1;border:0;background:#fff;border-radius:50%;width:32px;height:32px;font-size:22px;line-height:1;cursor:pointer;color:#475569";
    var frame = document.createElement("iframe");
    frame.src = base + "/book/" + which + q;
    frame.title = "Book a meeting";
    frame.style.cssText = "border:0;width:100%;height:100%";
    box.appendChild(x);
    box.appendChild(frame);
    shade.appendChild(box);
    document.body.appendChild(shade);
    x.addEventListener("click", close);
    shade.addEventListener("click", function (e) { if (e.target === shade) close(); });
    document.addEventListener("keydown", onKey);
    frame.focus();
  }

  function marked(el) {
    if (!el || !el.closest) return null;
    var m = el.closest("[data-deskzo-book]");
    if (m) return m;
    var a = el.closest("a[href]");
    if (a && /#book$/.test(a.getAttribute("href") || "")) return a;
    if (links) { try { var l = el.closest(links); if (l) return l; } catch (e) {} }
    return null;
  }

  document.addEventListener("click", function (e) {
    var m = marked(e.target);
    if (!m || m.tagName === "FORM" || (m.closest && m.closest("form[data-deskzo-book]"))) return;
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey) return;
    e.preventDefault();
    open({ page: m.getAttribute("data-deskzo-book") || undefined });
  }, true);

  document.addEventListener("submit", function (e) {
    var f = e.target;
    if (!f || !f.matches || !f.matches("form[data-deskzo-book]")) return;
    e.preventDefault();
    var email = f.querySelector("input[name=email], input[type=email]");
    var name = f.querySelector("input[name=name]");
    open({ page: f.getAttribute("data-deskzo-book") || undefined, email: email && email.value, name: name && name.value });
  }, true);

  window.DeskzoBooking = { open: open, close: close };
})();
`;
