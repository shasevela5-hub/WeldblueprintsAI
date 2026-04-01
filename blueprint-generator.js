// blueprint-generator.js
// Professional technical drawing generator for welding blueprints
// Requires: pdfkit (npm install pdfkit)

class BlueprintGenerator {
  constructor(doc, project, dimensions, welder, process, settings) {
    this.doc = doc;
    this.project = project;
    this.welder = welder || '';
    this.process = process || 'MIG';
    this.settings = settings || {};

    const dims = (dimensions || '36x24x34').split('x').map(Number);
    this.L = dims[0] || 36;  // Length
    this.W = dims[1] || 24;  // Width
    this.H = dims[2] || 34;  // Height

    // Page dimensions (A3 landscape = 1190.6 x 841.9 pts, Letter landscape = 792 x 612)
    // We use Letter landscape for compatibility
    this.PW = doc.page.width;   // page width
    this.PH = doc.page.height;  // page height

    // Color palette — classic blueprint engineering drawing style
    this.BG       = '#001F3F';  // deep navy background
    this.GRID     = '#002F5C';  // subtle grid lines
    this.LINE     = '#E8EEF4';  // main object lines (near white)
    this.HIDDEN   = '#6FA8D0';  // hidden lines (lighter blue)
    this.DIM      = '#FFD700';  // dimension lines & text (gold)
    this.SECTION  = '#00E5CC';  // section / weld symbols (cyan)
    this.TEXT     = '#E8EEF4';  // general annotation text
    this.TITLE_BG = '#001229';  // title block background
    this.ORANGE   = '#FF5E1A';  // accent / brand

    // Drawing margins
    this.ML = 28;  // margin left
    this.MR = 28;  // margin right
    this.MT = 28;  // margin top
    this.MB = 28;  // margin bottom

    // Title block height (bottom strip)
    this.TB_H = 90;

    // Drawing area
    this.DA_X = this.ML + 8;
    this.DA_Y = this.MT + 8;
    this.DA_W = this.PW - this.ML - this.MR - 16;
    this.DA_H = this.PH - this.MT - this.MB - this.TB_H - 16;
  }

  // ─── UTILITY ───────────────────────────────────────────────────────────────

  // Draw a line with optional dash pattern
  line(x1, y1, x2, y2, { color = this.LINE, width = 1, dash = null } = {}) {
    const d = this.doc;
    d.save();
    d.strokeColor(color).lineWidth(width);
    if (dash) d.dash(dash[0], { space: dash[1] });
    d.moveTo(x1, y1).lineTo(x2, y2).stroke();
    d.restore();
  }

  // Draw arrowhead at (tx, ty) pointing from (fx, fy)
  arrowhead(fx, fy, tx, ty, { color = this.DIM, size = 5 } = {}) {
    const d = this.doc;
    const angle = Math.atan2(ty - fy, tx - fx);
    const a1 = angle + Math.PI * 0.82;
    const a2 = angle - Math.PI * 0.82;
    d.save();
    d.fillColor(color)
     .moveTo(tx, ty)
     .lineTo(tx + size * Math.cos(a1), ty + size * Math.sin(a1))
     .lineTo(tx + size * Math.cos(a2), ty + size * Math.sin(a2))
     .closePath()
     .fill();
    d.restore();
  }

  // Draw a complete dimension line: extension lines + arrow line + label
  // axis: 'h' (horizontal) or 'v' (vertical)
  // offset: how far the dim line sits from the object edge
  dimension(x1, y1, x2, y2, label, { axis = 'h', offset = 22, color = this.DIM, fontSize = 7 } = {}) {
    const d = this.doc;
    const EXT = 4;   // extension line overshoot past dim line
    const GAP = 3;   // gap between object and start of extension line

    if (axis === 'h') {
      // Horizontal dimension — dim line runs horizontally below/above the object
      const dimY = y1 + offset;
      // Extension lines
      this.line(x1, y1 + GAP, x1, dimY + EXT, { color, width: 0.6 });
      this.line(x2, y2 + GAP, x2, dimY + EXT, { color, width: 0.6 });
      // Dim line
      this.line(x1, dimY, x2, dimY, { color, width: 0.7 });
      // Arrowheads
      this.arrowhead(x2, dimY, x1, dimY, { color });
      this.arrowhead(x1, dimY, x2, dimY, { color });
      // Label (centered on dim line, on white pill)
      const midX = (x1 + x2) / 2;
      d.save();
      d.fontSize(fontSize).fillColor(color).font('Courier-Bold');
      const tw = d.widthOfString(label);
      d.fillColor(this.BG).rect(midX - tw / 2 - 2, dimY - fontSize / 2 - 1, tw + 4, fontSize + 2).fill();
      d.fillColor(color).text(label, midX - tw / 2, dimY - fontSize / 2, { lineBreak: false });
      d.restore();

    } else {
      // Vertical dimension — dim line runs vertically to the left/right
      const dimX = x1 - offset;
      this.line(x1 - GAP, y1, dimX - EXT, y1, { color, width: 0.6 });
      this.line(x2 - GAP, y2, dimX - EXT, y2, { color, width: 0.6 });
      this.line(dimX, y1, dimX, y2, { color, width: 0.7 });
      this.arrowhead(dimX, y2, dimX, y1, { color });
      this.arrowhead(dimX, y1, dimX, y2, { color });
      const midY = (y1 + y2) / 2;
      d.save();
      d.fontSize(fontSize).fillColor(color).font('Courier-Bold');
      const tw = d.widthOfString(label);
      // Rotate text 90° for vertical dims
      d.fillColor(this.BG).rect(dimX - fontSize / 2 - 1, midY - tw / 2 - 2, fontSize + 2, tw + 4).fill();
      d.rotate(-90, { origin: [dimX, midY] });
      d.fillColor(color).text(label, dimX - tw / 2, midY - fontSize / 2, { lineBreak: false });
      d.restore();
    }
  }

