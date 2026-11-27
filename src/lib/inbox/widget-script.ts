/**
 * The Customer inbox's chat bubble, as the script a website includes (src/app/api/inbox/public/widget.js):
 * `<script src="https://<workspace>/api/inbox/public/widget.js" data-key="<channel key>" async></script>`.
 *
 * Plain JavaScript, no framework, drawn in a shadow root so the site's styles and the bubble's never
 * meet. It talks only to the workspace it was loaded from (src/app/api/inbox/public/web/[key]), with
 * text/plain bodies so a browser sends them without a preflight (files go as a form to ./upload). The
 * visitor is known by a token the site's own storage keeps; nothing else is stored but whether a
 * proactive message was shown this visit, and no cookie is set.
 *
 * It behaves like a chat with a person (owner, 24 Oct 2026): your message shows the moment you send it;
 * the assistant "types" for a moment before each reply rather than answering instantly; "Rahul is
 * typing…" while somebody on the team writes; "Seen" once they've read it; and each message says who it's
 * from. While the panel is open it asks for news every couple of seconds, and every half minute while
 * closed once there is a conversation, to show a dot.
 *
 * And what a team's chat has (owner, 24 Oct 2026): "Usually replies within…" under the title; the
 * details asked before a chat starts, where the channel asks; a message of its own after a while on a
 * chosen page; photos and documents both ways, where the channel takes files; "How did we do?" once it's
 * closed; and nothing more for a visitor the team blocked.
 *
 * Kept free of backticks and dollar-brace, so it can sit in this String.raw as it is.
 */
