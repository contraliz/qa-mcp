import { HELPERS } from "./inpage.js";

/** Injected into an annotation session: draw boxes, attach notes, send. */
export const ANNOTATION_SCRIPT = String.raw`(() => {
  ${HELPERS}
  if (window.__qaAnnotation && window.__qaAnnotation.status) return "already-active";

  var state = { status: "drawing", marks: [] };
  window.__qaAnnotation = state;

  var layer = document.createElement("div");
  layer.id = "__qa_layer";
  layer.style.cssText = "position:fixed;inset:0;z-index:2147483647;cursor:crosshair;background:rgba(0,0,0,0.02)";
  document.documentElement.appendChild(layer);

  var panel = document.createElement("div");
  panel.id = "__qa_panel";
  panel.style.cssText = "position:fixed;right:12px;bottom:12px;z-index:2147483647;font:13px/1.45 system-ui,sans-serif;background:#111;color:#eee;padding:12px 14px;border-radius:10px;width:320px;box-shadow:0 6px 24px rgba(0,0,0,.45)";
  document.documentElement.appendChild(panel);

  var title = document.createElement("div");
  title.innerHTML = "<b>QA annotate</b>";
  panel.appendChild(title);

  var hint = document.createElement("div");
  hint.style.cssText = "opacity:.65;margin:4px 0 8px";
  hint.textContent = "Drag a box around the problem, type what is wrong, press Add.";
  panel.appendChild(hint);

  var list = document.createElement("div");
  panel.appendChild(list);

  var editor = document.createElement("div");
  editor.style.cssText = "display:none;gap:6px;margin-top:8px";
  var input = document.createElement("input");
  input.id = "__qa_note";
  input.placeholder = "What is wrong here?";
  input.style.cssText = "flex:1;min-width:0;background:#1c1c1c;border:1px solid #333;color:#eee;border-radius:6px;padding:6px 8px;font:inherit";
  var add = document.createElement("button");
  add.id = "__qa_add";
  add.textContent = "Add";
  add.style.cssText = "background:#3b82f6;color:#fff;border:0;padding:6px 10px;border-radius:6px;cursor:pointer;font:inherit";
  editor.appendChild(input);
  editor.appendChild(add);
  panel.appendChild(editor);

  var actions = document.createElement("div");
  actions.style.cssText = "display:flex;gap:8px;margin-top:10px";
  var send = document.createElement("button");
  send.id = "__qa_send";
  send.textContent = "Send";
  send.style.cssText = "background:#22c55e;color:#062;border:0;padding:6px 12px;border-radius:6px;cursor:pointer;font:inherit;font-weight:600";
  var clear = document.createElement("button");
  clear.textContent = "Clear";
  clear.style.cssText = "background:#222;color:#bbb;border:1px solid #333;padding:6px 10px;border-radius:6px;cursor:pointer;font:inherit";
  actions.appendChild(send);
  actions.appendChild(clear);
  panel.appendChild(actions);

  var pending = null;
  var draft = null;
  var start = null;

  function boxFor(rect) {
    var el = document.createElement("div");
    el.style.cssText = "position:fixed;border:2px solid #3b82f6;background:rgba(59,130,246,.15);pointer-events:none;z-index:2147483646;left:" + rect.x + "px;top:" + rect.y + "px;width:" + rect.w + "px;height:" + rect.h + "px";
    return el;
  }

  function render() {
    list.innerHTML = "";
    state.marks.forEach(function (m, i) {
      var row = document.createElement("div");
      row.style.cssText = "display:flex;gap:6px;align-items:flex-start;margin:4px 0";
      var badge = document.createElement("span");
      badge.textContent = String(i + 1);
      badge.style.cssText = "background:#3b82f6;border-radius:50%;width:18px;height:18px;text-align:center;line-height:18px;font-size:11px;flex:0 0 18px";
      var text = document.createElement("span");
      text.textContent = m.note;
      row.appendChild(badge);
      row.appendChild(text);
      list.appendChild(row);
    });
    send.textContent = state.marks.length ? "Send " + state.marks.length : "Send";
    send.disabled = state.marks.length === 0;
    send.style.opacity = state.marks.length ? "1" : ".45";
  }

  editor.style.display = "flex";
  input.focus();

  layer.addEventListener("mousedown", function (e) {
    if (e.target === panel || panel.contains(e.target)) return;
    start = { x: e.clientX, y: e.clientY };
    draft = boxFor({ x: start.x, y: start.y, w: 0, h: 0 });
    document.documentElement.appendChild(draft);
  });

  layer.addEventListener("mousemove", function (e) {
    if (!start || !draft) return;
    var x = Math.min(start.x, e.clientX), y = Math.min(start.y, e.clientY);
    draft.style.left = x + "px";
    draft.style.top = y + "px";
    draft.style.width = Math.abs(e.clientX - start.x) + "px";
    draft.style.height = Math.abs(e.clientY - start.y) + "px";
  });

  layer.addEventListener("mouseup", function (e) {
    if (!start || !draft) return;
    var rect = {
      x: Math.round(Math.min(start.x, e.clientX)),
      y: Math.round(Math.min(start.y, e.clientY)),
      w: Math.round(Math.abs(e.clientX - start.x)),
      h: Math.round(Math.abs(e.clientY - start.y))
    };
    draft.remove();
    draft = null;
    start = null;
    if (rect.w < 4 || rect.h < 4) return;
    pending = rect;
    var ghost = boxFor(rect);
    ghost.dataset.qa = "pending";
    document.documentElement.appendChild(ghost);
    input.value = "";
    input.focus();
  });

  function commit() {
    if (!pending) return;
    var note = input.value.trim();
    if (!note) { input.focus(); return; }
    var cx = pending.x + pending.w / 2, cy = pending.y + pending.h / 2;
    var stack = document.elementsFromPoint(cx, cy).filter(function (el) {
      return el.id !== "__qa_layer" && el.dataset.qa !== "pending" && !panel.contains(el) && el !== panel;
    });
    var el = stack[0] || document.body;
    state.marks.push({
      n: state.marks.length + 1,
      shape: "box",
      rect: pending,
      note: note,
      element: {
        selector: qaSelector(el),
        tag: el.tagName.toLowerCase(),
        role: el.getAttribute("role") || null,
        name: (el.getAttribute("aria-label") || qaText(el) || "").slice(0, 120),
        box: qaBox(el),
        resolution: "exact"
      }
    });
    var ghosts = document.querySelectorAll('[data-qa="pending"]');
    for (var i = 0; i < ghosts.length; i++) ghosts[i].remove();
    pending = null;
    input.value = "";
    render();
  }

  add.addEventListener("click", commit);
  input.addEventListener("keydown", function (e) {
    if (e.key === "Enter") { e.preventDefault(); commit(); }
  });

  send.addEventListener("click", function () {
    if (!state.marks.length) return;
    state.status = "sent";
    send.textContent = "Sent";
    send.disabled = true;
    hint.textContent = "Sent. You can close this window or keep marking.";
  });

  clear.addEventListener("click", function () {
    state.marks = [];
    var ghosts = document.querySelectorAll('[data-qa="pending"]');
    for (var i = 0; i < ghosts.length; i++) ghosts[i].remove();
    pending = null;
    render();
  });

  document.addEventListener("keydown", function (e) {
    if (e.key !== "Escape") return;
    if (draft) { draft.remove(); draft = null; start = null; }
    var ghosts = document.querySelectorAll('[data-qa="pending"]');
    for (var i = 0; i < ghosts.length; i++) ghosts[i].remove();
    pending = null;
  });

  render();
  return "active";
})()`;
