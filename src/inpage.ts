/**
 * In-page scripts. These run inside the app under test and only collect facts.
 * No thresholds are "judged"; every rule returns its definition so the caller
 * can audit what was measured.
 */

export const HELPERS = String.raw`
  function qaSelector(el) {
    if (!el || el.nodeType !== 1) return null;
    if (el.id) return "#" + CSS.escape(el.id);
    var parts = [];
    var node = el;
    var depth = 0;
    while (node && node.nodeType === 1 && depth < 6) {
      var part = node.tagName.toLowerCase();
      var parent = node.parentElement;
      if (parent) {
        var same = Array.prototype.filter.call(parent.children, function (c) {
          return c.tagName === node.tagName;
        });
        if (same.length > 1) part += ":nth-of-type(" + (same.indexOf(node) + 1) + ")";
      }
      parts.unshift(part);
      if (node.id) { parts[0] = "#" + CSS.escape(node.id); break; }
      node = parent;
      depth += 1;
    }
    return parts.join(" > ");
  }
  function qaBox(el) {
    var r = el.getBoundingClientRect();
    return {
      x: Math.round(r.x), y: Math.round(r.y),
      w: Math.round(r.width), h: Math.round(r.height)
    };
  }
  function qaText(el) {
    var t = "";
    if (el.innerText) t = el.innerText;
    else if (el.value) t = String(el.value);
    else t = el.getAttribute("aria-label") || el.getAttribute("alt") || "";
    return t.replace(/\s+/g, " ").trim().slice(0, 80);
  }
  function qaVisible(el) {
    var r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return false;
    var s = getComputedStyle(el);
    return s.visibility !== "hidden" && s.display !== "none" && Number(s.opacity) > 0;
  }
  function qaItem(el, detail) {
    var item = { selector: qaSelector(el), tag: el.tagName.toLowerCase(), box: qaBox(el), text: qaText(el) };
    if (detail) for (var k in detail) item[k] = detail[k];
    return item;
  }
  function qaRule(rule, definition, threshold, items, truncated) {
    return { rule: rule, definition: definition, threshold: threshold, count: items.length, truncated: !!truncated, items: items };
  }
`;

/** Collects measurements from the live page. Returns facts only. */
export const MEASURE_SCRIPT = String.raw`(() => {
  ${HELPERS}
  var LIMIT = 20;

  var docEl = document.documentElement;
  var overflowItems = [];
  var overflow = docEl.scrollWidth - window.innerWidth;
  if (overflow > 0) {
    var wide = [];
    var all = document.querySelectorAll("body *");
    for (var i = 0; i < all.length && wide.length < LIMIT; i++) {
      var el = all[i];
      if (!qaVisible(el)) continue;
      var r = el.getBoundingClientRect();
      if (r.right > window.innerWidth + 1 || r.left < -1) {
        wide.push(qaItem(el, { overflow_px: Math.round(Math.max(r.right - window.innerWidth, -r.left)) }));
      }
    }
    overflowItems = wide;
  }

  var brokenImages = [];
  var noAlt = [];
  var imgs = document.querySelectorAll("img");
  for (var j = 0; j < imgs.length && brokenImages.length < LIMIT; j++) {
    var img = imgs[j];
    if (img.complete && img.naturalWidth === 0) {
      brokenImages.push(qaItem(img, { src: (img.currentSrc || img.src || "").slice(0, 200) }));
    }
    if (!img.hasAttribute("alt") && noAlt.length < LIMIT) noAlt.push(qaItem(img, {}));
  }

  var interactive = document.querySelectorAll("a, button, input, select, textarea, [role=button], [role=link]");
  var smallTargets = [];
  for (var k = 0; k < interactive.length && smallTargets.length < LIMIT; k++) {
    var t = interactive[k];
    if (!qaVisible(t) || t.disabled) continue;
    var b = qaBox(t);
    if (b.w < 24 || b.h < 24) smallTargets.push(qaItem(t, { width: b.w, height: b.h }));
  }

  var clipped = [];
  var candidates = document.querySelectorAll("body *");
  for (var m = 0; m < candidates.length && clipped.length < LIMIT; m++) {
    var c = candidates[m];
    if (!qaVisible(c)) continue;
    var tag = c.tagName.toLowerCase();
    if (tag === "script" || tag === "style" || tag === "svg" || tag === "path") continue;
    if (c.children.length > 0 && (c.innerText || "").length > 400) continue;
    var style = getComputedStyle(c);
    var hiddenX = style.overflowX === "hidden" || style.overflowX === "clip";
    var hiddenY = style.overflowY === "hidden" || style.overflowY === "clip";
    var clipX = hiddenX && c.scrollWidth > c.clientWidth + 1 && c.clientWidth > 0;
    var clipY = hiddenY && c.scrollHeight > c.clientHeight + 1 && c.clientHeight > 0;
    if (clipX || clipY) {
      clipped.push(qaItem(c, {
        hidden_px_x: clipX ? c.scrollWidth - c.clientWidth : 0,
        hidden_px_y: clipY ? c.scrollHeight - c.clientHeight : 0
      }));
    }
  }

  return {
    url: location.href,
    title: document.title,
    viewport: { w: window.innerWidth, h: window.innerHeight, dpr: window.devicePixelRatio },
    document: { scroll_width: docEl.scrollWidth, scroll_height: docEl.scrollHeight },
    measurements: [
      qaRule(
        "horizontal_overflow",
        "document scrollWidth exceeds the viewport width",
        "scrollWidth - innerWidth > 0",
        overflowItems,
        overflowItems.length >= LIMIT
      ),
      qaRule(
        "broken_images",
        "img elements whose bytes failed to load",
        "complete && naturalWidth === 0",
        brokenImages,
        brokenImages.length >= LIMIT
      ),
      qaRule(
        "images_missing_alt",
        "img elements with no alt attribute (empty alt is treated as decorative and allowed)",
        "!img.hasAttribute('alt')",
        noAlt,
        noAlt.length >= LIMIT
      ),
      qaRule(
        "small_targets",
        "visible interactive controls smaller than 24x24 CSS px",
        "width < 24 || height < 24",
        smallTargets,
        smallTargets.length >= LIMIT
      ),
      qaRule(
        "clipped_text",
        "elements hiding their own overflow whose content does not fit",
        "overflow hidden/clip and scrollWidth/scrollHeight exceed client box by >1px",
        clipped,
        clipped.length >= LIMIT
      )
    ],
    measured_at: new Date().toISOString()
  };
})()`;
