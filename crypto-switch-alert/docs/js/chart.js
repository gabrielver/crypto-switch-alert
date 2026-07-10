// Mini graphique en ligne sur canvas (aucune dépendance).
// Trace la série du ratio + sa moyenne mobile 24 h, avec grille discrète,
// étiquette de dernière valeur et curseur tactile (crosshair + infobulle).

const PAD = { top: 10, right: 8, bottom: 20, left: 8 };

function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function fmtVal(v) {
  if (v === null || v === undefined) return "?";
  return v >= 100 ? v.toFixed(1) : v.toPrecision(4);
}

function fmtTime(t, rangeMs) {
  const d = new Date(t);
  if (rangeMs <= 26 * 3600e3) {
    return d.toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" });
  }
  return d.toLocaleDateString("fr-FR", { day: "2-digit", month: "2-digit" });
}

/**
 * Dessine (ou redessine) le graphique dans `canvas`.
 * @param {HTMLCanvasElement} canvas
 * @param {Array<[number, number]>} series     ratio [tMs, v]
 * @param {Array<[number, number]>} smaSeries  moyenne mobile [tMs, v] (même repère)
 */
export function drawChart(canvas, series, smaSeries) {
  canvas.__chart = { series, smaSeries, cursor: null };
  render(canvas);
  if (!canvas.__chartBound) {
    canvas.__chartBound = true;
    canvas.addEventListener("pointermove", (e) => onPointer(canvas, e));
    canvas.addEventListener("pointerdown", (e) => onPointer(canvas, e));
    canvas.addEventListener("pointerleave", () => {
      if (canvas.__chart) {
        canvas.__chart.cursor = null;
        render(canvas);
      }
    });
  }
}

function onPointer(canvas, e) {
  const rect = canvas.getBoundingClientRect();
  canvas.__chart.cursor = e.clientX - rect.left;
  render(canvas);
}

function render(canvas) {
  const { series, smaSeries, cursor } = canvas.__chart;
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth || 300;
  const h = canvas.clientHeight || 150;
  if (canvas.width !== Math.round(w * dpr)) {
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
  }
  const ctx = canvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  if (!series || series.length < 2) {
    ctx.fillStyle = cssVar("--muted");
    ctx.font = "12px system-ui, sans-serif";
    ctx.textAlign = "center";
    ctx.fillText("Pas encore assez de données", w / 2, h / 2);
    return;
  }

  const t0 = series[0][0];
  const t1 = series[series.length - 1][0];
  const all = series.map(([, v]) => v).concat(smaSeries.map(([, v]) => v));
  let vMin = Math.min(...all);
  let vMax = Math.max(...all);
  const span = vMax - vMin || vMax * 0.01 || 1;
  vMin -= span * 0.08;
  vMax += span * 0.08;

  const X = (t) => PAD.left + ((t - t0) / (t1 - t0 || 1)) * (w - PAD.left - PAD.right);
  const Y = (v) => PAD.top + (1 - (v - vMin) / (vMax - vMin)) * (h - PAD.top - PAD.bottom);

  // Grille horizontale discrète + valeurs (encre atténuée).
  ctx.strokeStyle = cssVar("--grid");
  ctx.fillStyle = cssVar("--muted");
  ctx.lineWidth = 1;
  ctx.font = "10px system-ui, sans-serif";
  ctx.textAlign = "left";
  for (let i = 0; i <= 2; i++) {
    const v = vMin + ((vMax - vMin) * i) / 2;
    const y = Y(v);
    ctx.beginPath();
    ctx.moveTo(PAD.left, y);
    ctx.lineTo(w - PAD.right, y);
    ctx.stroke();
    if (i > 0) ctx.fillText(fmtVal(v), PAD.left + 2, y + 11);
  }

  // Axe temporel : début / milieu / fin.
  const rangeMs = t1 - t0;
  ctx.textAlign = "center";
  for (const frac of [0.08, 0.5, 0.92]) {
    const t = t0 + rangeMs * frac;
    ctx.fillText(fmtTime(t, rangeMs), X(t), h - 6);
  }

  // Moyenne mobile 24 h (tirets, série 2).
  if (smaSeries.length > 1) {
    ctx.strokeStyle = cssVar("--series-2");
    ctx.lineWidth = 2;
    ctx.setLineDash([5, 4]);
    ctx.beginPath();
    smaSeries.forEach(([t, v], i) => (i ? ctx.lineTo(X(t), Y(v)) : ctx.moveTo(X(t), Y(v))));
    ctx.stroke();
    ctx.setLineDash([]);
  }

  // Ratio (trait 2 px, série 1).
  ctx.strokeStyle = cssVar("--series-1");
  ctx.lineWidth = 2;
  ctx.lineJoin = "round";
  ctx.beginPath();
  series.forEach(([t, v], i) => (i ? ctx.lineTo(X(t), Y(v)) : ctx.moveTo(X(t), Y(v))));
  ctx.stroke();

  // Dernier point : pastille avec anneau de surface + étiquette directe.
  const [lt, lv] = series[series.length - 1];
  ctx.fillStyle = cssVar("--surface");
  ctx.beginPath();
  ctx.arc(X(lt), Y(lv), 6, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = cssVar("--series-1");
  ctx.beginPath();
  ctx.arc(X(lt), Y(lv), 4, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = cssVar("--ink");
  ctx.font = "bold 11px system-ui, sans-serif";
  ctx.textAlign = "right";
  ctx.fillText(fmtVal(lv), X(lt) - 9, Y(lv) - 7);

  // Curseur tactile : point le plus proche + infobulle.
  if (cursor !== null) {
    let nearest = series[0];
    let best = Infinity;
    for (const p of series) {
      const d = Math.abs(X(p[0]) - cursor);
      if (d < best) {
        best = d;
        nearest = p;
      }
    }
    const cx = X(nearest[0]);
    const cy = Y(nearest[1]);
    ctx.strokeStyle = cssVar("--axis");
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(cx, PAD.top);
    ctx.lineTo(cx, h - PAD.bottom);
    ctx.stroke();
    ctx.fillStyle = cssVar("--series-1");
    ctx.beginPath();
    ctx.arc(cx, cy, 4, 0, Math.PI * 2);
    ctx.fill();

    const label = `${fmtVal(nearest[1])} · ${fmtTime(nearest[0], rangeMs)}`;
    ctx.font = "11px system-ui, sans-serif";
    const tw = ctx.measureText(label).width + 12;
    const bx = Math.min(Math.max(cx - tw / 2, 2), w - tw - 2);
    ctx.fillStyle = cssVar("--surface");
    ctx.strokeStyle = cssVar("--axis");
    ctx.beginPath();
    ctx.roundRect(bx, 2, tw, 18, 5);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = cssVar("--ink");
    ctx.textAlign = "left";
    ctx.fillText(label, bx + 6, 15);
  }
}