export const WIDGET_SCRIPT = String.raw`(function () {
  "use strict";
  var script = document.currentScript;
  if (!script || window.__deskzoChat) return;
  window.__deskzoChat = true;
  var key = script.getAttribute("data-key") || "";
  var base = new URL(script.src).origin;
  var api = base + "/api/inbox/public/web/" + encodeURIComponent(key);
  var storeKey = "deskzo-chat:" + key;
  var saidKey = "deskzo-chat-said:" + key;
  var token = null;
  try { token = window.localStorage.getItem(storeKey); } catch (e) {}
  var config = null, open = false, last = null, seen = {}, timer = null, sending = false, primed = false;
  var queue = [], queued = {}, revealing = false, teamTyping = null, pendingEcho = null;
  /** Lines shown before the conversation existed (the greeting, a proactive message): the server's copies are the same messages. */
  var localBot = [];
  var opener = null, blocked = false, rated = false, chosen = null;
  var FILE_TYPES = "image/jpeg,image/png,image/webp,image/gif,application/pdf,text/plain,.doc,.docx,.xls,.xlsx";

  // Website activity's id for this browser: none until the visitor agrees.
  var visitorId = null;
  var zone = null, lang = null;
  try { zone = Intl.DateTimeFormat().resolvedOptions().timeZone || null; } catch (e) {}
  try { lang = navigator.language || null; } catch (e) {}

  /** Every call says which page they're on, and their browser's time zone and language — for the team's visitor panel. */
  function call(body) {
    body.page = String(location.href).slice(0, 500);
    body.tz = zone;
    body.lang = lang;
    if (visitorId && !body.vid) body.vid = visitorId;
    return fetch(api, { method: "POST", headers: { "Content-Type": "text/plain;charset=UTF-8" }, body: JSON.stringify(body), credentials: "omit" })
      .then(function (r) { return r.json().catch(function () { return { ok: false }; }); });
  }

  // "Typing…" for the team: at most every second or so while the keys move, and "stopped" when the box
  // empties or the message goes. The words themselves only where the channel lets the team peek.
  var typingSentAt = 0, typingActive = false, typingTimer = null;
  function sendTyping(active) {
    if (!token || blocked) return;
    typingActive = active;
    typingSentAt = Date.now();
    var body = { op: "typing", token: token, active: active };
    if (active && config && config.peek) body.text = input.value.slice(0, 500);
    call(body).catch(function () {});
  }
  function onTyping() {
    var active = input.value.trim().length > 0;
    if (!active) { if (typingActive) sendTyping(false); return; }
    var wait = 1200 - (Date.now() - typingSentAt);
    if (wait <= 0) { sendTyping(true); return; }
    if (!typingTimer) typingTimer = setTimeout(function () { typingTimer = null; if (input.value.trim()) sendTyping(true); }, wait);
  }

  var host = document.createElement("div");
  host.setAttribute("data-deskzo-chat", "");
  var root = host.attachShadow ? host.attachShadow({ mode: "open" }) : host;
  var style = document.createElement("style");

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }
  function button(cls, text, label) {
    var b = el("button", cls, text);
    b.type = "button";
    if (label) b.setAttribute("aria-label", label);
    return b;
  }
  function field(label, type, auto, max) {
    var i = el("input", "field");
    i.type = type;
    i.placeholder = label;
    i.setAttribute("aria-label", label);
    i.autocomplete = auto;
    i.maxLength = max;
    return i;
  }

  var bubble = button("bubble", null, "Open chat");
  bubble.innerHTML = '<svg viewBox="0 0 24 24" width="26" height="26" aria-hidden="true"><path fill="currentColor" d="M12 3C6.5 3 2 6.9 2 11.7c0 2.4 1.1 4.6 3 6.2L4.3 21l3.8-1.7c1.2.4 2.5.6 3.9.6 5.5 0 10-3.9 10-8.7S17.5 3 12 3z"/></svg>';
  var dot = el("span", "dot");
  dot.hidden = true;
  bubble.appendChild(dot);

  // A proactive message, beside the bubble until it's opened or dismissed.
  var teaser = el("div", "teaser");
  teaser.hidden = true;
  var teaserText = button("ttext", "");
  var teaserClose = button("tclose", "×", "Dismiss");
  teaser.appendChild(teaserClose);
  teaser.appendChild(teaserText);

  var panel = el("div", "panel");
  panel.setAttribute("role", "dialog");
  panel.hidden = true;
  var head = el("div", "head");
  var titles = el("div", "titles");
  var title = el("span", "title", "Chat");
  var sub = el("span", "sub");
  sub.hidden = true;
  titles.appendChild(title);
  titles.appendChild(sub);
  var close = button("close", "×", "Close chat");
  head.appendChild(titles);
  head.appendChild(close);
  var awayLine = el("div", "awayline");
  awayLine.hidden = true;
  var list = el("div", "list");
  list.setAttribute("aria-live", "polite");
  // "…is typing": the dots, and who, kept at the foot of the conversation while it shows.
  var typingRow = el("div", "msg them typing");
  var typingWho = el("span", "who");
  var typingDots = el("span", "dots");
  typingDots.innerHTML = "<i></i><i></i><i></i>";
  typingRow.appendChild(typingWho);
  typingRow.appendChild(typingDots);
  typingRow.setAttribute("aria-label", "Typing");
  var seenLine = el("div", "seen", "Seen");

  // "How did we do?" once the team has closed it.
  var rate = el("div", "rate");
  rate.hidden = true;
  var rateQ = el("div", "rq", "How did we do?");
  var rateRow = el("div", "rrow");
  var good = button("rbtn", "👍", "Good");
  var bad = button("rbtn", "👎", "Not good");
  rateRow.appendChild(good);
  rateRow.appendChild(bad);
  var rateMore = el("div", "rmore");
  rateMore.hidden = true;
  var rateInput = field("Anything you'd like to add? (optional)", "text", "off", 500);
  var rateSend = button("rsend", "Send");
  rateMore.appendChild(rateInput);
  rateMore.appendChild(rateSend);
  rate.appendChild(rateQ);
  rate.appendChild(rateRow);
  rate.appendChild(rateMore);

  // The details asked before a chat starts, where the channel asks.
  var details = el("div", "details");
  details.hidden = true;
  var detailsIntro = el("div", "dintro", "Before we start, please tell us who you are.");
  var dName = field("Your name", "text", "name", 80);
  var dCompany = field("Company name", "text", "organization", 160);
  var dEmail = field("Email", "email", "email", 200);
  var dPhone = field("Phone", "tel", "tel", 20);
  details.appendChild(detailsIntro);
  details.appendChild(dName);
  details.appendChild(dCompany);
  details.appendChild(dEmail);
  details.appendChild(dPhone);
  var PRECHAT = [
    { key: "name", input: dName, missing: "Please tell us your name." },
    { key: "company", input: dCompany, missing: "Please tell us your company's name." },
    { key: "email", input: dEmail, missing: "Please give an email address we can reply to." },
    { key: "phone", input: dPhone, missing: "Please give a phone number." }
  ];

  var form = el("form", "form");
  var attach = button("attach", null, "Send a photo or file");
  attach.innerHTML = '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" d="M21 11.5l-8.6 8.6a5 5 0 0 1-7.1-7.1l8.6-8.6a3.3 3.3 0 0 1 4.7 4.7l-8.6 8.6a1.7 1.7 0 0 1-2.4-2.4l7.9-7.9"/></svg>';
  attach.hidden = true;
  var picker = el("input");
  picker.type = "file";
  picker.accept = FILE_TYPES;
  picker.hidden = true;
  var input = el("textarea", "input");
  input.rows = 1;
  input.maxLength = 2000;
  input.placeholder = "Type a message";
  input.setAttribute("aria-label", "Your message");
  var send = el("button", "send", "Send");
  send.type = "submit";
  form.appendChild(attach);
  form.appendChild(picker);
  form.appendChild(input);
  form.appendChild(send);
  var foot = el("div", "foot", "Powered by Deskzo");
  panel.appendChild(head);
  panel.appendChild(awayLine);
  panel.appendChild(list);
  panel.appendChild(rate);
  panel.appendChild(details);
  panel.appendChild(form);
  panel.appendChild(foot);
  root.appendChild(style);
  root.appendChild(panel);
  root.appendChild(teaser);
  root.appendChild(bubble);

  function css(colour, left) {
    var side = left ? "left:20px;" : "right:20px;";
    return [
      ":host{all:initial}",
      ".bubble{position:fixed;bottom:20px;" + side + "z-index:2147483646;width:56px;height:56px;border-radius:50%;border:0;background:" + colour + ";color:#fff;box-shadow:0 6px 20px rgba(0,0,0,.25);cursor:pointer;display:flex;align-items:center;justify-content:center}",
      ".bubble:focus-visible,.close:focus-visible,.send:focus-visible,.attach:focus-visible,.rbtn:focus-visible,.rsend:focus-visible,.ttext:focus-visible,.tclose:focus-visible{outline:3px solid #111;outline-offset:2px}",
      ".dot{position:absolute;top:6px;right:6px;width:12px;height:12px;border-radius:50%;background:#e11d48;border:2px solid #fff}",
      ".panel{position:fixed;bottom:88px;" + side + "z-index:2147483647;width:360px;max-width:calc(100vw - 32px);height:520px;max-height:calc(100vh - 120px);background:#fff;color:#111;border-radius:16px;box-shadow:0 12px 40px rgba(0,0,0,.25);display:flex;flex-direction:column;overflow:hidden;font:14px/1.45 system-ui,-apple-system,Segoe UI,Roboto,sans-serif}",
      ".panel[hidden],.dot[hidden],.awayline[hidden],.sub[hidden],.rate[hidden],.rmore[hidden],.details[hidden],.attach[hidden],.teaser[hidden],.field[hidden]{display:none}",
      ".head{background:" + colour + ";color:#fff;padding:12px 16px;display:flex;align-items:center;justify-content:space-between;font-weight:600}",
      ".titles{display:flex;flex-direction:column;min-width:0}",
      ".sub{font-size:12px;font-weight:400;opacity:.9}",
      ".awayline{background:#fef3c7;color:#92400e;font-size:12px;padding:8px 14px}",
      ".close{background:transparent;border:0;color:#fff;font-size:22px;line-height:1;cursor:pointer;padding:0 4px}",
      ".list{flex:1;overflow-y:auto;padding:14px;display:flex;flex-direction:column;gap:8px;background:#f6f7f9}",
      ".msg{max-width:80%;padding:8px 12px;border-radius:14px;white-space:pre-wrap;word-wrap:break-word;animation:pop .18s ease-out}",
      ".msg.you{align-self:flex-end;background:" + colour + ";color:#fff;border-bottom-right-radius:4px}",
      ".msg.you.pending{opacity:.7}",
      ".msg.them{align-self:flex-start;background:#fff;border:1px solid #e5e7eb;border-bottom-left-radius:4px}",
      ".who{display:block;font-size:11px;color:#6b7280;margin-bottom:2px}",
      ".typing .who:empty{display:none}",
      ".pic{display:block;max-width:100%;max-height:220px;border-radius:10px;margin:2px 0 4px}",
      ".doc{color:inherit;text-decoration:underline;cursor:pointer;display:inline-block;margin-bottom:2px}",
      ".dots{display:inline-flex;gap:4px;padding:4px 2px}",
      ".dots i{width:7px;height:7px;border-radius:50%;background:#9ca3af;display:block;animation:blink 1.2s infinite both}",
      ".dots i:nth-child(2){animation-delay:.2s}.dots i:nth-child(3){animation-delay:.4s}",
      ".seen{align-self:flex-end;font-size:11px;color:#9ca3af;margin-top:-4px}",
      ".chips{display:flex;flex-wrap:wrap;gap:6px;align-self:flex-start;max-width:100%}",
      ".chip{border:1px solid " + colour + ";color:" + colour + ";background:#fff;border-radius:999px;padding:5px 12px;font:inherit;font-size:13px;cursor:pointer}",
      ".chip:hover{background:" + colour + ";color:#fff}",
      ".chip:focus-visible{outline:3px solid #111;outline-offset:2px}",
      "@keyframes blink{0%,80%,100%{opacity:.25;transform:translateY(0)}40%{opacity:1;transform:translateY(-2px)}}",
      "@keyframes pop{from{opacity:0;transform:translateY(4px)}to{opacity:1;transform:none}}",
      "@media (prefers-reduced-motion:reduce){.msg,.dots i{animation:none}}",
      ".rate{padding:10px 12px;border-top:1px solid #e5e7eb;background:#fff;text-align:center}",
      ".rq{font-weight:600;margin-bottom:6px}",
      ".rrow{display:flex;gap:10px;justify-content:center}",
      ".rbtn{font-size:22px;line-height:1.2;border:1px solid #e5e7eb;background:#fff;border-radius:10px;padding:4px 16px;cursor:pointer}",
      ".rbtn.on{border-color:" + colour + ";box-shadow:0 0 0 2px " + colour + " inset}",
      ".rmore{display:flex;gap:6px;margin-top:8px}",
      ".rmore .field{flex:1;min-width:0}",
      ".details{padding:10px 12px;border-top:1px solid #e5e7eb;background:#fff;display:flex;flex-direction:column;gap:6px}",
      ".dintro{font-size:12px;color:#4b5563}",
      ".field{border:1px solid #d1d5db;border-radius:8px;padding:7px 10px;font:inherit;color:inherit;background:#fff}",
      ".field:focus{outline:2px solid " + colour + ";outline-offset:0;border-color:transparent}",
      ".form{display:flex;gap:8px;padding:10px;border-top:1px solid #e5e7eb;background:#fff;align-items:flex-end}",
      ".attach{border:0;background:transparent;color:#6b7280;cursor:pointer;padding:6px 2px;display:flex}",
      ".input{flex:1;resize:none;border:1px solid #d1d5db;border-radius:10px;padding:8px 10px;font:inherit;color:inherit;max-height:96px}",
      ".input:focus{outline:2px solid " + colour + ";outline-offset:0;border-color:transparent}",
      ".send,.rsend{border:0;border-radius:10px;padding:0 14px;min-height:36px;background:" + colour + ";color:#fff;font:inherit;font-weight:600;cursor:pointer}",
      ".send:disabled,.input:disabled{opacity:.6;cursor:default}",
      ".foot{font-size:11px;color:#9ca3af;text-align:center;padding:0 0 8px;background:#fff}",
      ".note{font-size:12px;color:#b91c1c;align-self:center;text-align:center}",
      ".teaser{position:fixed;bottom:88px;" + side + "z-index:2147483646;max-width:260px;background:#fff;color:#111;border-radius:14px;box-shadow:0 8px 28px rgba(0,0,0,.2);padding:12px 30px 12px 14px;font:14px/1.45 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;animation:pop .2s ease-out}",
      ".ttext{all:unset;cursor:pointer;display:block;white-space:pre-wrap}",
      ".tclose{position:absolute;top:4px;right:6px;border:0;background:transparent;font-size:18px;line-height:1;cursor:pointer;color:#6b7280;padding:2px 4px}",
      "@media (max-width:480px){.panel{bottom:0;left:0;right:0;width:100%;max-width:100%;height:100%;max-height:100%;border-radius:0}}"
    ].join("");
  }

  /** How long a person takes to type it: a beat to read, a quick typist's pace, never long. */
  function typingMs(text) {
    return Math.round(Math.min(3200, Math.max(900, 500 + String(text || "").length * 22)));
  }

  function scrollDown() { list.scrollTop = list.scrollHeight; }

  /** What the bubble offers depends on whether there's a conversation yet, and whether the visitor may still write. */
  function refreshControls() {
    attach.hidden = !token || blocked || !config || config.files === false;
    details.hidden = !(config && config.prechat && !token) || blocked;
    // Each field as the channel asks for it: required, optional (said so), or not shown.
    var labels = { name: "Your name", company: "Company name", email: "Email", phone: "Phone number" };
    PRECHAT.forEach(function (f) {
      var rule = config && config.prechat && config.prechat.fields ? config.prechat.fields[f.key] : "off";
      f.input.hidden = rule !== "required" && rule !== "optional";
      f.input.placeholder = labels[f.key] + (rule === "optional" ? " (optional)" : "");
      f.input.setAttribute("aria-label", f.input.placeholder);
      f.input.required = rule === "required";
    });
    input.disabled = blocked;
    send.disabled = blocked || sending;
  }

  /** The typing row and "Seen" always sit at the foot, after the messages. */
  function refreshFoot(showTyping, who) {
    if (typingRow.parentNode) list.removeChild(typingRow);
    if (seenLine.parentNode) list.removeChild(seenLine);
    if (showTyping) {
      typingWho.textContent = who ? who + " is typing" : "";
      list.appendChild(typingRow);
    }
    scrollDown();
  }

  function showSeen(on) {
    if (seenLine.parentNode) list.removeChild(seenLine);
    var kids = list.children, lastMsg = null;
    for (var i = kids.length - 1; i >= 0; i -= 1) { if (kids[i] !== typingRow && kids[i].classList.contains("msg")) { lastMsg = kids[i]; break; } }
    // Only under the visitor's own last message, as chat apps show it.
    if (on && lastMsg && lastMsg.classList.contains("you") && !revealing) {
      if (typingRow.parentNode) list.insertBefore(seenLine, typingRow); else list.appendChild(seenLine);
    }
  }

  function place(n) {
    if (typingRow.parentNode) list.insertBefore(n, typingRow); else list.appendChild(n);
    if (seenLine.parentNode) list.removeChild(seenLine);
    scrollDown();
  }

  /** A file in the conversation, fetched with the visitor's token: a photo shown, a document saved when clicked. */
  function fetchFile(id) {
    return fetch(api, { method: "POST", headers: { "Content-Type": "text/plain;charset=UTF-8" }, body: JSON.stringify({ op: "file", token: token, id: id }), credentials: "omit" })
      .then(function (r) { if (!r.ok) throw new Error("file"); return r.blob(); });
  }
  function fileNode(m) {
    var wrap = el("div", "file");
    if (m.file.image) {
      var img = el("img", "pic");
      img.alt = m.file.name || "Photo";
      wrap.appendChild(img);
      fetchFile(m.id).then(function (b) { img.onload = scrollDown; img.src = URL.createObjectURL(b); }).catch(function () { wrap.textContent = "The photo couldn't be shown."; });
    } else {
      var a = el("a", "doc", "📄 " + (m.file.name || "Document"));
      a.href = "#";
      a.addEventListener("click", function (e) {
        e.preventDefault();
        fetchFile(m.id).then(function (b) {
          // Saved, never opened as a page of this site.
          var url = URL.createObjectURL(new Blob([b], { type: "application/octet-stream" }));
          var d = document.createElement("a");
          d.href = url;
          d.download = m.file.name || "file";
          d.rel = "noopener";
          document.body.appendChild(d);
          d.click();
          document.body.removeChild(d);
          setTimeout(function () { URL.revokeObjectURL(url); }, 10000);
        }).catch(function () { note("That file couldn't be downloaded."); });
      });
      wrap.appendChild(a);
    }
    return wrap;
  }
  /** "[Photo] the caption" → "the caption": the file says the rest. */
  function captionOf(body) { return String(body || "").replace(/^\[(Photo|Document[^\]]*)\]\s?/, ""); }

  function add(m) {
    if (m.id && seen[m.id]) return;
    var you = m.from === "you";
    var mine = !you && m.id ? localBot.indexOf(m.body) : -1;
    if (mine >= 0) {
      seen[m.id] = true;
      localBot.splice(mine, 1);
      if (m.at && (!last || m.at > last)) last = m.at;
      return;
    }
    // The visitor's own message is already on screen from when they sent it: it takes the server's id.
    if (you && !m.file && pendingEcho && pendingEcho.text === m.body) {
      pendingEcho.node.classList.remove("pending");
      if (m.id) seen[m.id] = true;
      if (m.at && (!last || m.at > last)) last = m.at;
      pendingEcho = null;
      return;
    }
    if (m.id) seen[m.id] = true;
    var n = el("div", "msg " + (you ? "you" : "them"));
    if (!you && m.name) n.appendChild(el("span", "who", m.name));
    if (m.file && m.id) {
      n.appendChild(fileNode(m));
      var cap = captionOf(m.body);
      if (cap) n.appendChild(document.createTextNode(cap));
    } else {
      n.appendChild(document.createTextNode(m.body));
    }
    place(n);
    if (m.at && (!last || m.at > last)) last = m.at;
    // The first fetch after loading only catches up: what was there before is not news.
    if (!you && !open && primed) dot.hidden = false;
  }

  /** The assistant's replies appear one by one, each after it has "typed" it; the team's, as they come. */
  function next() {
    if (!queue.length) {
      revealing = false;
      refreshFoot(!!teamTyping, teamTyping);
      return;
    }
    revealing = true;
    var m = queue.shift();
    if (m.from !== "bot" || !open) { add(m); next(); return; }
    refreshFoot(true, m.name || "");
    setTimeout(function () { add(m); next(); }, typingMs(m.body));
  }

  function reveal(messages, paceAfterYou) {
    var lastYou = -1;
    if (paceAfterYou) for (var i = 0; i < messages.length; i += 1) if (messages[i].from === "you") lastYou = i;
    for (var j = 0; j < messages.length; j += 1) {
      var m = messages[j];
      // Waiting its turn already: the poll that comes meanwhile brings it again.
      if (m.id && (seen[m.id] || queued[m.id])) continue;
      if (j <= lastYou || !paceAfterYou && m.from !== "bot" || localBot.indexOf(m.body) >= 0) { add(m); continue; }
      if (m.id) queued[m.id] = true;
      queue.push(m);
    }
    if (!revealing) next();
  }

  function note(text) {
    var n = el("div", "note", text);
    list.appendChild(n);
    scrollDown();
  }

  function forget() {
    token = null;
    try { window.localStorage.removeItem(storeKey); } catch (e) {}
  }

  /** The team blocked this visitor: nothing more goes either way. */
  function goBlocked() {
    if (blocked) return;
    blocked = true;
    forget();
    rate.hidden = true;
    note("This chat isn't available.");
    refreshControls();
    schedule();
  }

  function showRate(on) {
    if (rated || blocked) on = false;
    if (on && rate.hidden) {
      chosen = null;
      good.classList.remove("on");
      bad.classList.remove("on");
      rateMore.hidden = true;
      rateInput.value = "";
    }
    rate.hidden = !on;
  }

  function poll() {
    if (!token || blocked) return;
    call({ op: "poll", token: token, after: last }).then(function (r) {
      if (r && r.blocked) { goBlocked(); return; }
      if (r && r.ok && r.messages) {
        if (!primed) r.messages.forEach(add); else reveal(r.messages, false);
        teamTyping = r.typing || null;
        if (!revealing) refreshFoot(!!teamTyping, teamTyping);
        showSeen(!!r.seen);
        showRate(!!r.rate);
      }
      primed = true;
      if (r && r.forget) { forget(); refreshControls(); }
    }).catch(function () {});
  }

  function schedule() {
    if (timer) clearInterval(timer);
    timer = token && !blocked ? setInterval(poll, open ? 2500 : 30000) : null;
  }

  /**
   * The channel's suggested questions (owner, 31 Oct 2026), under the welcome until the visitor writes: a tap sends
   * it as their message, so nobody faces an empty box.
   */
  function showChips() {
    var items = (config && config.suggestions) || [];
    if (!items.length || token || blocked || list.querySelector(".chips")) return;
    var row = el("div", "chips");
    row.setAttribute("role", "group");
    row.setAttribute("aria-label", "Suggested questions");
    items.forEach(function (text) {
      var b = el("button", "chip", text);
      b.type = "button";
      b.addEventListener("click", function () {
        if (sending || blocked) return;
        input.value = text;
        if (form.requestSubmit) form.requestSubmit(); else form.dispatchEvent(new Event("submit", { cancelable: true }));
      });
      row.appendChild(b);
    });
    place(row);
  }
  function hideChips() {
    var row = list.querySelector(".chips");
    if (row && row.parentNode) row.parentNode.removeChild(row);
  }

  function show(on) {
    open = on;
    panel.hidden = !on;
    bubble.setAttribute("aria-label", on ? "Close chat" : "Open chat");
    if (on) {
      dot.hidden = true;
      teaser.hidden = true;
      if (!token && !blocked && !list.querySelector(".msg") && config) {
        if (config.greeting) {
          add({ from: "bot", body: config.greeting, name: config.assistant || null });
          localBot.push(config.greeting);
        }
        if (opener) {
          add({ from: "bot", body: opener, name: config.assistant || null });
          localBot.push(opener);
        }
        showChips();
      }
      refreshControls();
      poll();
      setTimeout(function () {
        // The form's first empty field, or the message box.
        var empty = details.hidden ? null : PRECHAT.filter(function (f) { return !f.input.hidden && !f.input.value; })[0];
        (empty ? empty.input : input).focus();
      }, 50);
    }
    schedule();
  }

  /** The channel's message for this page, if it has one: "*" every page, "/" the home page, "/pricing" it and the pages under it. */
  function proactiveRule() {
    var rules = (config && config.proactive) || [], path = location.pathname;
    for (var i = 0; i < rules.length; i += 1) {
      var p = rules[i].path, b = String(p).replace(/\/+$/, "");
      if (p === "*" || (b === "" ? path === "/" : path === p || path === b || path.indexOf(b + "/") === 0)) return rules[i];
    }
    return null;
  }
  /** Said once a visit, after a while on the page, to somebody who hasn't started a chat. */
  function armProactive() {
    if (token) return;
    var rule = proactiveRule();
    if (!rule) return;
    try { if (window.sessionStorage.getItem(saidKey)) return; } catch (e) {}
    setTimeout(function () {
      if (token || open || opener || blocked) return;
      try { window.sessionStorage.setItem(saidKey, "1"); } catch (e) {}
      opener = rule.message;
      teaserText.textContent = rule.message;
      teaser.hidden = false;
      dot.hidden = false;
    }, Math.max(3, Number(rule.delay) || 30) * 1000);
  }

  bubble.addEventListener("click", function () { show(!open); });
  close.addEventListener("click", function () { show(false); bubble.focus(); });
  teaserText.addEventListener("click", function () { show(true); });
  teaserClose.addEventListener("click", function () { teaser.hidden = true; dot.hidden = true; opener = null; });
  panel.addEventListener("keydown", function (e) { if (e.key === "Escape") { show(false); bubble.focus(); } });
  input.addEventListener("keydown", function (e) {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); form.requestSubmit ? form.requestSubmit() : form.dispatchEvent(new Event("submit")); }
  });
  input.addEventListener("input", onTyping);

  function pick(which) {
    chosen = which;
    good.classList.toggle("on", which === "GOOD");
    bad.classList.toggle("on", which === "BAD");
    rateMore.hidden = false;
    rateInput.focus();
  }
  good.addEventListener("click", function () { pick("GOOD"); });
  bad.addEventListener("click", function () { pick("BAD"); });
  function sendRating() {
    if (!chosen || !token) return;
    rateSend.disabled = true;
    call({ op: "rate", token: token, rating: chosen, comment: rateInput.value.trim() || null }).then(function () {
      rated = true;
      rate.hidden = true;
      note("Thank you for telling us.");
    }).catch(function () { rateSend.disabled = false; });
  }
  rateSend.addEventListener("click", sendRating);
  rateInput.addEventListener("keydown", function (e) { if (e.key === "Enter") { e.preventDefault(); sendRating(); } });

  attach.addEventListener("click", function () { picker.click(); });
  picker.addEventListener("change", function () {
    var f = picker.files && picker.files[0];
    picker.value = "";
    if (!f || !token || blocked || (config && config.files === false)) return;
    if (f.size > 5 * 1024 * 1024) { note("Files can be up to 5 MB."); return; }
    var pending = el("div", "msg you pending", "Sending " + f.name + "…");
    place(pending);
    var fd = new FormData();
    fd.append("token", token);
    fd.append("file", f, f.name);
    fetch(api + "/upload", { method: "POST", body: fd, credentials: "omit" })
      .then(function (r) { return r.json().catch(function () { return { ok: false }; }); })
      .then(function (r) {
        if (pending.parentNode) pending.parentNode.removeChild(pending);
        if (r && r.ok) { if (r.messages) reveal(r.messages, true); return; }
        if (r && r.blocked) { goBlocked(); return; }
        note((r && r.error) || "That file didn't send. Please try again.");
      })
      .catch(function () {
        if (pending.parentNode) pending.parentNode.removeChild(pending);
        note("That file didn't send. Please try again.");
      });
  });

  form.addEventListener("submit", function (e) {
    e.preventDefault();
    var text = input.value.trim();
    if (!text || sending || blocked) return;
    var body = { op: "send", token: token, text: text, page: String(location.href).slice(0, 500) };
    if (!token) {
      if (opener) body.opener = opener;
      if (config && config.prechat) {
        // The server checks them properly; this only catches a required field left empty.
        for (var i = 0; i < PRECHAT.length; i += 1) {
          var f = PRECHAT[i], value = f.input.value.trim();
          if (f.input.hidden) continue;
          if (f.input.required && !value) { note(f.missing); f.input.focus(); return; }
          if (value) body[f.key] = value;
        }
      }
    }
    sending = true;
    send.disabled = true;
    input.value = "";
    hideChips();
    if (typingTimer) { clearTimeout(typingTimer); typingTimer = null; }
    typingActive = false;
    // On screen at once, as in any chat app; it settles when the server has it.
    var echo = el("div", "msg you pending", text);
    place(echo);
    pendingEcho = { text: text, node: echo };
    call(body).then(function (r) {
      if (r && r.ok) {
        // A new conversation: the server has it from the start, greeting and all.
        if (r.token && r.token !== token) {
          token = r.token;
          seen = {};
          queued = {};
          last = null;
          opener = null;
          try { window.localStorage.setItem(storeKey, token); } catch (e2) {}
        }
        if (r.messages) reveal(r.messages, true);
        refreshControls();
        schedule();
      } else {
        if (echo.parentNode) echo.parentNode.removeChild(echo);
        pendingEcho = null;
        if (r && r.blocked) { goBlocked(); return; }
        input.value = text;
        note((r && r.error) || "That didn't send. Please try again.");
      }
    }).catch(function () {
      if (echo.parentNode) echo.parentNode.removeChild(echo);
      pendingEcho = null;
      input.value = text;
      note("That didn't send. Please try again.");
    }).then(function () { sending = false; refreshControls(); });
  });

  /**
   * Website activity (owner, 6 Nov 2026; src/lib/inbox/activity.ts), where the channel has it on. Nothing is kept or
   * sent until the visitor agrees: the bubble's small notice, or the site's own cookie banner calling
   * DeskzoChat.consent(true). "No" is remembered and the id forgotten. A website's own form can send
   * DeskzoChat.visitorId() as visitor_id; an input named visitor_id is filled in.
   */
  var visitKey = "deskzo-visit:" + key, agreedKey = "deskzo-visit-ok:" + key;
  var pinging = null, activity = null, reporting = false, onPage = null, onPageSince = 0, fromEmail = null, noticeBar = null;
  function stored(k) { try { return window.localStorage.getItem(k); } catch (e) { return null; } }
  function keep(k, v) { try { if (v === null) window.localStorage.removeItem(k); else window.localStorage.setItem(k, v); } catch (e) {} }

  // The campaign email's mark, off the address either way: it isn't the site's to show or keep.
  try {
    var here = new URL(location.href);
    fromEmail = here.searchParams.get("dz_m");
    if (fromEmail) {
      here.searchParams.delete("dz_m");
      history.replaceState(history.state, "", here.toString());
    }
  } catch (e) {}

  function newVisitorId() {
    var bytes = new Uint8Array(18), out = "";
    window.crypto.getRandomValues(bytes);
    for (var i = 0; i < bytes.length; i += 1) out += ("0" + bytes[i].toString(16)).slice(-2);
    return out;
  }
  function reportLeave(beacon) {
    if (!onPage || !visitorId) return;
    var sec = Math.round((Date.now() - onPageSince) / 1000);
    var body = { op: "leave", vid: visitorId, page: onPage, sec: sec };
    if (beacon && navigator.sendBeacon) { navigator.sendBeacon(api, new Blob([JSON.stringify(body)], { type: "text/plain;charset=UTF-8" })); return; }
    fetch(api, { method: "POST", headers: { "Content-Type": "text/plain;charset=UTF-8" }, body: JSON.stringify(body), credentials: "omit", keepalive: true }).catch(function () {});
  }
  function reportPage() {
    var href = String(location.href).split("#")[0].slice(0, 500);
    if (!visitorId || href === onPage) return;
    reportLeave(false);
    var first = onPage === null;
    onPage = href;
    onPageSince = Date.now();
    var net = navigator.connection ? navigator.connection.type || null : null;
    // A moment's wait: a single-page site sets its title just after the address.
    setTimeout(function () {
      call({ op: "view", title: String(document.title || "").slice(0, 200), ref: first ? document.referrer : "", m: fromEmail, scr: window.screen ? window.screen.width + "x" + window.screen.height : null, touch: navigator.maxTouchPoints || 0, net: net }).catch(function () {});
      fromEmail = null;
    }, first ? 0 : 300);
  }
  function fillForms() {
    var inputs = document.querySelectorAll('input[name="visitor_id"]');
    for (var i = 0; i < inputs.length; i += 1) inputs[i].value = visitorId || "";
  }
  function startReporting() {
    if (reporting || !activity) return;
    reporting = true;
    visitorId = stored(visitKey) || newVisitorId();
    keep(visitKey, visitorId);
    fillForms();
    reportPage();
    // A site that changes page without loading one.
    ["pushState", "replaceState"].forEach(function (name) {
      var original = history[name];
      history[name] = function () {
        var result = original.apply(this, arguments);
        reportPage();
        return result;
      };
    });
    window.addEventListener("popstate", reportPage);
    window.addEventListener("pagehide", function () { reportLeave(true); });
    // Still here, while the tab is showing: what makes "on the site now" true, and how a chat somebody starts arrives.
    pinging = setInterval(ping, 20000);
  }
  function ping() {
    if (!visitorId || document.visibilityState !== "visible") return;
    call({ op: "ping" }).then(function (r) { if (r && r.invite) takeInvite(r.invite); }).catch(function () {});
  }
  /** Somebody on the team has started a chat: beside the bubble, for them to open or dismiss — never opened on them. */
  function takeInvite(invite) {
    if (blocked) return;
    if (invite.token && invite.token !== token) {
      token = invite.token;
      seen = {};
      queued = {};
      last = null;
      primed = true;
      opener = null;
      keep(storeKey, token);
    }
    if (!open && invite.text) {
      teaserText.textContent = invite.text;
      teaser.hidden = false;
      dot.hidden = false;
    }
    poll();
    schedule();
    refreshControls();
  }
  function agree(yes) {
    keep(agreedKey, yes ? "yes" : "no");
    if (noticeBar && noticeBar.parentNode) noticeBar.parentNode.removeChild(noticeBar);
    if (yes) { startReporting(); return; }
    // Changing their mind takes back what was kept, not only what's to come.
    if (visitorId) call({ op: "forget", vid: visitorId }).catch(function () {});
    if (pinging) { clearInterval(pinging); pinging = null; }
    reporting = false;
    visitorId = null;
    onPage = null;
    keep(visitKey, null);
    fillForms();
  }
  window.DeskzoChat = {
    consent: function (yes) { agree(yes === true); },
    visitorId: function () { return visitorId; },
  };
  function showNotice(text) {
    noticeBar = el("div");
    noticeBar.style.cssText = "position:fixed;" + (config.position === "left" ? "right" : "left") + ":16px;bottom:16px;z-index:2147483000;max-width:340px;background:#fff;color:#1f2533;border:1px solid #d9dee8;border-radius:12px;box-shadow:0 6px 24px rgba(0,0,0,.15);padding:12px 14px;font:13px/1.45 system-ui,sans-serif";
    noticeBar.setAttribute("role", "region");
    noticeBar.setAttribute("aria-label", "Your privacy");
    var line = el("div", null, text);
    var actions = el("div");
    actions.style.cssText = "display:flex;gap:8px;margin-top:10px";
    var yes = button(null, "That's fine");
    yes.style.cssText = "background:" + (config.colour || "#0249FE") + ";color:#fff;border:0;border-radius:8px;padding:6px 12px;font:600 13px system-ui,sans-serif;cursor:pointer";
    var no = button(null, "No thanks");
    no.style.cssText = "background:none;color:#1f2533;border:1px solid #d9dee8;border-radius:8px;padding:6px 12px;font:13px system-ui,sans-serif;cursor:pointer";
    yes.addEventListener("click", function () { agree(true); });
    no.addEventListener("click", function () { agree(false); });
    actions.appendChild(yes);
    actions.appendChild(no);
    noticeBar.appendChild(line);
    noticeBar.appendChild(actions);
    root.appendChild(noticeBar);
  }

  call({ op: "config" }).then(function (r) {
    if (!r || !r.ok) return;
    config = r;
    activity = r.activity || null;
    if (activity) {
      var answered = stored(agreedKey);
      if (answered === "yes") startReporting();
      else if (answered !== "no" && activity.consent === "notice") showNotice(activity.notice);
    }
    style.textContent = css(r.colour || "#0249FE", r.position === "left");
    title.textContent = r.title || "Chat";
    panel.setAttribute("aria-label", r.title || "Chat");
    if (r.away) { awayLine.textContent = r.away; awayLine.hidden = false; }
    if (r.replyIn) { sub.textContent = r.replyIn; sub.hidden = false; }
    refreshControls();
    (document.body || document.documentElement).appendChild(host);
    // Back on the site with a conversation: the team sees they're here, and on which page.
    if (token) { call({ op: "seen", token: token }).catch(function () {}); poll(); schedule(); }
    else armProactive();
  }).catch(function () {});
})();
`;