  // Center-line tick cross (used for hole centers, etc.)
  centerMark(cx, cy, { size = 6, color = this.SECTION } = {}) {
    this.line(cx - size, cy, cx + size, cy, { color, width: 0.5, dash: [2, 2] });
    this.line(cx, cy - size, cx, cy + size, { color, width: 0.5, dash: [2, 2] });
  }

  // Fillet weld symbol at a corner
  weldSymbol(x, y, size = '1/4"', { color = this.SECTION } = {}) {
    const d = this.doc;
    d.save();
    // Leader line
    d.strokeColor(color).lineWidth(0.7)
     .moveTo(x, y).lineTo(x + 18, y - 12).stroke();
    // Reference line
    d.moveTo(x + 18, y - 12).lineTo(x + 46, y - 12).stroke();
    // Fillet triangle
    d.fillColor(color)
     .moveTo(x + 18, y - 12)
     .lineTo(x + 18 + 7, y - 12)
     .lineTo(x + 18, y - 12 - 7)
     .closePath().fill();
    // Size text
    d.fontSize(6.5).fillColor(color).font('Courier-Bold')
     .text(size, x + 27, y - 19, { lineBreak: false });
    d.restore();
  }

  // ─── BACKGROUND & BORDER ───────────────────────────────────────────────────

  drawBackground() {
    const d = this.doc;
    const { PW, PH, ML, MR, MT, MB, TB_H, GRID, BG, LINE } = this;

    // Background fill
    d.rect(0, 0, PW, PH).fill(BG);

    // Grid — subtle
    d.save();
    d.strokeColor(GRID).lineWidth(0.3);
    for (let x = ML; x < PW - MR; x += 20) {
      d.moveTo(x, MT).lineTo(x, PH - MB).stroke();
    }
    for (let y = MT; y < PH - MB; y += 20) {
      d.moveTo(ML, y).lineTo(PW - MR, y).stroke();
    }
    d.restore();

    // Outer border
    d.save();
    d.strokeColor(LINE).lineWidth(1.8)
     .rect(ML, MT, PW - ML - MR, PH - MT - MB).stroke();
    // Inner border (drawing area frame)
    d.lineWidth(0.8)
     .rect(ML + 8, MT + 8, PW - ML - MR - 16, PH - MT - MB - TB_H - 16).stroke();
    d.restore();

    // Zone letters along top/bottom border (A B C D E F ...)
    const zones = Math.floor((PW - ML - MR) / 80);
    for (let i = 0; i < zones; i++) {
      const zx = ML + 8 + i * ((PW - ML - MR - 16) / zones) + (PW - ML - MR - 16) / zones / 2;
      d.fontSize(7).fillColor(LINE).font('Courier')
       .text(String.fromCharCode(65 + i), zx - 3, MT + 1, { lineBreak: false })
       .text(String.fromCharCode(65 + i), zx - 3, PH - MB - TB_H - 13, { lineBreak: false });
    }
    // Zone numbers along left/right border
    const zoneRows = Math.floor((PH - MT - MB - TB_H) / 80);
    for (let i = 0; i < zoneRows; i++) {
      const zy = MT + 8 + i * ((PH - MT - MB - TB_H - 16) / zoneRows) + (PH - MT - MB - TB_H - 16) / zoneRows / 2;
      d.text(String(i + 1), ML + 1, zy - 3, { lineBreak: false })
       .text(String(i + 1), PW - MR - 10, zy - 3, { lineBreak: false });
    }
  }

  // ─── TITLE BLOCK ───────────────────────────────────────────────────────────

