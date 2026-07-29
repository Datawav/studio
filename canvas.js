"use strict";
// SeedHammer Studio — canvas editor.
//
// A WYSIWYG vector surface. Every object on the plate (text field, rect,
// ellipse, line, freehand, polygon, dropped SVG, traced image) is a scene
// object = local paths + an affine transform + a style. The scene serializes
// to the same curves payload the other tabs produce: worldSegs() bakes each
// object's transform into absolute plate-mm coordinates and hands the flat
// segs array to the existing emit()/draw()/gauges() pipeline unchanged.
//
// The editing surface is an <svg viewBox="0 0 85 85"> (1 unit = 1mm) over a
// steel-look backdrop; the faithful engraving preview + gauges live in the
// existing right-hand panel. This file reuses the inline script's globals
// (SH, emit, bounds, mapSeg, parsePath, extractSVG, poly, ell, gseg, PLATE_MM,
// MARGIN_MM, FIT_MM, ITALIC, recompute).
window.Canvas = (function () {
  const SVGNS = "http://www.w3.org/2000/svg";
  const LSP = 1.18;                     // line spacing, matches richtext.go
  const ROT_OFF = 5;                    // rotate handle offset, mm
  const MINSZ = 1.5;                    // min object size on create, mm
  const UNDO_MAX = 60;

  let doc = { v: 1, objects: [] };
  let sel = null;                       // selected object id (single-object transforms)
  let marks = [];                       // shift-click multi-selection (for grouping/move)
  let tool = "select";
  let editId = null, editCaret = 0;    // text object being edited in place + caret index
  let editTA = null, editDrag = null;  // the editor's capture textarea + mouse-selection anchor
  let editCell = null;                 // {r, c} when the edited object is a table
  let closeEdit = null;                // commits + closes the open editor synchronously
  let counter = 0;
  const undo = [], redo = [];
  let suppressSnapshot = false;

  // ---- geometry ----------------------------------------------------------
  function affine(tf) {
    const r = (tf.rot || 0) * Math.PI / 180, co = Math.cos(r), si = Math.sin(r);
    const sx = tf.sx == null ? 1 : tf.sx, sy = tf.sy == null ? 1 : tf.sy;
    return { a: sx * co, b: sx * si, c: -sy * si, d: sy * co, e: tf.x, f: tf.y };
  }
  const apply = (m, p) => [m.a * p[0] + m.c * p[1] + m.e, m.b * p[0] + m.d * p[1] + m.f];

  // localPaths(o): segs centered on the object's own origin (0,0).
  function localPaths(o) {
    switch (o.type) {
      case "text": return textLocal(o);
      case "table": return tableLocal(o);
      case "rect": return centered(poly([[0, 0], [o.w, 0], [o.w, o.h], [0, o.h]], 1));
      case "ellipse": return ell(0, 0, o.w / 2, o.h / 2);
      case "group": { const out = []; for (const ch of o.children) { const m = affine(ch.tf); for (const s of localPaths(ch)) out.push(mapSeg(s, p => apply(m, p))); } return out; }
      case "freehand": return smoothPath(o.pts || []);
      default: return o.segs || [];      // line/poly/svg/trace: stored centered
    }
  }
  function centered(segs) {
    const b = bounds(segs); if (b.empty) return segs;
    const cx = (b.minX + b.maxX) / 2, cy = (b.minY + b.maxY) / 2;
    return segs.map(s => mapSeg(s, ([x, y]) => [x - cx, y - cy]));
  }
  // Catmull-Rom through the sample points -> cubic Béziers, so freehand draws
  // and engraves as smooth curves rather than an angular polyline.
  function smoothPath(pts) {
    if (pts.length < 2) return [];
    if (pts.length === 2) return [{ op: "M", p: [pts[0]] }, { op: "L", p: [pts[1]] }];
    const out = [{ op: "M", p: [pts[0]] }];
    for (let i = 0; i < pts.length - 1; i++) {
      const p0 = pts[i - 1] || pts[i], p1 = pts[i], p2 = pts[i + 1], p3 = pts[i + 2] || pts[i + 1];
      const c1 = [p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6];
      const c2 = [p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6];
      out.push({ op: "C", p: [c1, c2, p2] });
    }
    return out;
  }
  // Tight bounds: sample curves instead of taking their control points, so the
  // selection box and snapping wrap rotated and curved geometry exactly.
  const qbez = (a, b, c, t) => { const u = 1 - t; return [u * u * a[0] + 2 * u * t * b[0] + t * t * c[0], u * u * a[1] + 2 * u * t * b[1] + t * t * c[1]]; };
  const cbez = (a, b, c, d, t) => { const u = 1 - t; return [u * u * u * a[0] + 3 * u * u * t * b[0] + 3 * u * t * t * c[0] + t * t * t * d[0], u * u * u * a[1] + 3 * u * u * t * b[1] + 3 * u * t * t * c[1] + t * t * t * d[1]]; };
  function flatBounds(segs) {
    let a = Infinity, b = Infinity, c = -Infinity, d = -Infinity, pen = null;
    const acc = (x, y) => { a = Math.min(a, x); b = Math.min(b, y); c = Math.max(c, x); d = Math.max(d, y); };
    for (const s of segs) {
      const p = s.p;
      if (s.op === "M") { pen = p[0]; acc(pen[0], pen[1]); continue; }
      if (s.op === "L") { acc(p[0][0], p[0][1]); pen = p[0]; continue; }
      const e = p[p.length - 1];
      for (let i = 1; i <= 10; i++) { const t = i / 10, q = s.op === "Q" ? qbez(pen, p[0], e, t) : cbez(pen, p[0], p[1], e, t); acc(q[0], q[1]); }
      pen = e;
    }
    if (!isFinite(a)) return { minX: 0, minY: 0, maxX: 0, maxY: 0, w: 0, h: 0, empty: true };
    return { minX: a, minY: b, maxX: c, maxY: d, w: c - a, h: d - b, empty: false };
  }
  function textLocal(o) { return centered(layoutGlyphs(o)); }
  // The text caret as a world-space line. It uses the plate font's own
  // advances and the same centring layoutGlyphs feeds textLocal, so it sits
  // exactly between the engraved glyphs at any size or rotation — no font
  // matching, unlike an HTML overlay.
  function caretLine(o, idx) {
    const c = caretLocal(o, idx), m = affine(o.tf);
    return [apply(m, [c.x, c.y0]), apply(m, [c.x, c.y1])];
  }
  // the block-centring offset textLocal applies, so caret/selection geometry
  // shares the glyphs' coordinate frame
  function textCentre(o) {
    const b = bounds(layoutGlyphs(o));
    return b.empty ? [0, 0] : [(b.minX + b.maxX) / 2, (b.minY + b.maxY) / 2];
  }
  // markers style runs but occupy no width; visible column of raw index i
  const visCol = (line, i) => { let n = 0; for (let k = 0; k < Math.min(i, line.length); k++) if (line[k] !== "*" && line[k] !== "_") n++; return n; };
  // strip characters without a glyph as they are typed: nothing engraves
  // for them (the layout leaves a blank cell) and the send gate refuses
  // the document. The style markers * and _ are glyphs and pass.
  const engravable = new Set(Object.keys(SH.glyphs));
  function stripGlyphless(ta, keepNL) {
    let clean = "";
    for (const ch of ta.value) { if ((keepNL && ch === "\n") || engravable.has(ch)) clean += ch; }
    if (clean !== ta.value) {
      const at = ta.selectionStart - (ta.value.length - clean.length);
      ta.value = clean;
      ta.selectionStart = ta.selectionEnd = Math.max(0, at);
    }
  }
  // caret geometry for raw string index idx, in the object's local frame
  function caretLocal(o, idx) {
    const sc = o.sizeMM / SH.height, lines = (o.str || "").split("\n");
    let li = 0, col = Math.max(0, idx | 0);
    while (li < lines.length - 1 && col > lines[li].length) { col -= lines[li].length + 1; li++; }
    const [cx, cy] = textCentre(o), y = li * o.sizeMM * LSP;
    return { x: visCol(lines[li] || "", col) * SH.advance * sc - cx, y0: y - cy, y1: y + o.sizeMM - cy, li };
  }
  // nearest raw string index for a point in the object's local frame — the
  // inverse of caretLocal, for mouse caret placement and drag selection
  function indexAt(o, lx, ly) {
    const sc = o.sizeMM / SH.height, adv = SH.advance * sc, lines = (o.str || "").split("\n");
    const [cx, cy] = textCentre(o);
    const li = Math.max(0, Math.min(lines.length - 1, Math.floor((ly + cy) / (o.sizeMM * LSP))));
    const line = lines[li], want = Math.max(0, Math.round((lx + cx) / adv));
    let raw = 0, seen = 0;
    while (raw < line.length && seen < want) { if (line[raw] !== "*" && line[raw] !== "_") seen++; raw++; }
    let idx = raw; for (let k = 0; k < li; k++) idx += lines[k].length + 1;
    return idx;
  }
  // One styled line of text at (ox, oy) in the object's local space,
  // appended to out as placed groups: one {at, segs} per glyph or
  // underline rule, segs local to at. The payload dictionary dedups on
  // identical local segs, so every glyph of one size and style ships its
  // outline once. *x* toggles italic and _x_ underline (splitFmt), XORed
  // with the base flags so toolbar toggles and inline markup both apply.
  // Returns the end pen x.
  function lineGroups(str, sizeMM, ox, oy, baseIt, baseUn, out) {
    const asc = SH.ascent, adv = SH.advance, sc = sizeMM / SH.height;
    let x = ox;
    for (const run of splitFmt(str)) {
      const italic = run.italic !== !!baseIt, underline = run.underline !== !!baseUn, rx0 = x;
      for (const ch of run.text) {
        const g = gseg(ch);
        if (g && g.length) out.push({ at: [x, oy], segs: g.map(s => mapSeg(s, ([px, py]) => {
          let fx = px; if (italic) fx += ITALIC * (asc - py);
          return [fx * sc, py * sc];
        })) });
        x += adv * sc;
      }
      if (underline && x > rx0) { const uy = oy + asc * sc + sizeMM * 0.1; out.push({ at: [rx0, uy], segs: [{ op: "M", p: [[0, 0]] }, { op: "L", p: [[x - rx0, 0]] }] }); }
    }
    return x;
  }
  // un-centred glyph geometry in the object's local space, as placed groups
  function layoutGroups(o) {
    const out = [], lines = (o.str || "").split("\n");
    for (let li = 0; li < lines.length; li++) {
      lineGroups(lines[li], o.sizeMM, 0, li * o.sizeMM * LSP, o.italic, o.underline, out);
    }
    return out;
  }
  // the flat view of a grouped layout, for rendering, bounds and caret math
  function flattenGroups(groups) {
    const out = [];
    for (const g of groups) for (const s of g.segs) out.push(mapSeg(s, ([x, y]) => [g.at[0] + x, g.at[1] + y]));
    return out;
  }
  function layoutGlyphs(o) { return flattenGroups(layoutGroups(o)); }

  // ---- tables ------------------------------------------------------------
  // A WYSIWYG table: cells of styled text in a grid of rules, laid out
  // with the same pads and line spacing as richtext.go's pipe tables but
  // edited on the plate, cell by cell. Column widths follow the widest
  // cell, so the table reflows as you type — the preview is the layout.
  function measureVis(str, sc) { let n = 0; for (const ch of str) if (ch !== "*" && ch !== "_") n++; return n * SH.advance * sc; }
  function tableMetrics(o) {
    const sc = o.sizeMM / SH.height;
    const rows = o.cells.length, cols = Math.max(1, ...o.cells.map(r => r.length));
    const widths = [];
    for (let c = 0; c < cols; c++) {
      let w = 0;
      for (const row of o.cells) w = Math.max(w, measureVis(row[c] || "", sc));
      widths.push(w + 2 * CPAD);
    }
    const rowH = o.sizeMM * LSP + 2 * RPAD;
    return { sc, rows, cols, widths, rowH, W: widths.reduce((a, b) => a + b, 0), H: rowH * rows };
  }
  function tableGroups(o) {
    const m = tableMetrics(o), out = [];
    const rule = (x, y, dx, dy) => out.push({ at: [x, y], segs: [{ op: "M", p: [[0, 0]] }, { op: "L", p: [[dx, dy]] }] });
    // rules at every row and column boundary; equal spans share one
    // dictionary shape
    for (let r = 0; r <= m.rows; r++) rule(0, r * m.rowH, m.W, 0);
    let vx = 0; rule(0, 0, 0, m.H);
    for (const w of m.widths) { vx += w; rule(vx, 0, 0, m.H); }
    for (let r = 0; r < m.rows; r++) {
      let cx = 0;
      for (let c = 0; c < m.cols; c++) {
        const cell = (o.cells[r] || [])[c] || "";
        if (cell) lineGroups(cell, o.sizeMM, cx + CPAD, r * m.rowH + RPAD, false, false, out);
        cx += m.widths[c];
      }
    }
    return out;
  }
  function tableCentre(o) { const m = tableMetrics(o); return [m.W / 2, m.H / 2]; }
  function tableLocal(o) {
    const [cx, cy] = tableCentre(o);
    return flattenGroups(tableGroups(o)).map(s => mapSeg(s, ([x, y]) => [x - cx, y - cy]));
  }
  // a cell's text origin (padding applied) in centred local space
  function cellOrigin(o, r, c) {
    const m = tableMetrics(o), [cx, cy] = tableCentre(o);
    let x = 0; for (let i = 0; i < c; i++) x += m.widths[i];
    return { x: x + CPAD - cx, y: r * m.rowH + RPAD - cy };
  }
  // the cell under a centred-local point
  function cellAt(o, lx, ly) {
    const m = tableMetrics(o), [cx, cy] = tableCentre(o);
    const r = Math.max(0, Math.min(m.rows - 1, Math.floor((ly + cy) / m.rowH)));
    let c = 0, ax = 0;
    for (; c < m.cols - 1; c++) { ax += m.widths[c]; if (lx + cx < ax) break; }
    return { r, c };
  }
  // local half-extents for handles
  function halfExtent(o) {
    if (o.type === "rect" || o.type === "ellipse") return { hw: o.w / 2, hh: o.h / 2 };
    if (o.type === "table") { const m = tableMetrics(o); return { hw: m.W / 2, hh: m.H / 2 }; }
    const b = flatBounds(localPaths(o));
    if (b.empty) return { hw: 1, hh: 1 };
    return { hw: Math.max(b.w / 2, 0), hh: Math.max(b.h / 2, 0) };
  }
  function worldSegs() {
    const out = [];
    for (const o of doc.objects) { const m = affine(o.tf); for (const s of localPaths(o)) out.push(mapSeg(s, p => apply(m, p))); }
    return out;
  }
  // worldSegs with structure kept for the payload dictionary: one
  // {at, segs} per placed shape in plate mm — per glyph for text, per
  // object otherwise. Local points carry only the transform's linear part
  // (rotation/scale/mirror); at carries the translation, so duplicated
  // objects and repeated glyphs stay byte-identical and dedup. Transforms
  // compose as functions, exactly as the nested-group render does.
  function worldGroups() {
    const out = [];
    const walk = (o, outer) => {
      const m = affine(o.tf), t = p => outer(apply(m, p));
      if (o.type === "group") { for (const ch of o.children) walk(ch, t); return; }
      const o0 = t([0, 0]), lin = p => { const q = t(p); return [q[0] - o0[0], q[1] - o0[1]]; };
      if (o.type === "text" || o.type === "table") {
        const [cx, cy] = o.type === "text" ? textCentre(o) : tableCentre(o);
        for (const g of o.type === "text" ? layoutGroups(o) : tableGroups(o)) out.push({
          at: t([g.at[0] - cx, g.at[1] - cy]),
          segs: g.segs.map(s => mapSeg(s, lin)),
        });
        return;
      }
      const segs = localPaths(o);
      if (segs.length) splitStrokes(o0, segs.map(s => mapSeg(s, lin)), out);
    };
    for (const o of doc.objects) walk(o, p => p);
    return out;
  }

  // splitStrokes cuts one object's outline into a placement per stroke,
  // each local to its own start. An imported drawing arrives as a single
  // object, so without this its repeated shapes — a glyph stamped across
  // a logo, a shape copied over a plate — are one placement the
  // dictionary cannot mine, and travel ordering cannot reorder either.
  // Normalizing to the start is what makes copies byte-identical: they
  // differ only in where they sit, which is exactly what at carries.
  // Text keeps its own per-glyph placements, which are already compact.
  function splitStrokes(at, segs, out) {
    let cur = null, org = null;
    for (const s of segs) {
      if (s.op === "M") {
        org = s.p[0];
        cur = [{ op: "M", p: [[0, 0]] }];
        out.push({ at: [at[0] + org[0], at[1] + org[1]], segs: cur });
        continue;
      }
      if (!cur) continue;      // geometry before its first move: nothing placed yet
      cur.push({ op: s.op, p: s.p.map(([x, y]) => [x - org[0], y - org[1]]) });
    }
  }

  // ---- SVG surface -------------------------------------------------------
  let svg, gObjs, gUI;
  function pathD(segs) {
    let d = "";
    for (const s of segs) { const p = s.p;
      if (s.op === "M") d += `M${p[0][0]} ${p[0][1]} `;
      else if (s.op === "L") d += `L${p[0][0]} ${p[0][1]} `;
      else if (s.op === "Q") d += `Q${p[0][0]} ${p[0][1]} ${p[1][0]} ${p[1][1]} `;
      else d += `C${p[0][0]} ${p[0][1]} ${p[1][0]} ${p[1][1]} ${p[2][0]} ${p[2][1]} `;
    }
    return d;
  }
  const mstr = m => `matrix(${m.a} ${m.b} ${m.c} ${m.d} ${m.e} ${m.f})`;
  function el(tag, attrs) { const e = document.createElementNS(SVGNS, tag); for (const k in attrs) e.setAttribute(k, attrs[k]); return e; }

  function render() {
    if (!svg) return;
    gObjs.textContent = "";
    for (const o of doc.objects) {
      const g = el("g", { transform: mstr(affine(o.tf)), "data-id": o.id, class: "cvObj" });
      g.appendChild(el("path", { d: pathD(localPaths(o)), fill: "none", stroke: "var(--engrave)", "stroke-width": 1.4, "vector-effect": "non-scaling-stroke", "stroke-linejoin": "round", "stroke-linecap": "round" }));
      gObjs.appendChild(g);
    }
    renderUI();
  }
  function renderUI() {
    gUI.textContent = "";
    if (editId != null) {
      const eo = doc.objects.find(x => x.id === editId);
      if (eo && editCell) {
        // table cell: caret and selection in the cell's advance frame
        const m = affine(eo.tf), sc = eo.sizeMM / SH.height, adv = SH.advance * sc;
        const co = cellOrigin(eo, editCell.r, editCell.c);
        const str = (eo.cells[editCell.r] || [])[editCell.c] || "";
        if (editTA && editTA.selectionStart !== editTA.selectionEnd) {
          const x0 = co.x + visCol(str, Math.min(editTA.selectionStart, editTA.selectionEnd)) * adv;
          const x1 = co.x + visCol(str, Math.max(editTA.selectionStart, editTA.selectionEnd)) * adv;
          const q = [[x0, co.y], [x1, co.y], [x1, co.y + eo.sizeMM], [x0, co.y + eo.sizeMM]].map(p => apply(m, p));
          gUI.appendChild(el("polygon", { points: q.map(c => c.join(",")).join(" "), class: "cvSel" }));
        }
        const x = co.x + visCol(str, editCaret) * adv, bad = window.charErr && charErr(str);
        const p0 = apply(m, [x, co.y]), p1 = apply(m, [x, co.y + eo.sizeMM]);
        gUI.appendChild(el("line", { x1: p0[0], y1: p0[1], x2: p1[0], y2: p1[1], class: "cvCaret" + (bad ? " bad" : "") }));
        return;
      }
      if (eo) {
        // selection highlight: one translucent quad per spanned line, in the
        // same advance-cell frame as the glyphs and the caret
        if (editTA && editTA.selectionStart !== editTA.selectionEnd) {
          const m = affine(eo.tf), sc = eo.sizeMM / SH.height, adv = SH.advance * sc;
          const lines = (eo.str || "").split("\n"), [cx, cy] = textCentre(eo);
          const a = caretLocal(eo, Math.min(editTA.selectionStart, editTA.selectionEnd));
          const b = caretLocal(eo, Math.max(editTA.selectionStart, editTA.selectionEnd));
          for (let li = a.li; li <= b.li; li++) {
            const x0 = li === a.li ? a.x : -cx;
            const x1 = li === b.li ? b.x : visCol(lines[li], lines[li].length) * adv - cx;
            const y0 = li * eo.sizeMM * LSP - cy, y1 = y0 + eo.sizeMM;
            const q = [[x0, y0], [x1, y0], [x1, y1], [x0, y1]].map(p => apply(m, p));
            gUI.appendChild(el("polygon", { points: q.map(c => c.join(",")).join(" "), class: "cvSel" }));
          }
        }
        const [a, z] = caretLine(eo, editCaret), bad = window.charErr && charErr(eo.str);
        gUI.appendChild(el("line", { x1: a[0], y1: a[1], x2: z[0], y2: z[1], class: "cvCaret" + (bad ? " bad" : "") }));
      }
      return;
    }
    if (marks.length > 1) {
      for (const id of marks) { const o = doc.objects.find(x => x.id === id); if (!o) continue; const m = affine(o.tf), { hw, hh } = halfExtent(o), ph = Math.max(hw, 0.6), pv = Math.max(hh, 0.6); const cs = [[-ph, -pv], [ph, -pv], [ph, pv], [-ph, pv]].map(p => apply(m, p)); gUI.appendChild(el("polygon", { points: cs.map(c => c.join(",")).join(" "), class: "cvMark" })); }
      return;
    }
    const o = current(); if (!o) return;
    const m = affine(o.tf), { hw, hh } = halfExtent(o);
    const ph = Math.max(hw, 0.6), pv = Math.max(hh, 0.6);           // pad degenerate boxes
    const corners = [[-ph, -pv], [ph, -pv], [ph, pv], [-ph, pv]].map(p => apply(m, p));
    const mids = [[0, -pv], [ph, 0], [0, pv], [-ph, 0]].map(p => apply(m, p));
    gUI.appendChild(el("polygon", { points: corners.map(c => c.join(",")).join(" "), class: "cvBox" }));
    // rotate handle above the top edge
    const topMid = apply(m, [0, -pv]), ctr = apply(m, [0, 0]);
    let dx = topMid[0] - ctr[0], dy = topMid[1] - ctr[1], L = Math.hypot(dx, dy) || 1;
    const rp = [topMid[0] + dx / L * ROT_OFF, topMid[1] + dy / L * ROT_OFF];
    gUI.appendChild(el("line", { x1: topMid[0], y1: topMid[1], x2: rp[0], y2: rp[1], class: "cvBox" }));
    gUI.appendChild(el("circle", { cx: rp[0], cy: rp[1], r: 1.6, class: "cvRot", "data-h": "rot" }));
    corners.forEach((c, i) => gUI.appendChild(el("rect", { x: c[0] - 1.3, y: c[1] - 1.3, width: 2.6, height: 2.6, class: "cvH", "data-h": "c" + i })));
    mids.forEach((c, i) => gUI.appendChild(el("rect", { x: c[0] - 1.1, y: c[1] - 1.1, width: 2.2, height: 2.2, class: "cvH cvHm", "data-h": "m" + i })));
  }
  const current = () => doc.objects.find(o => o.id === sel) || null;

  function toMM(ev) {
    const pt = svg.createSVGPoint(); pt.x = ev.clientX; pt.y = ev.clientY;
    const r = pt.matrixTransform(svg.getScreenCTM().inverse());
    return [r.x, r.y];
  }

  // ---- interaction -------------------------------------------------------
  let drag = null, lastDownId = null;
  function onDown(ev) {
    if (ev.button !== undefined && ev.button !== 0) return;
    svg.setPointerCapture && svg.setPointerCapture(ev.pointerId);
    const p = toMM(ev), h = ev.target.getAttribute && ev.target.getAttribute("data-h");
    // While a text object is being edited, a press on it moves the caret (a
    // drag extends the selection) instead of starting a move; a press
    // anywhere else falls through and the editor commits on blur.
    if (editId != null && editTA) {
      const eo = doc.objects.find(x => x.id === editId);
      if (eo) {
        const lp = toLocal(eo, p), { hw, hh } = halfExtent(eo);
        if (lp[0] >= -hw - 1.5 && lp[0] <= hw + 1.5 && lp[1] >= -hh - 1.5 && lp[1] <= hh + 1.5) {
          ev.preventDefault();
          if (eo.type === "table") {
            // press on the edited table: same cell moves the caret,
            // another cell switches the editor to it
            const { r, c } = cellAt(eo, lp[0], lp[1]);
            if (editCell && r === editCell.r && c === editCell.c) {
              const co = cellOrigin(eo, r, c), adv = SH.advance * eo.sizeMM / SH.height;
              const str = (eo.cells[r] || [])[c] || "";
              const want = Math.max(0, Math.round((lp[0] - co.x) / adv));
              let raw = 0, seen = 0;
              while (raw < str.length && seen < want) { if (str[raw] !== "*" && str[raw] !== "_") seen++; raw++; }
              editTA.setSelectionRange(raw, raw); editTA.focus({ preventScroll: true });
              editCaret = raw; render();
            } else openCell(eo, r, c);
            return;
          }
          const idx = indexAt(eo, lp[0], lp[1]);
          editDrag = { anchor: idx };
          editTA.setSelectionRange(idx, idx); editTA.focus({ preventScroll: true });
          editCaret = idx; render();
          return;
        }
      }
    }
    if (tool !== "select") { lastDownId = null; startCreate(tool, p, ev); return; }
    if (h && current()) { lastDownId = null; startHandle(h, p); return; }
    // hit-test: a direct stroke hit, else the topmost object whose box contains p
    const hitG = ev.target.closest && ev.target.closest(".cvObj");
    const id = hitG ? hitG.getAttribute("data-id") : pickAt(p);
    lastDownId = id;
    if (id && ev.shiftKey) { toggleMark(id); return; }
    if (id) { marks = []; select(id); startMove(p); }
    else { marks = []; select(null); }
  }
  function toggleMark(id) {
    const i = marks.indexOf(id);
    if (i >= 0) marks.splice(i, 1); else marks.push(id);
    if (marks.length === 1) { sel = marks[0]; } else if (!marks.length) sel = null;
    renderUI(); syncStyle();
  }
  // pointer p (mm) into an object's local frame, undoing translate/rotate/scale
  function toLocal(o, p) {
    const r = (o.tf.rot || 0) * Math.PI / 180, co = Math.cos(r), si = Math.sin(r);
    const x = p[0] - o.tf.x, y = p[1] - o.tf.y;
    return [(co * x + si * y) / (o.tf.sx || 1), (-si * x + co * y) / (o.tf.sy || 1)];
  }
  // topmost object whose (padded) bounding box contains p, or null
  function pickAt(p) {
    for (let i = doc.objects.length - 1; i >= 0; i--) {
      const o = doc.objects[i], lp = toLocal(o, p), { hw, hh } = halfExtent(o);
      const px = Math.max(hw, 1.2), py = Math.max(hh, 1.2);
      if (lp[0] >= -px && lp[0] <= px && lp[1] >= -py && lp[1] <= py) return o.id;
    }
    return null;
  }
  function startMove(p) { const o = current(); drag = { kind: "move", o, start: p, tf0: { ...o.tf } }; }
  function startHandle(h, p) {
    const o = current(), { hw, hh } = halfExtent(o);
    drag = { kind: h === "rot" ? "rot" : "scale", o, start: p, tf0: { ...o.tf }, h, hw, hh, size0: o.sizeMM };
  }
  function startCreate(t, p, ev) {
    if (t === "text") {
      // The click's default action would move focus AFTER our handlers run,
      // instantly blurring the just-opened editor (and dropping the still-
      // empty object). Cancel it so the editor keeps focus.
      if (ev && ev.cancelable) ev.preventDefault();
      commitSnapshot(); const o = mkText("", p); select(o.id); setTool("select"); recomputeAll(); openInline(o); return;
    }
    if (t === "table") {
      if (ev && ev.cancelable) ev.preventDefault();
      commitSnapshot(); const o = mkTable(p); select(o.id); setTool("select"); render(); recomputeAll(); openCell(o, 0, 0); return;
    }
    if (t === "poly") { addPolyVertex(p); return; }
    // rect / ellipse / line / pen: drag to size
    drag = { kind: "create", t, start: p, pts: [p] };
  }
  function onMove(ev) {
    if (editDrag && editId != null && editTA) {
      const eo = doc.objects.find(x => x.id === editId);
      if (eo) {
        const lp = toLocal(eo, toMM(ev)), idx = indexAt(eo, lp[0], lp[1]);
        const a = Math.min(editDrag.anchor, idx), b = Math.max(editDrag.anchor, idx);
        editTA.setSelectionRange(a, b, idx < editDrag.anchor ? "backward" : "forward");
        editCaret = idx; render();
      }
      return;
    }
    if (!drag) return;
    const p = toMM(ev);
    if (drag.kind === "move") { const dx = p[0] - drag.start[0], dy = p[1] - drag.start[1]; drag.o.tf.x = drag.tf0.x + dx; drag.o.tf.y = drag.tf0.y + dy; snapMove(drag.o); liveTransform(drag.o); }
    else if (drag.kind === "rot") { const o = drag.o, ctr = [o.tf.x, o.tf.y]; const ang = Math.atan2(p[1] - ctr[1], p[0] - ctr[0]) * 180 / Math.PI + 90; o.tf.rot = ev.shiftKey ? Math.round(ang / 15) * 15 : ang; liveTransform(o); renderUI(); }
    else if (drag.kind === "scale") { doScale(p, ev.shiftKey); }
    else if (drag.kind === "create") { drag.pts.push(p); previewCreate(); }
  }
  function onUp() {
    editDrag = null;
    if (!drag) { return; }
    gUI.querySelectorAll(".cvSnap").forEach(n => n.remove());
    if (drag.kind === "create") finishCreate();
    else if (drag.kind === "move" || drag.kind === "rot" || drag.kind === "scale") { commitSnapshot(); recomputeAll(); }
    drag = null;
  }
  // snap the object's centre and edges to the margins and the plate centre
  function snapMove(o) {
    gUI.querySelectorAll(".cvSnap").forEach(n => n.remove());
    const T = 1.4, gx = [MARGIN_MM, PLATE_MM / 2, PLATE_MM - MARGIN_MM], he = halfExtent(o);
    const ex = he.hw * Math.abs(o.tf.sx || 1), ey = he.hh * Math.abs(o.tf.sy || 1);
    const ax = [o.tf.x - ex, o.tf.x, o.tf.x + ex], ay = [o.tf.y - ey, o.tf.y, o.tf.y + ey];
    for (const g of gx) { let done = false; for (const a of ax) if (Math.abs(a - g) < T) { o.tf.x += g - a; gUI.appendChild(el("line", { x1: g, y1: 0, x2: g, y2: PLATE_MM, class: "cvSnap" })); done = true; break; } if (done) break; }
    for (const g of gx) { let done = false; for (const a of ay) if (Math.abs(a - g) < T) { o.tf.y += g - a; gUI.appendChild(el("line", { x1: 0, y1: g, x2: PLATE_MM, y2: g, class: "cvSnap" })); done = true; break; } if (done) break; }
  }
  // move/scale/rotate the live SVG group cheaply, defer the heavy preview
  function liveTransform(o) {
    const g = gObjs.querySelector(`[data-id="${o.id}"]`); if (g) g.setAttribute("transform", mstr(affine(o.tf)));
    if (o.type === "text" || o.type === "table" || o.type === "ellipse" || o.type === "rect") { const gp = g && g.firstChild; if (gp) gp.setAttribute("d", pathD(localPaths(o))); }
    renderUI(); previewDebounced();
  }
  // Resize by dragging a handle. The opposite handle stays fixed (the anchor);
  // shift locks the aspect ratio (and text always does, since stretched glyphs
  // look wrong). Works in the object's rotated frame, so it is correct at any
  // rotation, and negative scale past the anchor mirrors, as expected.
  function doScale(p, uniform) {
    const o = drag.o, r = (drag.tf0.rot || 0) * Math.PI / 180, co = Math.cos(r), si = Math.sin(r);
    const hw = drag.hw, hh = drag.hh, m0 = affine(drag.tf0);
    // per handle: the dragged corner's local sign (cx,cy) and which axes it drives
    const H = {
      c0: { cx: -1, cy: -1, ax: 1, ay: 1 }, c1: { cx: 1, cy: -1, ax: 1, ay: 1 }, c2: { cx: 1, cy: 1, ax: 1, ay: 1 }, c3: { cx: -1, cy: 1, ax: 1, ay: 1 },
      m0: { cx: 0, cy: -1, ax: 0, ay: 1 }, m1: { cx: 1, cy: 0, ax: 1, ay: 0 }, m2: { cx: 0, cy: 1, ax: 0, ay: 1 }, m3: { cx: -1, cy: 0, ax: 1, ay: 0 },
    }[drag.h];
    // anchor = the opposite handle, held fixed in world space
    const A = apply(m0, [H.ax ? -H.cx * hw : 0, H.ay ? -H.cy * hh : 0]);
    const dv = [p[0] - A[0], p[1] - A[1]];
    const dux = dv[0] * co + dv[1] * si, duy = -dv[0] * si + dv[1] * co; // project onto local axes
    let sx = H.ax ? (dux * H.cx) / (2 * hw || 1) : (drag.tf0.sx || 1);
    let sy = H.ay ? (duy * H.cy) / (2 * hh || 1) : (drag.tf0.sy || 1);
    // text and tables scale through sizeMM, not the transform: stretched
    // glyphs look wrong, so a corner drag rescales the type instead
    const isText = o.type === "text" || o.type === "table";
    if ((uniform || isText) && H.ax && H.ay) { const f = Math.max(Math.abs(sx), Math.abs(sy)) || 0.01; sx = f * (sx < 0 ? -1 : 1); sy = f * (sy < 0 ? -1 : 1); }
    const place = (hwN, hhN) => {
      const vx = H.ax ? sx * H.cx * hwN : 0, vy = H.ay ? sy * H.cy * hhN : 0;
      o.tf.x = A[0] + co * vx - si * vy; o.tf.y = A[1] + si * vx + co * vy;
    };
    if (isText) {
      const f = Math.max(Math.abs(sx), Math.abs(sy)) || 0.01;
      o.sizeMM = Math.max(3, (drag.size0 || o.sizeMM) * f); // 3.0mm: smallest readable type on steel (firmware ladder floor)
      o.tf.sx = sx < 0 ? -1 : 1; o.tf.sy = sy < 0 ? -1 : 1;
      const he = halfExtent(o); place(he.hw, he.hh);
    } else { o.tf.sx = sx || 0.01; o.tf.sy = sy || 0.01; place(hw, hh); }
    liveTransform(o);
  }

  // ---- object creation ---------------------------------------------------
  function nextId() { return "o" + (++counter); }
  function addObject(o) { doc.objects.push(o); return o; }
  function mkText(str, p) { return addObject({ id: nextId(), type: "text", tf: { x: p[0], y: p[1], sx: 1, sy: 1, rot: 0 }, str, sizeMM: 6, italic: false, underline: false }); }
  function mkTable(p) { return addObject({ id: nextId(), type: "table", tf: { x: p[0], y: p[1], sx: 1, sy: 1, rot: 0 }, cells: [["", "", ""], ["", "", ""], ["", "", ""]], sizeMM: 4 }); }
  let polyPts = null;
  function addPolyVertex(p) {
    if (!polyPts) polyPts = [];
    // click near the first vertex closes the polygon
    if (polyPts.length >= 3 && Math.hypot(p[0] - polyPts[0][0], p[1] - polyPts[0][1]) < 2) { finishPoly(true); return; }
    polyPts.push(p); previewPoly();
  }
  function finishPoly(closed) {
    if (polyPts && polyPts.length >= 2) { commitSnapshot(); const segs = centered(poly(polyPts, closed ? 1 : 0)); const c = bounds(poly(polyPts, 0)); addObject({ id: nextId(), type: "polygon", tf: { x: (c.minX + c.maxX) / 2, y: (c.minY + c.maxY) / 2, sx: 1, sy: 1, rot: 0 }, segs }); }
    polyPts = null; gUI.querySelectorAll(".cvTmp").forEach(n => n.remove()); select(null); render(); recomputeAll();
  }
  function previewPoly() {
    gUI.querySelectorAll(".cvTmp").forEach(n => n.remove());
    if (!polyPts || !polyPts.length) return;
    gUI.appendChild(el("polyline", { points: polyPts.map(c => c.join(",")).join(" "), class: "cvTmp", fill: "none" }));
  }
  function previewCreate() {
    gUI.querySelectorAll(".cvTmp").forEach(n => n.remove());
    const a = drag.pts[0], b = drag.pts[drag.pts.length - 1];
    if (drag.t === "line") gUI.appendChild(el("line", { x1: a[0], y1: a[1], x2: b[0], y2: b[1], class: "cvTmp" }));
    else if (drag.t === "ellipse") gUI.appendChild(el("ellipse", { cx: (a[0] + b[0]) / 2, cy: (a[1] + b[1]) / 2, rx: Math.abs(b[0] - a[0]) / 2, ry: Math.abs(b[1] - a[1]) / 2, class: "cvTmp", fill: "none" }));
    else if (drag.t === "pen") gUI.appendChild(el("polyline", { points: drag.pts.map(c => c.join(",")).join(" "), class: "cvTmp", fill: "none" }));
    else gUI.appendChild(el("rect", { x: Math.min(a[0], b[0]), y: Math.min(a[1], b[1]), width: Math.abs(b[0] - a[0]), height: Math.abs(b[1] - a[1]), class: "cvTmp", fill: "none" }));
  }
  function finishCreate() {
    gUI.querySelectorAll(".cvTmp").forEach(n => n.remove());
    const a = drag.pts[0], b = drag.pts[drag.pts.length - 1], t = drag.t;
    if (t === "pen") {
      const pts = decimate(drag.pts, 0.4); if (pts.length < 2) return;
      commitSnapshot(); const c = bounds(poly(pts, 0)), cx = (c.minX + c.maxX) / 2, cy = (c.minY + c.maxY) / 2;
      const local = pts.map(([x, y]) => [x - cx, y - cy]);
      // raw samples kept so the detail knob can re-smooth from the original.
      addObject({ id: nextId(), type: "freehand", tf: { x: cx, y: cy, sx: 1, sy: 1, rot: 0 }, pts: local, rawPts: local.map(p => p.slice()), eps: 0 });
    } else {
      const w = Math.abs(b[0] - a[0]), h = Math.abs(b[1] - a[1]), cx = (a[0] + b[0]) / 2, cy = (a[1] + b[1]) / 2;
      if (t === "line") { if (Math.hypot(b[0] - a[0], b[1] - a[1]) < MINSZ) return; commitSnapshot(); addObject({ id: nextId(), type: "line", tf: { x: cx, y: cy, sx: 1, sy: 1, rot: 0 }, segs: centered([{ op: "M", p: [a] }, { op: "L", p: [b] }]) }); }
      else { if (w < MINSZ && h < MINSZ) return; commitSnapshot(); addObject({ id: nextId(), type: t, tf: { x: cx, y: cy, sx: 1, sy: 1, rot: 0 }, w: Math.max(w, MINSZ), h: Math.max(h, MINSZ) }); }
    }
    // Drawing tools stay active so you can keep drawing; press V or Escape to
    // switch to Select and move or resize what you drew.
    select(null);
    render(); recomputeAll();
  }

  // ---- insert SVG / image ------------------------------------------------
  function insertSVG(text) {
    let segs; try { segs = extractSVG(text); } catch (e) { setStatus("SVG: " + (e.message || e)); return; }
    const b = bounds(segs); if (b.empty) return;
    const sc = Math.max(b.w, b.h) > 0 ? FIT_MM / Math.max(b.w, b.h) : 1;
    const scaled = segs.map(s => mapSeg(s, ([x, y]) => [x * sc, y * sc]));
    commitSnapshot(); addObject({ id: nextId(), type: "svg", tf: { x: PLATE_MM / 2, y: PLATE_MM / 2, sx: 1, sy: 1, rot: 0 }, segs: centered(scaled), eps: 0, raw: centered(scaled) });
    const o = doc.objects[doc.objects.length - 1]; select(o.id); setTool("select"); render(); recomputeAll();
  }
  function insertTrace(segs) {
    const b = bounds(segs); if (b.empty) { setStatus("Trace found nothing"); return; }
    const sc = Math.max(b.w, b.h) > 0 ? FIT_MM / Math.max(b.w, b.h) : 1;
    const scaled = centered(segs.map(s => mapSeg(s, ([x, y]) => [x * sc, y * sc])));
    commitSnapshot(); addObject({ id: nextId(), type: "trace", tf: { x: PLATE_MM / 2, y: PLATE_MM / 2, sx: 1, sy: 1, rot: 0 }, segs: scaled, raw: scaled, eps: 0 });
    const o = doc.objects[doc.objects.length - 1]; select(o.id); setTool("select"); render(); recomputeAll();
  }

  // ---- selection + style toolbar -----------------------------------------
  function select(id) { sel = id; renderUI(); syncStyle(); }
  function setTool(t) { tool = t; document.querySelectorAll("#cvTools [data-tool]").forEach(b => b.classList.toggle("on", b.dataset.tool === t)); if (t !== "poly" && polyPts) finishPoly(false); svg && (svg.style.cursor = t === "select" ? "default" : "crosshair"); }
  function syncStyle() {
    // The bar itself stays in the layout permanently: collapsing it reflowed
    // the page and shifted the plate mid-gesture, so a double-click's second
    // press landed off the object. Only its contextual groups toggle.
    const o = current(), showGroup = marks.length >= 2;
    const gb = document.getElementById("cvGroup"), ub = document.getElementById("cvUngroup");
    if (gb) gb.hidden = !showGroup;
    if (ub) ub.hidden = !(o && o.type === "group");
    const tb = document.getElementById("cvStyleTable");
    if (!o) { document.getElementById("cvStyleText").hidden = true; document.getElementById("cvStyleShape").hidden = true; if (tb) tb.hidden = true; return; }
    const isText = o.type === "text", isTable = o.type === "table", canSimplify = o.type === "svg" || o.type === "trace" || o.type === "freehand";
    document.getElementById("cvStyleText").hidden = !(isText || isTable);
    document.getElementById("cvStyleShape").hidden = !canSimplify;
    if (tb) tb.hidden = !isTable;
    if (isText || isTable) {
      document.getElementById("cvSize").value = o.sizeMM.toFixed(1);
      document.getElementById("cvItalic").classList.toggle("on", !!o.italic);
      document.getElementById("cvUnder").classList.toggle("on", !!o.underline);
    }
    if (canSimplify) document.getElementById("cvDetail").value = o.eps ? Math.min(100, o.eps * 100) : 0;
  }

  // ---- edits -------------------------------------------------------------
  function withObj(fn) { const o = current(); if (!o) return; commitSnapshot(); fn(o); render(); recomputeAll(); }
  function del() { withObj(o => { doc.objects = doc.objects.filter(x => x.id !== o.id); sel = null; }); syncStyle(); }
  function clearAll() { if (!doc.objects.length) return; commitSnapshot(); doc.objects = []; marks = []; sel = null; render(); syncStyle(); recomputeAll(); setStatus("Canvas cleared — undo to restore"); }
  function dup() { const o = current(); if (!o) return; commitSnapshot(); const n = JSON.parse(JSON.stringify(o)); n.id = nextId(); n.tf.x += 4; n.tf.y += 4; doc.objects.push(n); select(n.id); render(); recomputeAll(); }
  function raise(dir) { const i = doc.objects.findIndex(o => o.id === sel); if (i < 0) return; const j = i + dir; if (j < 0 || j >= doc.objects.length) return; commitSnapshot(); const a = doc.objects; [a[i], a[j]] = [a[j], a[i]]; render(); recomputeAll(); }
  function flip(axis) { withObj(o => { if (axis === "h") o.tf.sx *= -1; else o.tf.sy *= -1; }); }

  // ---- grouping ----------------------------------------------------------
  function group() {
    if (marks.length < 2) return;
    const objs = marks.map(id => doc.objects.find(o => o.id === id)).filter(Boolean);
    if (objs.length < 2) return;
    commitSnapshot();
    const all = [];
    for (const o of objs) { const m = affine(o.tf); for (const s of localPaths(o)) all.push(mapSeg(s, p => apply(m, p))); }
    const b = bounds(all), cx = (b.minX + b.maxX) / 2, cy = (b.minY + b.maxY) / 2;
    const children = objs.map(o => { const c = JSON.parse(JSON.stringify(o)); c.tf.x -= cx; c.tf.y -= cy; return c; });
    const ids = new Set(marks); doc.objects = doc.objects.filter(o => !ids.has(o.id));
    const g = { id: nextId(), type: "group", tf: { x: cx, y: cy, sx: 1, sy: 1, rot: 0 }, children };
    doc.objects.push(g); marks = []; select(g.id); render(); recomputeAll();
  }
  function ungroup() {
    const g = current(); if (!g || g.type !== "group") return;
    commitSnapshot();
    const gm = affine(g.tf), i = doc.objects.findIndex(o => o.id === g.id);
    const kids = g.children.map(ch => {
      const c = JSON.parse(JSON.stringify(ch)); c.id = nextId();
      const wp = apply(gm, [ch.tf.x, ch.tf.y]);
      c.tf.x = wp[0]; c.tf.y = wp[1];
      c.tf.rot = (g.tf.rot || 0) + (ch.tf.rot || 0);
      c.tf.sx = (g.tf.sx || 1) * (ch.tf.sx || 1); c.tf.sy = (g.tf.sy || 1) * (ch.tf.sy || 1);
      return c;
    });
    doc.objects.splice(i, 1, ...kids); marks = []; sel = kids.length ? kids[kids.length - 1].id : null;
    render(); syncStyle(); recomputeAll();
  }

  // ---- in-place text editing ---------------------------------------------
  function onDbl(ev) {
    // Fall back to the object the gesture's first press hit: any residual
    // layout shift between the presses must not break double-click-to-edit.
    const id = pickAt(toMM(ev)) || lastDownId; if (!id) return;
    const o = doc.objects.find(x => x.id === id); if (!o) return;
    if (o.type === "table") {
      ev.preventDefault(); marks = []; select(id);
      const { r, c } = cellAt(o, ...toLocal(o, toMM(ev)));
      openCell(o, r, c);
      return;
    }
    if (o.type !== "text") return;
    ev.preventDefault(); marks = []; select(id); openInline(o);
  }
  // Edit a text object in place, on the plate: a textarea centred over the
  // object, sized to roughly match the engraved text. Enter adds a line
  // (text objects are multiline); Esc or clicking away commits. An object
  // left empty is dropped.
  // In-place text editing with a real on-plate caret (drawn in the SVG by
  // renderUI). A transparent textarea over the object captures the keyboard
  // and owns the cursor/selection natively — its own caret is hidden — while
  // o.str and the caret index are mirrored into the render.
  function openInline(o) {
    if (editId === o.id && editTA) { editTA.focus({ preventScroll: true }); return; }
    // Close any open editor directly: relying on the focus shift to blur
    // it lets its not-yet-settled guard steal focus back mid-chain.
    if (closeEdit) closeEdit();
    editCell = null;
    const stage = svg.parentElement; stage.style.position = "relative";
    const ta = document.createElement("textarea"); ta.className = "cvInline"; ta.value = o.str;
    ta.wrap = "off"; ta.spellcheck = false;
    stage.appendChild(ta);
    const px = svg.getBoundingClientRect().width / PLATE_MM;
    const c = apply(affine(o.tf), [0, 0]), he = halfExtent(o);
    ta.style.left = c[0] * px + "px"; ta.style.top = c[1] * px + "px";
    ta.style.transform = "translate(-50%,-50%)";
    ta.style.width = Math.max(28, (he.hw * 2 + 6) * px) + "px";
    ta.style.height = Math.max(20, (Math.max(o.sizeMM, he.hh * 2) + 4) * px) + "px";
    editId = o.id; editCaret = o.str.length; editTA = ta;
    // Focus survival: the triggering click's default focus action (and any
    // late layout) can land after us and blur the editor. Take focus now and
    // again next frame, and until the opening settles treat a blur as that
    // steal — re-take focus instead of committing.
    const takeFocus = () => { ta.focus({ preventScroll: true }); const n = ta.value.length; ta.setSelectionRange(n, n); };
    let settled = false;
    requestAnimationFrame(() => requestAnimationFrame(() => { settled = true; }));
    takeFocus(); requestAnimationFrame(takeFocus);
    const sync = () => {
      stripGlyphless(ta, true);
      // the caret sits at the moving end of a selection, not always its start
      editCaret = ta.selectionDirection === "backward" ? ta.selectionStart : ta.selectionEnd;
      if (o.str !== ta.value) { o.str = ta.value; recomputeAll(); }
      render();
    };
    render();
    ta.oninput = sync; ta.onkeyup = sync; ta.onclick = sync; ta.onselect = sync;
    // removing a focused textarea fires one more blur mid-removal, so
    // drop detaches the handler first
    const drop = () => { ta.onblur = null; if (ta.parentNode) ta.remove(); };
    const close = () => {
      if (editTA !== ta) { drop(); return; }
      editId = null; editTA = null; editDrag = null; closeEdit = null; drop();
      if (!o.str.trim()) { doc.objects = doc.objects.filter(x => x !== o); if (sel === o.id) sel = null; }
      commitSnapshot(); render(); syncStyle(); recomputeAll();
    };
    closeEdit = close;
    ta.onblur = () => {
      // a stale editor's late blur must not clobber a newer session's
      // state — and must never re-take focus, so staleness wins over
      // the not-yet-settled focus-steal guard
      if (editTA !== ta) { drop(); return; }
      if (!settled) { takeFocus(); return; }
      close();
    };
    ta.onkeydown = e => {
      e.stopPropagation();
      if (e.key === "Escape") { e.preventDefault(); ta.blur(); return; }
      // standard shortcuts: Ctrl/Cmd+I italic, Ctrl/Cmd+U underline
      if ((e.ctrlKey || e.metaKey) && (e.key === "i" || e.key === "u")) { e.preventDefault(); toggleStyleRun(e.key === "i" ? "*" : "_"); }
    };
  }

  // Edit one table cell in place: the same transparent-capture pattern as
  // openInline, scoped to a single-line cell string. Tab and Enter walk
  // the grid (Tab past the last cell grows a row), and the caret is drawn
  // in the cell's frame by renderUI.
  function openCell(o, r, c) {
    if (editTA && editId === o.id && editCell && editCell.r === r && editCell.c === c) { editTA.focus({ preventScroll: true }); return; }
    // Commit + close the open editor directly. blur() is not enough:
    // an editor still inside its focus-settle window would swallow the
    // blur and steal focus back, so rapid Tab/Enter chains dropped
    // steps and typed into the superseded cell.
    if (closeEdit) closeEdit();
    const stage = svg.parentElement; stage.style.position = "relative";
    const ta = document.createElement("textarea"); ta.className = "cvInline";
    ta.value = (o.cells[r] || [])[c] || "";
    ta.wrap = "off"; ta.spellcheck = false;
    stage.appendChild(ta);
    const placeTA = () => {
      const px = svg.getBoundingClientRect().width / PLATE_MM;
      const co = cellOrigin(o, r, c), w = apply(affine(o.tf), [co.x, co.y + o.sizeMM / 2]);
      ta.style.left = w[0] * px + "px"; ta.style.top = w[1] * px + "px";
      ta.style.transform = "translate(0,-50%)";
      ta.style.width = Math.max(28, (measureVis(ta.value, o.sizeMM / SH.height) + 4) * px) + "px";
      ta.style.height = Math.max(20, (o.sizeMM + 2) * px) + "px";
    };
    placeTA();
    editId = o.id; editCell = { r, c }; editCaret = ta.value.length; editTA = ta;
    const takeFocus = () => { ta.focus({ preventScroll: true }); const n = ta.value.length; ta.setSelectionRange(n, n); };
    let settled = false;
    requestAnimationFrame(() => requestAnimationFrame(() => { settled = true; }));
    takeFocus(); requestAnimationFrame(takeFocus);
    const sync = () => {
      stripGlyphless(ta, false); // no glyph, no newline in a cell
      editCaret = ta.selectionDirection === "backward" ? ta.selectionStart : ta.selectionEnd;
      const v = ta.value;
      if (((o.cells[r] || [])[c] || "") !== v) { o.cells[r][c] = v; placeTA(); recomputeAll(); }
      render();
    };
    render();
    ta.oninput = sync; ta.onkeyup = sync; ta.onclick = sync; ta.onselect = sync;
    const drop = () => { ta.onblur = null; if (ta.parentNode) ta.remove(); };
    const close = () => {
      if (editTA !== ta) { drop(); return; }
      editId = null; editTA = null; editCell = null; editDrag = null; closeEdit = null; drop();
      commitSnapshot(); render(); syncStyle(); recomputeAll();
    };
    closeEdit = close;
    ta.onblur = () => {
      // staleness first: a superseded editor must never re-take focus
      if (editTA !== ta) { drop(); return; }
      if (!settled) { takeFocus(); return; }
      close();
    };
    ta.onkeydown = e => {
      e.stopPropagation();
      if (e.key === "Escape") { e.preventDefault(); ta.blur(); return; }
      if (e.key === "Tab") {
        e.preventDefault();
        const m = tableMetrics(o), d = e.shiftKey ? -1 : 1;
        let i = r * m.cols + c + d;
        if (i < 0) return;
        if (i >= m.rows * m.cols) { commitSnapshot(); o.cells.push(o.cells[0].map(() => "")); }
        openCell(o, Math.floor(i / m.cols), i % m.cols);
        return;
      }
      if (e.key === "Enter") {
        e.preventDefault();
        if (r + 1 >= o.cells.length) { commitSnapshot(); o.cells.push(o.cells[0].map(() => "")); }
        openCell(o, r + 1, c);
        return;
      }
      if ((e.ctrlKey || e.metaKey) && (e.key === "i" || e.key === "u")) { e.preventDefault(); toggleStyleRun(e.key === "i" ? "*" : "_"); }
    };
  }

  // Toggle italic (*) or underline (_) over the editor's selected range —
  // standard select-then-style editing. The transform works on the marker-
  // stripped character sequence: if the whole selection already carries the
  // style, it is removed, otherwise applied to all of it, and the string is
  // rebuilt with minimal markers (styling resets at each newline, matching
  // splitFmt's per-line parsing). With no selection the object's whole-field
  // toggle applies, same as when not editing.
  function toggleStyleRun(m) {
    const o = doc.objects.find(x => x.id === editId);
    if (!o || !editTA) return;
    const selA = Math.min(editTA.selectionStart, editTA.selectionEnd);
    const selB = Math.max(editTA.selectionStart, editTA.selectionEnd);
    if (selA === selB) {
      // no selection: whole-field toggle for text; cells style by range only
      if (!editCell) { withObj(x => { const f = m === "*" ? "italic" : "underline"; x[f] = !x[f]; }); syncStyle(); }
      editTA.focus({ preventScroll: true }); return;
    }
    const s = editTA.value;
    // strip this marker, tracking each kept char's style parity and raw origin
    const chars = [], styled = [], rawOf = []; let on = false;
    for (let i = 0; i < s.length; i++) {
      const c = s[i];
      if (c === m) { on = !on; continue; }
      if (c === "\n") on = false;
      chars.push(c); styled.push(on); rawOf.push(i);
    }
    let ka = 0, kb = 0;
    for (let i = 0; i < rawOf.length; i++) { if (rawOf[i] < selA) ka++; if (rawOf[i] < selB) kb++; }
    if (ka === kb) return;
    // "already styled" looks only at real text: newlines and the other
    // style's markers are zero-width markup, not characters to style
    const other = m === "*" ? "_" : "*";
    let all = true;
    for (let i = ka; i < kb; i++) if (chars[i] !== "\n" && chars[i] !== other && !styled[i]) { all = false; break; }
    for (let i = ka; i < kb; i++) if (chars[i] !== "\n") styled[i] = !all;
    // rebuild with markers at style transitions, re-opening after newlines
    let out = "", cur = false, newA = -1, newB = -1;
    for (let i = 0; i < chars.length; i++) {
      if (i === ka) newA = out.length;
      if (chars[i] === "\n") { out += "\n"; cur = false; continue; }
      if (styled[i] !== cur) { out += m; cur = !cur; }
      out += chars[i];
    }
    if (newA < 0) newA = out.length;
    newB = kb >= chars.length ? out.length : (() => { let n = 0, seen = 0; for (; n < out.length && seen < kb; n++) if (out[n] !== m) seen++; return n; })();
    commitSnapshot();
    if (editCell) o.cells[editCell.r][editCell.c] = out; else o.str = out;
    editTA.value = out;
    editTA.setSelectionRange(newA, newB); editCaret = newB;
    editTA.focus({ preventScroll: true });
    render(); recomputeAll();
  }

  // ---- simplify + auto-fit -----------------------------------------------
  function rdp(points, eps) {
    if (points.length < 3) return points;
    let dmax = 0, idx = 0; const a = points[0], b = points[points.length - 1];
    for (let i = 1; i < points.length - 1; i++) { const d = segDist(points[i], a, b); if (d > dmax) { dmax = d; idx = i; } }
    if (dmax > eps) { const l = rdp(points.slice(0, idx + 1), eps), r = rdp(points.slice(idx), eps); return l.slice(0, -1).concat(r); }
    return [a, b];
  }
  function segDist(p, a, b) { const dx = b[0] - a[0], dy = b[1] - a[1], L = dx * dx + dy * dy; if (!L) return Math.hypot(p[0] - a[0], p[1] - a[1]); let t = ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / L; t = Math.max(0, Math.min(1, t)); return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy)); }
  // simplify a segs array (M/L runs) by RDP per subpath; curve segs pass through
  function simplifySegs(segs, eps) {
    if (!eps) return segs;
    const out = []; let run = null;
    const flush = () => { if (run && run.length > 1) { const r = rdp(run, eps); out.push({ op: "M", p: [r[0]] }); for (let i = 1; i < r.length; i++) out.push({ op: "L", p: [r[i]] }); } else if (run && run.length === 1) out.push({ op: "M", p: [run[0]] }); run = null; };
    for (const s of segs) {
      if (s.op === "M") { flush(); run = [s.p[0]]; }
      else if (s.op === "L" && run) run.push(s.p[0]);
      else { flush(); out.push(s); }
    }
    flush(); return out;
  }
  function setDetail(pct) { withObj(o => { o.eps = pct / 100; if (o.type === "freehand") o.pts = o.eps > 0 ? rdp(o.rawPts || o.pts, o.eps) : (o.rawPts || o.pts); else o.segs = simplifySegs(o.raw || o.segs, o.eps); }); }
  function decimate(pts, min) { const out = [pts[0]]; for (const p of pts) { const q = out[out.length - 1]; if (Math.hypot(p[0] - q[0], p[1] - q[1]) >= min) out.push(p); } return out; }
  function autoFit() {
    // bisect a global simplify epsilon on graphics objects until under caps
    const heavy = doc.objects.filter(o => o.raw);
    if (!heavy.length) { setStatus("Nothing to simplify"); return; }
    commitSnapshot();
    let lo = 0, hi = 4;
    for (let it = 0; it < 16; it++) {
      const eps = (lo + hi) / 2;
      heavy.forEach(o => { o.eps = eps; o.segs = simplifySegs(o.raw, eps); });
      const bytes = encodePath(worldSegs()).length;
      if (bytes > SH.payloadCap) lo = eps; else hi = eps;
    }
    heavy.forEach(o => { o.eps = hi; o.segs = simplifySegs(o.raw, hi); });
    render(); recomputeAll(); syncStyle(); setStatus(`Auto-fit at ε=${hi.toFixed(2)}mm`);
  }

  // ---- undo / persistence ------------------------------------------------
  function snap() { return JSON.stringify(doc); }
  function commitSnapshot() { if (suppressSnapshot) return; undo.push(snap()); if (undo.length > UNDO_MAX) undo.shift(); redo.length = 0; }
  function doUndo() { if (!undo.length) return; redo.push(snap()); doc = JSON.parse(undo.pop()); afterRestore(); }
  function doRedo() { if (!redo.length) return; undo.push(snap()); doc = JSON.parse(redo.pop()); afterRestore(); }
  function afterRestore() { counter = doc.objects.reduce((m, o) => Math.max(m, +(o.id.slice(1)) || 0), 0); if (!doc.objects.find(o => o.id === sel)) sel = null; render(); syncStyle(); recomputeAll(); }
  let saveT = null;
  function persist() { clearTimeout(saveT); saveT = setTimeout(() => { try { localStorage.setItem("shstudio.canvas", snap()); } catch (e) {} }, 400); }

  async function shareURL() {
    const json = snap();
    let hash;
    if (window.CompressionStream) {
      const cs = new CompressionStream("deflate-raw"), w = cs.writable.getWriter();
      w.write(new TextEncoder().encode(json)); w.close();
      const buf = new Uint8Array(await new Response(cs.readable).arrayBuffer());
      hash = "z" + b64url(buf);
    } else hash = "j" + b64url(new TextEncoder().encode(json));
    location.hash = "canvas=" + hash;
    navigator.clipboard && navigator.clipboard.writeText(location.href).then(() => setStatus("Share link copied ✓"), () => {});
  }
  async function fromHash() {
    const m = /canvas=([zj])([A-Za-z0-9\-_]+)/.exec(location.hash); if (!m) return false;
    try {
      let bytes = ub64url(m[2]);
      if (m[1] === "z" && window.DecompressionStream) { const ds = new DecompressionStream("deflate-raw"), w = ds.writable.getWriter(); w.write(bytes); w.close(); bytes = new Uint8Array(await new Response(ds.readable).arrayBuffer()); }
      doc = JSON.parse(new TextDecoder().decode(bytes)); return true;
    } catch (e) { return false; }
  }
  function b64url(bytes) { let s = ""; for (const b of bytes) s += String.fromCharCode(b); return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""); }
  function ub64url(s) { s = s.replace(/-/g, "+").replace(/_/g, "/"); const bin = atob(s); const u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); return u; }

  // ---- document files ----------------------------------------------------
  // The share hash and localStorage already serialize the document; Save and
  // Open are file IO around the same JSON, pretty-printed so the files diff.
  // The curves Download stays what it is: the compiled wire payload, which
  // cannot be loaded back — these can.
  const DOC_TYPES = new Set(["text", "table", "rect", "ellipse", "line", "freehand", "polygon", "svg", "trace", "group"]);
  function saveFile() {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([JSON.stringify(doc, null, 1)], { type: "application/json" }));
    a.download = "plate.shcanvas"; a.click();
  }
  function openFile(f) {
    f.text().then(t => {
      let d; try { d = JSON.parse(t); } catch (e) { d = null; }
      if (!d || d.v !== 1 || !Array.isArray(d.objects)) { setStatus("Open: not a canvas document"); return; }
      const unknown = (function walk(list) { for (const o of list) { if (!o || !DOC_TYPES.has(o.type)) return (o && o.type) || "?"; if (o.type === "group") { const u = walk(o.children || []); if (u) return u; } } return null; })(d.objects);
      if (unknown) { setStatus(`Open: unknown object type "${unknown}"`); return; }
      commitSnapshot(); // Open is undoable
      doc = { v: 1, objects: d.objects };
      afterRestore(); setStatus("Opened ✓");
    });
  }

  // ---- preview / gauge bridge --------------------------------------------
  let previewT = null;
  function previewDebounced() { clearTimeout(previewT); previewT = setTimeout(recomputeAll, 60); }
  function recomputeAll() { persist(); if (typeof recompute === "function" && mode() === "canvas") recompute(); }
  function mode() { const t = document.querySelector("[role=tab][aria-selected=true]"); return t ? t.dataset.mode : ""; }
  function setStatus(m) { const s = document.getElementById("status"); if (s) s.textContent = m; }

  // ---- keyboard ----------------------------------------------------------
  function onKey(e) {
    if (mode() !== "canvas") return;
    const tag = (e.target.tagName || "").toLowerCase();
    if (tag === "input" || tag === "textarea") return;
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "z") { e.preventDefault(); e.shiftKey ? doRedo() : doUndo(); return; }
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "g") { e.preventDefault(); e.shiftKey ? ungroup() : group(); return; }
    if (e.key === "Delete" || e.key === "Backspace") { if (current()) { e.preventDefault(); del(); } return; }
    const step = e.shiftKey ? 5 : 1;
    if (current() && e.key.startsWith("Arrow")) { e.preventDefault(); commitSnapshot(); const o = current(); if (e.key === "ArrowLeft") o.tf.x -= step; if (e.key === "ArrowRight") o.tf.x += step; if (e.key === "ArrowUp") o.tf.y -= step; if (e.key === "ArrowDown") o.tf.y += step; render(); recomputeAll(); return; }
    const keys = { v: "select", t: "text", b: "table", r: "rect", o: "ellipse", l: "line", p: "pen", g: "poly" };
    if (keys[e.key.toLowerCase()]) setTool(keys[e.key.toLowerCase()]);
    if (e.key === "Enter" && polyPts) finishPoly(polyPts.length >= 3);
    if (e.key === "Escape") { polyPts = null; gUI.querySelectorAll(".cvTmp").forEach(n => n.remove()); select(null); setTool("select"); }
  }

  // ---- boot --------------------------------------------------------------
  async function init() {
    svg = document.getElementById("cv"); if (!svg) return;
    gObjs = document.getElementById("cvObjs"); gUI = document.getElementById("cvUI");
    svg.addEventListener("pointerdown", onDown);
    svg.addEventListener("pointermove", onMove);
    svg.addEventListener("dblclick", onDbl);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("keydown", onKey);
    document.querySelectorAll("#cvTools [data-tool]").forEach(b => b.onclick = () => setTool(b.dataset.tool));
    // toolbar buttons
    // Every generic toolbar action first commits an open text editor.
    // Relying on the click's implicit blur is not portable: Safari and
    // Firefox on macOS do not focus (or blur) on button mousedown, so
    // Delete/Undo/Clear could act with the editor still live. blur() is
    // synchronous, so the commit lands before fn runs.
    const on = (id, fn) => { const e = document.getElementById(id); if (e) e.onclick = (...a) => { if (closeEdit) closeEdit(); fn(...a); }; };
    on("cvUndo", doUndo); on("cvRedo", doRedo);
    on("cvDel", del); on("cvDup", dup); on("cvFwd", () => raise(1)); on("cvBack", () => raise(-1));
    on("cvFlipH", () => flip("h")); on("cvFlipV", () => flip("v"));
    on("cvGroup", group); on("cvUngroup", ungroup);
    // While editing, i/U style the selected range (and must not steal the
    // editor's focus on mousedown); otherwise they toggle the whole field.
    const styleBtn = (id, marker, field) => {
      const b = document.getElementById(id); if (!b) return;
      b.addEventListener("mousedown", e => { if (editId != null) e.preventDefault(); });
      b.addEventListener("click", () => {
        if (editId != null && editTA) { toggleStyleRun(marker); return; }
        // whole-field style is a text-object concept; table cells style
        // by selection inside the cell editor
        const o = current(); if (!o || o.type !== "text") return;
        withObj(x => x[field] = !x[field]); syncStyle();
      });
    };
    styleBtn("cvItalic", "*", "italic");
    styleBtn("cvUnder", "_", "underline");
    // table rows and columns; the last row/column must survive
    const tmod = fn => withObj(o => { if (o.type === "table") fn(o); });
    on("cvRowAdd", () => tmod(o => o.cells.push(o.cells[0].map(() => ""))));
    on("cvRowDel", () => tmod(o => { if (o.cells.length > 1) o.cells.pop(); }));
    on("cvColAdd", () => tmod(o => o.cells.forEach(r => r.push(""))));
    on("cvColDel", () => tmod(o => { if (o.cells[0].length > 1) o.cells.forEach(r => r.pop()); }));
    on("cvAutoFit", autoFit); on("cvShare", shareURL); on("cvClear", clearAll);
    on("cvSave", saveFile);
    on("cvOpen", () => document.getElementById("cvDocFile").click());
    const df = document.getElementById("cvDocFile"); if (df) df.onchange = e => { const f = e.target.files[0]; if (f) openFile(f); e.target.value = ""; };
    const sz = document.getElementById("cvSize"); if (sz) sz.oninput = () => withObj(o => o.sizeMM = Math.max(3, parseFloat(sz.value) || o.sizeMM));
    const det = document.getElementById("cvDetail"); if (det) det.oninput = () => setDetail(parseFloat(det.value));
    on("cvSvg", () => document.getElementById("cvSvgFile").click());
    on("cvImg", () => document.getElementById("cvImgFile").click());
    const sf = document.getElementById("cvSvgFile"); if (sf) sf.onchange = e => { const f = e.target.files[0]; if (f) f.text().then(insertSVG); e.target.value = ""; };
    const imf = document.getElementById("cvImgFile"); if (imf) imf.onchange = e => { const f = e.target.files[0]; if (f) traceFile(f); e.target.value = ""; };
    // restore: hash beats localStorage
    if (!(await fromHash())) { try { const s = localStorage.getItem("shstudio.canvas"); if (s) doc = JSON.parse(s); } catch (e) {} }
    counter = doc.objects.reduce((m, o) => Math.max(m, +(o.id.slice(1)) || 0), 0);
    setTool("select"); render();
  }

  // ---- image tracer (see tracer.js) --------------------------------------
  function traceFile(f) {
    if (!window.Tracer) { setStatus("Tracer unavailable"); return; }
    const modeSel = document.getElementById("cvTraceMode");
    setStatus("Tracing…");
    window.Tracer.trace(f, { mode: modeSel ? modeSel.value : "auto", detail: 1 })
      .then(segs => { insertTrace(segs); setStatus(segs.mode ? "traced as " + segs.mode : ""); })
      .catch(e => setStatus("Trace: " + (e.message || e)));
  }

  return { init, worldSegs, worldGroups, segs: worldSegs, refresh: () => { render(); syncStyle(); recomputeAll(); }, insertSVG, insertTrace, _doc: () => doc };
})();
document.addEventListener("DOMContentLoaded", () => window.Canvas.init());