  drawTitleBlock() {
    const d = this.doc;
    const { PW, PH, ML, MR, MB, TB_H, LINE, TEXT, TITLE_BG, ORANGE, DIM } = this;

    const tbY = PH - MB - TB_H;
    const tbX = ML;
    const tbW = PW - ML - MR;

    // Background
    d.rect(tbX, tbY, tbW, TB_H).fill(TITLE_BG);
    d.save().strokeColor(LINE).lineWidth(1.2)
     .rect(tbX, tbY, tbW, TB_H).stroke().restore();

    // Vertical dividers — split into 5 columns
    const cols = [0, 0.22, 0.44, 0.62, 0.78, 1.0];
    cols.forEach(f => {
      if (f > 0 && f < 1) {
        this.line(tbX + tbW * f, tbY, tbX + tbW * f, PH - MB, { color: LINE, width: 0.6 });
      }
    });

    // Horizontal mid-line in title block
    this.line(tbX, tbY + TB_H / 2, tbX + tbW, tbY + TB_H / 2, { color: LINE, width: 0.5 });

    const label = (txt, x, y) => {
      d.fontSize(6).fillColor(LINE).font('Courier').text(txt, x, y, { lineBreak: false });
    };
    const value = (txt, x, y, { color = TEXT, size = 8, bold = false } = {}) => {
      d.fontSize(size).fillColor(color).font(bold ? 'Courier-Bold' : 'Courier')
       .text(txt, x, y, { lineBreak: false });
    };

    const row1Y = tbY + 5;
    const row2Y = tbY + TB_H / 2 + 5;
    const col = (i) => tbX + tbW * cols[i] + 6;

    // Col 0 — Company / Logo
    value('WELDBLUEPRINTS AI', col(0), row1Y, { color: ORANGE, size: 9, bold: true });
    label('ENGINEERING DIVISION', col(0), row1Y + 13);
    label('FABRICATION DRAWING', col(0), row2Y);
    value('WB SERIES', col(0), row2Y + 10, { size: 7 });

    // Col 1 — Title
    label('PROJECT TITLE', col(1), row1Y);
    value(this.project.toUpperCase(), col(1), row1Y + 10, { size: 11, bold: true, color: TEXT });
    label('DESCRIPTION', col(1), row2Y);
    value(`${this.L}" L × ${this.W}" W × ${this.H}" H`, col(1), row2Y + 10, { size: 8, color: DIM });

    // Col 2 — Welder / Process
    label('WELDER MODEL', col(2), row1Y);
    value(this.welder || '—', col(2), row1Y + 10, { size: 8 });
    label('PROCESS', col(2), row2Y);
    value(this.process || '—', col(2), row2Y + 10, { size: 8 });

    // Col 3 — Drawing info
    const dwgNo = `WB-${Date.now().toString().slice(-6)}`;
    label('DWG NO.', col(3), row1Y);
    value(dwgNo, col(3), row1Y + 10, { size: 8, bold: true });
    label('SCALE', col(3), row2Y);
    value('1 : 10', col(3), row2Y + 10, { size: 8 });

    // Col 4 — Date / Rev
    label('DATE', col(4), row1Y);
    value(new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: '2-digit' }),
          col(4), row1Y + 10, { size: 8 });
    label('REV', col(4), row2Y);
    value('A — INITIAL RELEASE', col(4), row2Y + 10, { size: 7 });

    // Approval boxes
    const appX = tbX + tbW * cols[4] + (tbW * (cols[5] - cols[4])) / 2 - 20;
    label('DRAWN BY', appX - 10, row1Y);
    label('CHECKED BY', appX - 10, row2Y);
    d.fontSize(7).fillColor(TEXT).font('Courier')
     .text('AI', appX + 30, row1Y + 10, { lineBreak: false })
     .text('—', appX + 30, row2Y + 10, { lineBreak: false });
  }

  // ─── DRAWING HEADER ────────────────────────────────────────────────────────

  drawHeader() {
    const d = this.doc;
    d.fontSize(13).fillColor(this.TEXT).font('Courier-Bold')
     .text(this.project.toUpperCase() + ' — FABRICATION DRAWING',
           this.DA_X, this.DA_Y + 4, { width: this.DA_W, align: 'center', lineBreak: false });
    d.fontSize(7).fillColor(this.HIDDEN).font('Courier')
     .text(`MATERIAL: MILD STEEL  |  PROCESS: ${this.process}  |  ALL DIMENSIONS IN INCHES  |  TOLERANCES: ±1/16"`,
           this.DA_X, this.DA_Y + 20, { width: this.DA_W, align: 'center', lineBreak: false });
  }

  // ─── ORTHOGRAPHIC VIEWS ────────────────────────────────────────────────────

  // Compute a scale factor so the view fits within maxW × maxH
  scale(realW, realH, maxW, maxH, padding = 30) {
    return Math.min((maxW - padding) / realW, (maxH - padding) / realH);
  }

  // Draw front view (width × height of object)
  drawFrontView(ox, oy, maxW, maxH) {
    const d = this.doc;
    const sc = this.scale(this.W, this.H, maxW, maxH);
    const rw = this.W * sc;
    const rh = this.H * sc;
    // Center within cell
    const x = ox + (maxW - rw) / 2;
    const y = oy + (maxH - rh) / 2;

    // Outer rectangle — main body
    d.save().strokeColor(this.LINE).lineWidth(1.5)
     .rect(x, y, rw, rh).stroke().restore();

    // Vertical leg lines
    const legW = Math.max(8, rw * 0.07);
    d.save().strokeColor(this.LINE).lineWidth(1.2)
     .rect(x, y, legW, rh).stroke()
     .rect(x + rw - legW, y, legW, rh).stroke()
     .restore();

    // Top rail and bottom rail
    const railH = Math.max(6, rh * 0.08);
    d.save().strokeColor(this.LINE).lineWidth(1.2)
     .rect(x, y, rw, railH).stroke()
     .rect(x, y + rh - railH, rw, railH).stroke()
     .restore();

    // Mid shelf at ~40% height
    const shelfY = y + rh * 0.40;
    d.save().strokeColor(this.LINE).lineWidth(1)
     .moveTo(x + legW, shelfY).lineTo(x + rw - legW, shelfY)
     .moveTo(x + legW, shelfY + railH * 0.6).lineTo(x + rw - legW, shelfY + railH * 0.6)
     .stroke().restore();

    // Hidden lines — caster bolt pattern at bottom
    d.save().strokeColor(this.HIDDEN).lineWidth(0.6);
    [x + legW / 2, x + rw - legW / 2].forEach(cx => {
      d.setDash(3, 3).moveTo(cx, y + rh - railH)
       .lineTo(cx, y + rh + 8).stroke();
    });
    d.restore();

    // Weld symbols at corners
    this.weldSymbol(x + legW, y + rh - railH);
    this.weldSymbol(x + rw - legW - 4, y + railH);

    // Center marks for shelf
    this.centerMark(x + rw / 2, shelfY + railH * 0.3);

    // Dimension lines
    this.dimension(x, y, x + rw, y, `${this.W}"`, { axis: 'h', offset: -(22), color: this.DIM });
    this.dimension(x, y, x, y + rh, `${this.H}"`, { axis: 'v', offset: 22, color: this.DIM });

    // View label
    this.viewLabel('FRONT VIEW', ox + maxW / 2, oy + maxH - 10);
  }

  // Draw side view (depth × height)
  drawSideView(ox, oy, maxW, maxH) {
    const d = this.doc;
    const sc = this.scale(this.L, this.H, maxW, maxH);
    const rw = this.L * sc;
    const rh = this.H * sc;
    const x = ox + (maxW - rw) / 2;
    const y = oy + (maxH - rh) / 2;

    d.save().strokeColor(this.LINE).lineWidth(1.5)
     .rect(x, y, rw, rh).stroke().restore();

    const legW = Math.max(8, rw * 0.07);
    const railH = Math.max(6, rh * 0.08);

    d.save().strokeColor(this.LINE).lineWidth(1.2)
     .rect(x, y, legW, rh).stroke()
     .rect(x + rw - legW, y, legW, rh).stroke()
     .rect(x, y, rw, railH).stroke()
     .rect(x, y + rh - railH, rw, railH).stroke()
     .restore();

    // Cross bracing (X-brace between legs on this side)
    d.save().strokeColor(this.LINE).lineWidth(0.8)
     .moveTo(x + legW, y + railH)
     .lineTo(x + rw - legW, y + rh - railH)
     .stroke()
     .moveTo(x + rw - legW, y + railH)
     .lineTo(x + legW, y + rh - railH)
     .stroke()
     .restore();

    // Mid shelf hidden (dashed from side)
    const shelfY = y + rh * 0.40;
    d.save().strokeColor(this.HIDDEN).lineWidth(0.6)
     .setDash(4, 3)
     .moveTo(x + legW, shelfY).lineTo(x + rw - legW, shelfY)
     .stroke().restore();

    this.dimension(x, y, x + rw, y, `${this.L}"`, { axis: 'h', offset: -(22), color: this.DIM });
    this.dimension(x + rw, y, x + rw, y + rh, `${this.H}"`, { axis: 'v', offset: -(22), color: this.DIM });

    this.viewLabel('SIDE VIEW', ox + maxW / 2, oy + maxH - 10);
  }

  // Draw top view (width × depth)
  drawTopView(ox, oy, maxW, maxH) {
    const d = this.doc;
    const sc = this.scale(this.W, this.L, maxW, maxH);
    const rw = this.W * sc;
    const rh = this.L * sc;
    const x = ox + (maxW - rw) / 2;
    const y = oy + (maxH - rh) / 2;

    d.save().strokeColor(this.LINE).lineWidth(1.5)
     .rect(x, y, rw, rh).stroke().restore();

    const legW = Math.max(8, rw * 0.07);

    // Corner gusset squares
    d.save().strokeColor(this.LINE).lineWidth(1)
     .rect(x, y, legW, legW).stroke()
     .rect(x + rw - legW, y, legW, legW).stroke()
     .rect(x, y + rh - legW, legW, legW).stroke()
     .rect(x + rw - legW, y + rh - legW, legW, legW).stroke()
     .restore();

    // Cross members (3 evenly spaced horizontally)
    const railH = Math.max(5, rh * 0.07);
    d.save().strokeColor(this.LINE).lineWidth(1);
    [0.25, 0.5, 0.75].forEach(f => {
      const cx = x + rw * f;
      d.rect(cx - railH / 2, y, railH, rh).stroke();
    });
    d.restore();

    // Center lines
    this.centerMark(x + rw / 2, y + rh / 2, { size: 10 });

    this.dimension(x, y + rh, x + rw, y + rh, `${this.W}"`, { axis: 'h', offset: 22, color: this.DIM });
    this.dimension(x - 28, y, x - 28, y + rh, `${this.L}"`, { axis: 'v', offset: 0, color: this.DIM });

    this.viewLabel('TOP VIEW', ox + maxW / 2, oy + maxH - 10);
  }

  // Draw isometric 3-quarter view (bottom right)
  drawIsometricView(ox, oy, maxW, maxH) {
    const d = this.doc;

    // Isometric scale — fit within cell
    const isoScale = Math.min(maxW / (this.W + this.L * 0.6), maxH / (this.H + this.L * 0.35)) * 0.55;
    const l = this.L * isoScale;
    const w = this.W * isoScale;
    const h = this.H * isoScale;

    // Iso projection vectors
    const ax = 0.866, ay = 0.5;   // right-back axis (X: length)
    const bx = -0.866, by = 0.5;  // left-back axis (Y: width)
    // Z axis goes straight up

    // Origin — center bottom of iso box
    const cx = ox + maxW * 0.52;
    const cy = oy + maxH * 0.72;

    // Helper: convert iso coords to screen
    const iso = (il, iw, ih) => ({
      x: cx + il * ax * isoScale + iw * bx * isoScale,
      y: cy - ih * isoScale + il * ay * isoScale + iw * by * isoScale
    });

    // 8 corners of the bounding box
    const p = [
      iso(0, 0, 0), iso(this.L, 0, 0), iso(this.L, this.W, 0), iso(0, this.W, 0),  // bottom
      iso(0, 0, this.H), iso(this.L, 0, this.H), iso(this.L, this.W, this.H), iso(0, this.W, this.H)  // top
    ];

    const polyline = (pts, opts = {}) => {
      d.save().strokeColor(opts.color || this.LINE).lineWidth(opts.width || 1.2);
      if (opts.dash) d.setDash(opts.dash[0], { space: opts.dash[1] });
      d.moveTo(pts[0].x, pts[0].y);
      pts.slice(1).forEach(pt => d.lineTo(pt.x, pt.y));
      if (opts.close) d.closePath();
      d.stroke();
      d.restore();
    };

    // Hidden back edges (dashed)
    polyline([p[0], p[3]], { color: this.HIDDEN, width: 0.6, dash: [3, 3] }); // bottom-back
    polyline([p[3], p[7]], { color: this.HIDDEN, width: 0.6, dash: [3, 3] }); // left-back vert
    polyline([p[3], p[2]], { color: this.HIDDEN, width: 0.6, dash: [3, 3] }); // back-right bottom

    // Visible faces
    // Bottom
    polyline([p[0], p[1], p[2], p[3], p[0]], { width: 0.8 });
    // Front face
    polyline([p[0], p[1], p[5], p[4], p[0]], { width: 1.4, close: false });
    // Right face
    polyline([p[1], p[2], p[6], p[5], p[1]], { width: 1.4, close: false });
    // Top face
    polyline([p[4], p[5], p[6], p[7], p[4]], { width: 1.4, close: false });

    // Vertical edges
    [[p[0], p[4]], [p[1], p[5]], [p[2], p[6]]].forEach(([a, b]) => {
      polyline([a, b], { width: 1.4 });
    });

    // Draw structural details on front face
    const legFrac = 0.08;
    const railFrac = 0.1;
    // Left leg front face
    const ll0 = iso(0, 0, 0), ll1 = iso(this.L * legFrac, 0, 0),
          ll2 = iso(this.L * legFrac, 0, this.H), ll3 = iso(0, 0, this.H);
    polyline([ll0, ll1, ll2, ll3], { width: 0.7, color: this.LINE });
    // Top rail front face
    const tr0 = iso(0, 0, this.H), tr1 = iso(this.L, 0, this.H),
          tr2 = iso(this.L, 0, this.H * (1 - railFrac)), tr3 = iso(0, 0, this.H * (1 - railFrac));
    polyline([tr0, tr1, tr2, tr3], { width: 0.7 });

    // Iso dimension note
    const lp = iso(this.L, 0, 0), wp = iso(this.L, this.W, 0), hp = iso(this.L, 0, this.H);
    d.save().strokeColor(this.DIM).lineWidth(0.6);
    // Length note
    d.moveTo(p[0].x, p[0].y - 6).lineTo(p[1].x, p[1].y - 6).stroke();
    d.fontSize(6.5).fillColor(this.DIM).font('Courier-Bold')
     .text(`${this.L}"`, (p[0].x + p[1].x) / 2 - 8, Math.min(p[0].y, p[1].y) - 14, { lineBreak: false });
    // Width note
    d.moveTo(p[1].x + 6, p[1].y).lineTo(p[2].x + 6, p[2].y).stroke();
    d.text(`${this.W}"`, p[1].x + 8, (p[1].y + p[2].y) / 2 - 4, { lineBreak: false });
    // Height note
    d.moveTo(p[1].x + 4, p[1].y).lineTo(p[5].x + 4, p[5].y).stroke();
    d.text(`${this.H}"`, p[5].x + 6, (p[1].y + p[5].y) / 2 - 4, { lineBreak: false });
    d.restore();

    this.viewLabel('ISOMETRIC VIEW', ox + maxW / 2, oy + maxH - 10);
  }

  viewLabel(text, cx, y) {
    const d = this.doc;
    d.save();
    d.fontSize(8).fillColor(this.TEXT).font('Courier-Bold');
    const tw = d.widthOfString(text);
    // Underline
    d.fillColor(this.TEXT).text(text, cx - tw / 2, y - 9, { lineBreak: false });
    d.strokeColor(this.TEXT).lineWidth(0.5)
     .moveTo(cx - tw / 2, y).lineTo(cx + tw / 2, y).stroke();
    d.restore();
  }

  // ─── CUT LIST TABLE ────────────────────────────────────────────────────────

  drawCutList(ox, oy, maxW, maxH) {
    const d = this.doc;
    const cuts = this.getCutsForProject();
    const ROW_H = 13;
    const HEADER_H = 16;
    const cols = [
      { key: 'piece', label: 'PART / DESCRIPTION', w: 0.36 },
      { key: 'qty',   label: 'QTY', w: 0.09 },
      { key: 'length', label: 'LENGTH', w: 0.18 },
      { key: 'material', label: 'MATERIAL', w: 0.24 },
      { key: 'note', label: 'NOTES', w: 0.13 }
    ];

    // Section title
    d.fontSize(8).fillColor(this.ORANGE).font('Courier-Bold')
     .text('▸ CUT LIST', ox, oy - 14, { lineBreak: false });
    d.strokeColor(this.ORANGE).lineWidth(0.6)
     .moveTo(ox, oy - 4).lineTo(ox + maxW, oy - 4).stroke();

    // Header row
    d.rect(ox, oy, maxW, HEADER_H).fill('#001229');
    let colX = ox;
    cols.forEach(col => {
      const colW = maxW * col.w;
      d.save().strokeColor(this.LINE).lineWidth(0.5)
       .rect(colX, oy, colW, HEADER_H).stroke().restore();
      d.fontSize(6.5).fillColor(this.DIM).font('Courier-Bold')
       .text(col.label, colX + 3, oy + 4, { lineBreak: false, width: colW - 4 });
      colX += colW;
    });

    // Data rows
    cuts.forEach((cut, i) => {
      const rowY = oy + HEADER_H + i * ROW_H;
      const bg = i % 2 === 0 ? '#001A35' : '#001229';
      d.rect(ox, rowY, maxW, ROW_H).fill(bg);
      let cx = ox;
      cols.forEach(col => {
        const colW = maxW * col.w;
        d.save().strokeColor(this.GRID).lineWidth(0.4)
         .rect(cx, rowY, colW, ROW_H).stroke().restore();
        const val = String(cut[col.key] || '—');
        d.fontSize(6.5).fillColor(this.TEXT).font('Courier')
         .text(val, cx + 3, rowY + 3, { lineBreak: false, width: colW - 5 });
        cx += colW;
      });
    });

    // Outer border
    d.save().strokeColor(this.LINE).lineWidth(0.8)
     .rect(ox, oy, maxW, HEADER_H + cuts.length * ROW_H).stroke().restore();

    return oy + HEADER_H + cuts.length * ROW_H + 4;
  }

  // ─── NOTES PANEL ───────────────────────────────────────────────────────────

  drawNotes(ox, oy, maxW) {
    const d = this.doc;
    const notes = [
      `ALL WELDS: 1/4" FILLET UNLESS OTHERWISE NOTED`,
      `MATERIAL: MILD STEEL (A36 OR EQUIVALENT)`,
      `GRIND ALL SHARP EDGES AND DEBURR CUT EDGES`,
      `TACK WELD AND CHECK SQUARENESS BEFORE FINAL WELD`,
      `CLEAN AND PRIME BEFORE PAINTING`,
      `TOLERANCES: ANGLES ±1°  |  LINEAR ±1/16"`,
    ];

    d.fontSize(8).fillColor(this.ORANGE).font('Courier-Bold')
     .text('▸ GENERAL NOTES', ox, oy - 14, { lineBreak: false });
    d.strokeColor(this.ORANGE).lineWidth(0.6)
     .moveTo(ox, oy - 4).lineTo(ox + maxW, oy - 4).stroke();

    d.rect(ox, oy, maxW, notes.length * 11 + 8).fill('#001229');
    d.save().strokeColor(this.LINE).lineWidth(0.6)
     .rect(ox, oy, maxW, notes.length * 11 + 8).stroke().restore();

    notes.forEach((n, i) => {
      d.fontSize(6.5).fillColor(this.TEXT).font('Courier')
       .text(`${i + 1}.  ${n}`, ox + 6, oy + 4 + i * 11, { lineBreak: false, width: maxW - 10 });
    });
  }

  // ─── WELD SETTINGS PANEL ───────────────────────────────────────────────────

  drawWeldSettings(ox, oy, maxW) {
    const d = this.doc;
    const s = this.settings;

    d.fontSize(8).fillColor(this.ORANGE).font('Courier-Bold')
     .text('▸ WELD SETTINGS', ox, oy - 14, { lineBreak: false });
    d.strokeColor(this.ORANGE).lineWidth(0.6)
     .moveTo(ox, oy - 4).lineTo(ox + maxW, oy - 4).stroke();

    const items = [
      ['WELDER',    this.welder || '—'],
      ['PROCESS',   this.process || '—'],
      ['WIRE TYPE', s.wire || 'ER70S-6'],
      ['WIRE SIZE', s.wiresize || '.030'],
      ['GAS MIX',  s.gas || 'C25 (75/25)'],
      ['MATERIAL',  s.thickness ? `${s.thickness}" PLATE` : '3/16" PLATE'],
    ];

    d.rect(ox, oy, maxW, items.length * 12 + 8).fill('#001229');
    d.save().strokeColor(this.LINE).lineWidth(0.6)
     .rect(ox, oy, maxW, items.length * 12 + 8).stroke().restore();

    items.forEach(([key, val], i) => {
      const iy = oy + 4 + i * 12;
      d.save().strokeColor(this.GRID).lineWidth(0.3)
       .moveTo(ox, iy + 12).lineTo(ox + maxW, iy + 12).stroke().restore();
      d.fontSize(6).fillColor(this.HIDDEN).font('Courier').text(key, ox + 6, iy + 2, { lineBreak: false });
      d.fontSize(7).fillColor(this.DIM).font('Courier-Bold').text(val, ox + maxW * 0.45, iy + 2, { lineBreak: false });
    });
  }

  // ─── CUT DATA ──────────────────────────────────────────────────────────────

  getCutsForProject() {
    const { L, W, H } = this;
    const tube = '1.5" SQ TUBE 11ga';
    const heavyTube = '2" SQ TUBE 3/16"';
    const bigTube = '3" SQ TUBE 1/4"';

    const base = {
      'Welding Cart': [
        { piece: 'Main Frame Rail', qty: 2, length: `${L}"`, material: tube, note: 'Bottom & top rails' },
        { piece: 'Cross Member', qty: 3, length: `${W}"`, material: tube, note: 'Evenly spaced' },
        { piece: 'Leg', qty: 4, length: `${H}"`, material: tube, note: 'Vertical uprights' },
        { piece: 'Shelf Support', qty: 2, length: `${W}"`, material: tube, note: 'Mid-shelf' },
        { piece: 'Shelf Deck', qty: 1, length: `${W}"×18"`, material: '16ga Sheet', note: 'Grind edges' },
        { piece: 'Bottle Holder Hoop', qty: 1, length: '24"', material: '1" SQ TUBE', note: 'Bend to fit tank' },
        { piece: 'Gusset Plate', qty: 4, length: '3"×3"', material: '1/4" Plate', note: 'Corner braces' },
      ],
      'Shop Workbench': [
        { piece: 'Top Frame Rail (Long)', qty: 2, length: `${L}"`, material: heavyTube, note: 'Top perimeter' },
        { piece: 'Top Frame Rail (Short)', qty: 2, length: `${W}"`, material: heavyTube, note: 'Top perimeter' },
        { piece: 'Leg', qty: 4, length: `${H}"`, material: heavyTube, note: 'Plumb & square' },
        { piece: 'Lower Cross Brace', qty: 3, length: `${W}"`, material: '1.5" SQ TUBE', note: '8" from floor' },
        { piece: 'Side Brace', qty: 2, length: `${L - 4}"`, material: '1.5" SQ TUBE', note: 'Lower shelf' },
        { piece: 'Top Deck', qty: 1, length: `${L}"×${W}"`, material: '3/16" Plate', note: 'Weld to frame, grind flush' },
        { piece: 'Gusset', qty: 8, length: '4"×4"', material: '1/4" Plate', note: 'All leg–rail joints' },
      ],
      'Fire Pit': [
        { piece: 'Side Panel', qty: 4, length: `${W}"×${H}"`, material: '3/16" Plate', note: 'Bevel edges 45°' },
        { piece: 'Bottom Panel', qty: 1, length: `${W}"×${W}"`, material: '3/16" Plate', note: 'Drill 1" drain holes' },
        { piece: 'Leg', qty: 4, length: `${H + 8}"`, material: '1.5" SQ TUBE', note: 'Weld below pan' },
        { piece: 'Leg Brace', qty: 4, length: `${W * 0.5}"`, material: '1" FLAT BAR', note: 'Diagonal, bolt to legs' },
        { piece: 'Spark Screen Frame', qty: 1, length: `${W}"×${W}"`, material: '1/2" SQ BAR', note: '1/4" mesh infill' },
        { piece: 'Handle', qty: 2, length: '12"', material: '1/2" ROUND BAR', note: 'Weld opposite sides' },
      ],
      'Truck Flatbed': [
        { piece: 'Main Rail', qty: 2, length: '96"', material: bigTube, note: 'Full-length runners' },
        { piece: 'Cross Member', qty: 7, length: '72"', material: heavyTube, note: '16" spacing' },
        { piece: 'Headache Rack Upright', qty: 2, length: '36"', material: heavyTube, note: 'Front of bed' },
        { piece: 'Headache Rack Top', qty: 1, length: '72"', material: heavyTube, note: 'Weld to uprights' },
        { piece: 'Stake Pocket', qty: 8, length: '8"', material: '1/4" Plate (formed)', note: '2"×4" pocket size' },
        { piece: 'Side Rail', qty: 2, length: '96"', material: '2" C-Channel 3/16"', note: 'Mounted on edge' },
        { piece: 'Deck', qty: 1, length: '96"×72"', material: 'Diamond Plate 3/16"', note: 'Bolt to cross members' },
        { piece: 'Gusset', qty: 12, length: '4"×4"', material: '1/4" Plate', note: 'All critical joints' },
      ],
      'Utility Trailer': [
        { piece: 'Main Frame Rail', qty: 2, length: '96"', material: bigTube, note: 'Full-length spine' },
        { piece: 'Cross Member', qty: 5, length: '48"', material: heavyTube, note: '24" spacing' },
        { piece: 'Tongue (V-style)', qty: 2, length: '48"', material: bigTube, note: 'Angle to coupler' },
        { piece: 'Coupler Mount Plate', qty: 1, length: '6"×8"', material: '3/8" Plate', note: 'Weld to tongue tip' },
        { piece: 'Spring Hanger', qty: 4, length: '6"', material: '1/4" Plate', note: 'Weld to main rail' },
        { piece: 'Axle Tube', qty: 1, length: '72"', material: '3" Round Tube', note: 'Align to hangers' },
        { piece: 'Ramp', qty: 1, length: '48"×36"', material: '1" Expanded Metal', note: 'Hinge to rear' },
        { piece: 'Fender', qty: 2, length: '—', material: 'Press Steel', note: 'Purchase — bolt on' },
      ]
    };

    return base[this.project] || [
      { piece: 'Main Frame Rail', qty: 2, length: `${L}"`, material: heavyTube, note: 'Length runners' },
      { piece: 'Cross Member', qty: 3, length: `${W}"`, material: tube, note: 'Evenly spaced' },
      { piece: 'Support', qty: 4, length: `${H}"`, material: tube, note: 'Vertical legs' },
      { piece: 'Gusset', qty: 4, length: '3"×3"', material: '1/4" Plate', note: 'Corner joints' },
    ];
  }

  // ─── MAIN ENTRY POINT ──────────────────────────────────────────────────────

  generateBlueprint() {
    // Background, grid, border
    this.drawBackground();

    const { DA_X, DA_Y, DA_W, DA_H, PW, PH, ML, MR, MT, MB, TB_H } = this;

    // Title block at bottom
    this.drawTitleBlock();

    // Header strip
    this.drawHeader();
    const headerH = 36;

    // ── Layout: 4 orthographic view cells (2×2) + bottom data strip ──
    // Drawing area starts below header
    const drawY = DA_Y + headerH;
    const drawH = DA_H - headerH;

    // Reserve bottom ~120pt for cut list + notes
    const bottomStripH = 148;
    const viewAreaH = drawH - bottomStripH - 16;

    // 2 columns, 2 rows for views
    const colW = DA_W / 2;
    const rowH = viewAreaH / 2;
    const pad = 8;

    // Draw 4 views
    this.drawFrontView(DA_X + pad,           drawY + pad,      colW - pad * 2, rowH - pad * 2);
    this.drawSideView (DA_X + colW + pad,     drawY + pad,      colW - pad * 2, rowH - pad * 2);
    this.drawTopView  (DA_X + pad,            drawY + rowH + pad, colW - pad * 2, rowH - pad * 2);
    this.drawIsometricView(DA_X + colW + pad, drawY + rowH + pad, colW - pad * 2, rowH - pad * 2);

    // Separator line between views and data area
    const dataY = drawY + viewAreaH + 10;
    this.line(DA_X, dataY, DA_X + DA_W, dataY, { color: this.LINE, width: 0.6 });

    // Bottom data strip: cut list (left 60%) | notes + weld settings (right 40%)
    const listW = DA_W * 0.60;
    const infoW = DA_W * 0.38;
    const infoX = DA_X + DA_W * 0.62;

    this.drawCutList(DA_X, dataY + 16, listW, bottomStripH);
    this.drawNotes(infoX, dataY + 16, infoW);

    const notesH = this.getCutsForProject().length < 5 ? 80 : 100;
    this.drawWeldSettings(infoX, dataY + notesH + 16, infoW);
  }
}

module.exports = BlueprintGenerator;