(function () {
  "use strict";

  const cfg = window.SITE_CONFIG || {};
  const INITIAL_CENTER = cfg.center || [42.36, -71.06];
  const DEFAULT_ZOOM = cfg.zoom || 11;
  const DATA_STATIONS  = cfg.stationsUrl  || "data/stations_hourly.json";
  const DATA_GRID      = cfg.gridUrl      || "data/grid_vectors.json";
  const BOUNDARY_URL   = cfg.boundaryUrl  || null;
  const PLAY_INTERVAL_MS = 50;
  const MARKER_RADIUS_MIN = 4;
  const MARKER_RADIUS_MAX = 12;
  const VORONOI_ALPHA = 0.3;
  const VORONOI_DIM_ALPHA = 0.06;

  const LEGEND = {
    net: {
      min: "Net outflow",
      mid: "Balanced",
      max: "Net inflow",
      caption:
        "Color shows the net trip balance at this time: blue = more bikes leaving than arriving; red = more arriving than leaving. Marker size reflects average daily trip volume.",
    },
    fullness: {
      min: "Likely empty",
      mid: "Half full",
      max: "Likely full",
      caption:
        "Estimates dock occupancy from the running balance of arrivals vs. departures throughout the day. Blue = bikes have been leaving faster than arriving (dock likely low); red = bikes have been accumulating (dock likely full).",
    },
    vector: {
      min: "N",
      mid: "S (180°)",
      max: "→ N",
      caption:
        "Arrows show the average direction bikes travel through each area at this time. Color encodes compass bearing (N=red, E=yellow, S=cyan, W=purple). Arrow length and opacity scale with traffic volume.",
    },
  };

  function colorFromExpectedRange(net, expMin, expMax) {
    if (!(expMax > expMin)) return divergingColor(0);
    const t = (2 * (net - expMin)) / (expMax - expMin) - 1;
    return divergingColor(Math.max(-1, Math.min(1, t)));
  }

  function divergingColor(t) {
    const tc = Math.max(-1, Math.min(1, t));
    const lo = { r: 29, g: 78, b: 216 };
    const mid = { r: 226, g: 232, b: 239 };
    const hi = { r: 185, g: 28, b: 28 };
    let a, b, u;
    if (tc < 0) { u = 1 + tc; a = lo; b = mid; }
    else        { u = tc;     a = mid; b = hi; }
    return `rgb(${Math.round(a.r+(b.r-a.r)*u)},${Math.round(a.g+(b.g-a.g)*u)},${Math.round(a.b+(b.b-a.b)*u)})`;
  }

  function withAlpha(rgb, alpha) {
    const m = /^rgb\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)$/.exec(rgb);
    if (m) return `rgba(${m[1]},${m[2]},${m[3]},${alpha})`;
    const h = /^#([0-9a-f]{6})$/i.exec(rgb);
    if (h) {
      const n = parseInt(h[1], 16);
      return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${alpha})`;
    }
    return rgb;
  }

  function formatHour(hour) {
    const h12 = hour % 12 === 0 ? 12 : hour % 12;
    return `${h12}:00 ${hour < 12 ? "AM" : "PM"}`;
  }

  function formatClockFromDecimalHour(decH) {
    const totalMin = Math.round(decH * 60);
    const h24 = ((Math.floor(totalMin / 60) % 24) + 24) % 24;
    const m = totalMin % 60;
    const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
    const ampm = h24 < 12 ? "AM" : "PM";
    return m === 0 ? `${h12}:00 ${ampm}` : `${h12}:${String(m).padStart(2, "0")} ${ampm}`;
  }

  function formatAxisTickHour(v) {
    if (v >= 24) return "12:00 AM";
    return formatHour(Math.round(v) % 24);
  }

  function formatSlotLabel(slot, slotsPerDay, slotDurationMinutes) {
    if (slotsPerDay === 24 && slotDurationMinutes === 60) return formatHour(slot);
    const startMin = slot * slotDurationMinutes;
    const endMin = startMin + slotDurationMinutes;
    function fmt(mins) {
      const h24 = Math.floor(mins / 60) % 24;
      const m = mins % 60;
      const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
      const ampm = h24 < 12 ? "AM" : "PM";
      return m === 0 ? `${h12}:00 ${ampm}` : `${h12}:${String(m).padStart(2, "0")} ${ampm}`;
    }
    return `${fmt(startMin)}–${fmt(endMin)}`;
  }

  function setStatus(el, show, text) {
    if (text != null) el.textContent = text;
    el.classList.toggle("is-visible", show);
  }

  const sliderLinePlugin = {
    id: "sliderLine",
    afterDraw(chart) {
      const hour = chart.options.plugins?.sliderLine?.hourAtMidSlot;
      if (hour == null || !chart.chartArea) return;
      const xScale = chart.scales.x;
      if (!xScale || typeof xScale.getPixelForValue !== "function") return;
      const { top, bottom, left, right } = chart.chartArea;
      let x = Math.max(left, Math.min(right, xScale.getPixelForValue(hour)));
      const ctx = chart.ctx;
      ctx.save();
      ctx.beginPath();
      ctx.setLineDash([6, 5]);
      ctx.strokeStyle = "rgba(15, 23, 42, 0.72)";
      ctx.lineWidth = 1.25;
      ctx.moveTo(x, top);
      ctx.lineTo(x, bottom);
      ctx.stroke();
      ctx.restore();
    },
  };

  /**
   * Draw a single arrow on a Canvas 2D context.
   * dx = east component, dy = north component of the mean unit vector (sets direction).
   * weight = [0,1] scalar encoding traffic volume through the cell (sets size/opacity).
   * cellPx = approximate screen width of one grid cell (for scaling).
   *
   * Canvas rotate convention: atan2(dx, dy) gives bearing clockwise from north.
   * An arrow drawn pointing toward canvas -y (up) with this rotation points correctly.
   */
  function drawArrow(ctx, x, y, dx, dy, weight, cellPx) {
    const rotation = Math.atan2(dx, dy);
    const hue = ((rotation * 180 / Math.PI) + 360) % 360;
    const opacity = Math.min(1, 0.2 + weight * 0.8);
    const len = Math.min(cellPx * 0.62, 5 + weight * 15);
    const headLen = Math.min(len * 0.38, 5.5);
    const lineW = Math.max(1.2, Math.min(2.4, cellPx * 0.065));
    const colorStr = `hsl(${hue.toFixed(0)},90%,32%)`;

    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(rotation);
    ctx.lineCap = "round";

    // White halo drawn first so the colored arrow pops against the light basemap
    ctx.globalAlpha = opacity * 0.8;
    ctx.strokeStyle = "rgba(255,255,255,0.92)";
    ctx.fillStyle = "rgba(255,255,255,0.92)";
    ctx.lineWidth = lineW + 2;
    ctx.beginPath();
    ctx.moveTo(0, len / 2);
    ctx.lineTo(0, -len / 2 + headLen);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(0, -len / 2);
    ctx.lineTo(-headLen * 0.6, -len / 2 + headLen);
    ctx.lineTo( headLen * 0.6, -len / 2 + headLen);
    ctx.closePath();
    ctx.fill();

    // Colored arrow on top
    ctx.globalAlpha = opacity;
    ctx.strokeStyle = colorStr;
    ctx.fillStyle = colorStr;
    ctx.lineWidth = lineW;
    ctx.beginPath();
    ctx.moveTo(0, len / 2);
    ctx.lineTo(0, -len / 2 + headLen);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(0, -len / 2);
    ctx.lineTo(-headLen * 0.6, -len / 2 + headLen);
    ctx.lineTo( headLen * 0.6, -len / 2 + headLen);
    ctx.closePath();
    ctx.fill();

    ctx.restore();
  }

  function main() {
    const mapEl              = document.getElementById("map");
    const statusEl           = document.getElementById("status");
    const hourSlider         = document.getElementById("hour-slider");
    const hourDisplay        = document.getElementById("hour-display");
    const btnWeekday         = document.getElementById("btn-weekday");
    const btnWeekend         = document.getElementById("btn-weekend");
    const btnModeNet         = document.getElementById("btn-mode-net");
    const btnModeFullness    = document.getElementById("btn-mode-fullness");
    const btnModeVector      = document.getElementById("btn-mode-vector");
    const playBtn            = document.getElementById("play-btn");
    const stationSearch      = document.getElementById("station-search");
    const provenanceEl       = document.getElementById("data-provenance");
    const legendBar          = document.getElementById("legend-bar");
    const legendLabels       = document.getElementById("legend-labels");
    const legendLabelMin     = document.getElementById("legend-label-min");
    const legendLabelMid     = document.getElementById("legend-label-mid");
    const legendLabelMax     = document.getElementById("legend-label-max");
    const legendCaptionEl    = document.getElementById("legend-caption");
    const chartModal         = document.getElementById("chart-modal");
    const chartModalBackdrop = document.getElementById("chart-modal-backdrop");
    const chartModalClose    = document.getElementById("chart-modal-close");
    const chartModalTitle    = document.getElementById("chart-modal-title");
    const chartModalSubtitle = document.getElementById("chart-modal-subtitle");
    const chartCanvas        = document.getElementById("station-chart");
    const voronoiToggleWrap  = document.getElementById("voronoi-toggle-wrap");
    const voronoiToggle      = document.getElementById("voronoi-toggle");
    const markerSizeSlider   = document.getElementById("marker-size-slider");
    const markerSizeDisplay  = document.getElementById("marker-size-display");

    const map = L.map(mapEl, { zoomControl: true, preferCanvas: true })
      .setView(INITIAL_CENTER, DEFAULT_ZOOM);

    map.createPane("labelsPane");
    map.getPane("labelsPane").style.zIndex = 650;
    // preferCanvas draws markers on overlayPane; keep them above the label GL canvas.
    map.getPane("overlayPane").style.zIndex = 660;

    const cartoAttribution =
      '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> ' +
      '&copy; <a href="https://carto.com/attributions">CARTO</a>';
    const cartoOpts = { attribution: cartoAttribution, subdomains: "abcd", maxZoom: 20 };
    // Pale Carto PNG base (matches light_all). PNG label tiles clip at 256px edges;
    // vector symbol overlay renders place names client-side instead.
    const CARTO_POSITRON = "https://basemaps.cartocdn.com/gl/positron-gl-style/style.json";

    L.tileLayer("https://{s}.basemaps.cartocdn.com/light_nolabels/{z}/{x}/{y}.png", cartoOpts).addTo(map);

    function showLabelsOnly(gl) {
      let backgroundRemoved = false;
      const apply = () => {
        const style = gl.getStyle();
        if (!style?.layers) return;
        for (const layer of style.layers) {
          if (layer.type === "background") {
            if (!backgroundRemoved && gl.getLayer(layer.id)) {
              gl.removeLayer(layer.id);
              backgroundRemoved = true;
            }
            continue;
          }
          if (!gl.getLayer(layer.id)) continue;
          gl.setLayoutProperty(
            layer.id,
            "visibility",
            layer.type === "symbol" ? "visible" : "none"
          );
        }
      };
      gl.on("styledata", apply);
      apply();
    }

    const labelLayer = L.maplibreGL({
      style: CARTO_POSITRON,
      padding: 0,
      pane: "labelsPane",
      interactive: false,
      attributionControl: false,
    }).addTo(map);

    labelLayer.on("add", () => showLabelsOnly(labelLayer.getMaplibreMap()));

    map.whenReady(() => map.invalidateSize());

    // ── Canvas overlay for vector field ────────────────────────────────────
    const vectorCanvas = document.createElement("canvas");
    vectorCanvas.style.cssText =
      "position:absolute;top:0;left:0;pointer-events:none;z-index:450;display:none";
    mapEl.appendChild(vectorCanvas);

    function resizeVectorCanvas() {
      vectorCanvas.width  = mapEl.clientWidth;
      vectorCanvas.height = mapEl.clientHeight;
    }

    // ── Canvas overlay for Voronoi regions ─────────────────────────────────
    const voronoiCanvas = document.createElement("canvas");
    voronoiCanvas.style.cssText =
      "position:absolute;top:0;left:0;pointer-events:none;z-index:450;display:none";
    mapEl.appendChild(voronoiCanvas);

    const voronoiHoverTip = document.createElement("div");
    voronoiHoverTip.className = "voronoi-hover-tip";
    voronoiHoverTip.setAttribute("role", "tooltip");
    document.body.appendChild(voronoiHoverTip);

    function resizeVoronoiCanvas() {
      const size = map.getSize();
      voronoiCanvas.width  = size.x;
      voronoiCanvas.height = size.y;
    }

    let voronoiDrawFrame = null;
    function scheduleVoronoiDraw() {
      if (!voronoiIsActive()) return;
      if (voronoiDrawFrame != null) cancelAnimationFrame(voronoiDrawFrame);
      voronoiDrawFrame = requestAnimationFrame(() => {
        voronoiDrawFrame = null;
        if (map.getSize().x !== voronoiCanvas.width ||
            map.getSize().y !== voronoiCanvas.height) {
          resizeVoronoiCanvas();
        }
        drawVoronoiRegions();
      });
    }

    // ── State ──────────────────────────────────────────────────────────────
    let dayType  = "weekday";
    let viewMode = "net";        // "net" | "fullness" | "vector"
    let markerScale = 1.0;
    let voronoiMode = false;
    /** @type {{ voronoi: any, stations: any[], visuals: any[] } | null} */
    let activeVoronoi = null;
    let activeBoundaryPath = null;
    /** @type {L.CircleMarker[]} */
    const markers = [];
    /** @type {{ meta: Record<string, unknown>, stations: any[] } | null} */
    let payload    = null;
    /** @type {any | null} */
    let gridData   = null;
    let gridLoading = false;
    let boundaryData = null;
    let slotsPerDay = 24;
    let slotDurationMinutes = 60;
    let maxVolume = 1;
    let searchQuery = "";
    let playInterval = null;
    /** @type {any} */
    let stationChart = null;
    /** @type {any | null} */
    let chartStation = null;

    // ── Helpers ────────────────────────────────────────────────────────────

    function toPerHour(v) {
      const h = slotDurationMinutes / 60;
      return h > 0 ? v / h : v;
    }

    function rollingMeanWindowSlots() {
      let w = slotsPerDay >= 96 ? 6 : slotsPerDay >= 48 ? 5 : 3;
      while (w > slotsPerDay) w -= 2;
      return Math.max(1, w);
    }

    function rollingWindowHoursLabel() {
      const w = rollingMeanWindowSlots();
      const h = (w * slotDurationMinutes) / 60;
      const t = Number.isInteger(h) ? h : Math.round(h * 10) / 10;
      return `${t}h`;
    }

    function dayTypeLabel(dt) {
      return dt === "weekday" ? "Weekday"
           : dt === "weekend"  ? "Weekend" : dt;
    }

    function rollingCircularMean(values, win) {
      const n = values.length;
      if (n === 0 || win <= 1) return values.slice();
      const half = Math.floor(win / 2);
      const out = [];
      for (let i = 0; i < n; i++) {
        let s = 0;
        for (let j = -half; j <= half; j++) s += values[(i + j + n) % n];
        out.push(s / win);
      }
      return out;
    }

    function cursorHourAtMidSlot() {
      return (parseInt(hourSlider.value, 10) + 0.5) * (24 / slotsPerDay);
    }

    function slotLabel() {
      return formatSlotLabel(parseInt(hourSlider.value, 10), slotsPerDay, slotDurationMinutes);
    }

    function markerRadius(m) {
      const vol = m._volume[dayType] || 0;
      return markerScale * (MARKER_RADIUS_MIN + (MARKER_RADIUS_MAX - MARKER_RADIUS_MIN) * Math.sqrt(vol / maxVolume));
    }

    function fmtNum(x) {
      if (typeof x !== "number" || Number.isNaN(x)) return String(x);
      const ax = Math.abs(x);
      return x.toFixed(ax >= 10 ? 1 : ax >= 1 ? 2 : 3);
    }

    function getStationVisual(station, slot, dimmed) {
      const block = station[dayType];
      if (!block || !Array.isArray(block.net)) {
        return {
          fillColor: "#94a3b8",
          tipBody: "Regenerate JSON (weekday / weekend).",
          dimmed,
        };
      }

      if (viewMode === "fullness") {
        const fullness = computeFullness(station);
        const val = fullness[slot] ?? 0.5;
        return {
          fillColor: divergingColor(val * 2 - 1),
          tipBody:
            `${slotLabel()} · ${dayTypeLabel(dayType)}<br/>` +
            `Fullness est.: <strong>${Math.round(val * 100)}%</strong><br/>` +
            `<span style="font-size:0.9em;opacity:0.8">Click: 24h plot</span>`,
          dimmed,
        };
      }

      const dep = block.dep[slot];
      const arr = block.arr[slot];
      const net = block.net[slot];
      const sc = block.scale || {};
      const expMin = Number(sc.expectedMin);
      const expMax = Number(sc.expectedMax);
      const nDays = sc.nActiveDays != null ? Number(sc.nActiveDays) : null;
      const scaleLine = expMax > expMin
        ? `Scale: ${fmtNum(toPerHour(expMin))}–${fmtNum(toPerHour(expMax))} /h`
        : "Scale: flat";
      const daysLine = nDays != null && !Number.isNaN(nDays) ? ` · n = ${nDays}` : "";
      return {
        fillColor: colorFromExpectedRange(toPerHour(net), toPerHour(expMin), toPerHour(expMax)),
        tipBody:
          `${slotLabel()} · ${dayTypeLabel(dayType)} · /h<br/>` +
          `Dep ${fmtNum(toPerHour(dep))} · Arr ${fmtNum(toPerHour(arr))} · Net <strong>${fmtNum(toPerHour(net))}</strong><br/>` +
          `${scaleLine}${daysLine}<br/>` +
          `<span style="font-size:0.9em;opacity:0.8">Click: 24h plot</span>`,
        dimmed,
      };
    }

    function voronoiIsActive() {
      return voronoiMode && (viewMode === "net" || viewMode === "fullness") && !!payload;
    }

    function hideVoronoiTooltip() {
      voronoiHoverTip.classList.remove("is-visible");
    }

    function showVoronoiTooltip(clientX, clientY, station, tipBody) {
      voronoiHoverTip.innerHTML =
        `<strong>${escapeHtml(station.name || station.id)}</strong><br/>${tipBody}`;
      voronoiHoverTip.classList.add("is-visible");
      const pad = 12;
      let left = clientX + pad;
      let top = clientY + pad;
      const rect = voronoiHoverTip.getBoundingClientRect();
      if (left + rect.width > window.innerWidth - pad) left = clientX - rect.width - pad;
      if (top + rect.height > window.innerHeight - pad) top = clientY - rect.height - pad;
      voronoiHoverTip.style.left = `${Math.max(pad, left)}px`;
      voronoiHoverTip.style.top = `${Math.max(pad, top)}px`;
    }

    function drawVoronoiRegions() {
      if (!voronoiIsActive()) return;
      const size = map.getSize();
      if (size.x <= 0 || size.y <= 0) return;

      if (voronoiCanvas.width !== size.x || voronoiCanvas.height !== size.y) {
        resizeVoronoiCanvas();
      }

      const ctx = voronoiCanvas.getContext("2d");
      const w = voronoiCanvas.width;
      const h = voronoiCanvas.height;
      ctx.clearRect(0, 0, w, h);

      if (typeof d3 === "undefined" || !d3.Delaunay) return;

      const slot = parseInt(hourSlider.value, 10);
      const q = searchQuery.toLowerCase();
      const points = [];
      const stations = [];
      const visuals = [];

      for (let i = 0; i < markers.length; i++) {
        const s = markers[i].station;
        const pt = map.latLngToContainerPoint([s.lat, s.lng]);
        points.push([pt.x, pt.y]);
        stations.push(s);
        const dimmed = q.length > 0 && !(s.name || s.id || "").toLowerCase().includes(q);
        visuals.push(getStationVisual(s, slot, dimmed));
      }

      const delaunay = d3.Delaunay.from(points);
      const voronoi = delaunay.voronoi([0, 0, w, h]);
      activeVoronoi = { voronoi, stations, visuals };

      if (boundaryData) {
        activeBoundaryPath = buildBoundaryPath(boundaryData);
        ctx.save();
        ctx.clip(activeBoundaryPath);
      }
      for (let i = 0; i < stations.length; i++) {
        const path = voronoi.renderCell(i);
        if (!path) continue;
        const alpha = visuals[i].dimmed ? VORONOI_DIM_ALPHA : VORONOI_ALPHA;
        ctx.fillStyle = withAlpha(visuals[i].fillColor, alpha);
        ctx.fill(new Path2D(path));
      }
      if (boundaryData) ctx.restore();
    }

    function buildBoundaryPath(geojson) {
      const path = new Path2D();
      for (const feature of (geojson.features || [])) {
        const geom = feature.geometry;
        if (!geom) continue;
        const polys = geom.type === "MultiPolygon" ? geom.coordinates : [geom.coordinates];
        for (const poly of polys) {
          for (const ring of poly) {
            let first = true;
            for (const [lng, lat] of ring) {
              const pt = map.latLngToContainerPoint(L.latLng(lat, lng));
              first ? path.moveTo(pt.x, pt.y) : path.lineTo(pt.x, pt.y);
              first = false;
            }
            path.closePath();
          }
        }
      }
      return path;
    }

    function syncVoronoiLayer() {
      const active = voronoiIsActive();
      voronoiCanvas.style.display = active ? "block" : "none";
      voronoiCanvas.style.pointerEvents = active ? "auto" : "none";
      if (voronoiToggleWrap) {
        voronoiToggleWrap.classList.toggle("is-disabled", viewMode === "vector");
      }
      if (voronoiToggle) voronoiToggle.disabled = viewMode === "vector";
      if (active) {
        scheduleVoronoiDraw();
      } else {
        const ctx = voronoiCanvas.getContext("2d");
        ctx.clearRect(0, 0, voronoiCanvas.width, voronoiCanvas.height);
        hideVoronoiTooltip();
        activeVoronoi = null;
        activeBoundaryPath = null;
      }
      updateLegend();
    }

    // ── Fullness computation ───────────────────────────────────────────────

    function computeFullness(station) {
      const block = station[dayType];
      const nets = block && Array.isArray(block.net) ? block.net : [];
      const smoothed = rollingCircularMean(nets, rollingMeanWindowSlots());
      const cumsum = new Array(slotsPerDay).fill(0);
      let acc = 0;
      for (let i = 0; i < slotsPerDay; i++) {
        cumsum[i] = acc;
        acc += i < smoothed.length ? smoothed[i] : 0;
      }
      const minVal = Math.min(...cumsum);
      const maxVal = Math.max(...cumsum);
      if (!(maxVal > minVal)) return cumsum.map(() => 0.5);
      return cumsum.map(v => (v - minVal) / (maxVal - minVal));
    }

    // ── Chart data builders ───────────────────────────────────────────────

    function buildRollingChartPoints(station) {
      const block = station[dayType];
      const nets = block && Array.isArray(block.net) ? block.net : [];
      const smoothed = rollingCircularMean(nets, rollingMeanWindowSlots());
      const step = 24 / slotsPerDay;
      const perH = 60 / slotDurationMinutes;
      return smoothed.map((y, slot) => ({ x: (slot + 0.5) * step, y: y * perH }));
    }

    function buildRawChartPoints(station, field) {
      const block = station[dayType];
      const vals = block && Array.isArray(block[field]) ? block[field] : [];
      const step = 24 / slotsPerDay;
      const perH = 60 / slotDurationMinutes;
      return vals.map((v, slot) => ({ x: (slot + 0.5) * step, y: v * perH }));
    }

    function buildFullnessChartPoints(station) {
      const fullness = computeFullness(station);
      const step = 24 / slotsPerDay;
      return fullness.map((y, slot) => ({ x: (slot + 0.5) * step, y }));
    }

    // ── Chart modal ───────────────────────────────────────────────────────

    function getChartModalSubtitle() {
      if (viewMode === "fullness") {
        return `${dayTypeLabel(dayType)} · Estimated dock fullness based on the running balance of arrivals vs. departures (smoothed over ${rollingWindowHoursLabel()} windows). 0 = likely empty, 1 = likely full.`;
      }
      return `${dayTypeLabel(dayType)} · Net trip balance (arrivals minus departures) per time slot, smoothed over ${rollingWindowHoursLabel()} windows, in trips/h.`;
    }

    function closeStationChart() {
      chartModal.classList.remove("is-open");
      chartModal.setAttribute("aria-hidden", "true");
      chartStation = null;
      if (stationChart) { stationChart.destroy(); stationChart = null; }
    }

    function syncStationChart() {
      if (!chartModal.classList.contains("is-open") || !chartStation || !stationChart) return;
      if (viewMode === "fullness") {
        stationChart.data.datasets[0].data = buildFullnessChartPoints(chartStation);
      } else {
        stationChart.data.datasets[0].data = buildRollingChartPoints(chartStation);
        stationChart.data.datasets[1].data = buildRawChartPoints(chartStation, "dep");
        stationChart.data.datasets[2].data = buildRawChartPoints(chartStation, "arr");
      }
      stationChart.options.plugins.sliderLine.hourAtMidSlot = cursorHourAtMidSlot();
      stationChart.update();
    }

    function openStationChart(station) {
      chartStation = station;
      chartModalTitle.textContent = station.name || station.id || "Station";
      chartModalSubtitle.textContent = getChartModalSubtitle();
      chartModal.classList.add("is-open");
      chartModal.setAttribute("aria-hidden", "false");

      if (typeof Chart === "undefined" || !chartCanvas) {
        chartModalSubtitle.textContent =
          "Chart library failed to load. Ensure vendor/chart.umd.min.js is present.";
        return;
      }

      if (stationChart) { stationChart.destroy(); stationChart = null; }

      if (!station[dayType] || !Array.isArray(station[dayType].net)) {
        chartModalSubtitle.textContent =
          `JSON has no "${dayType}" series. Re-run src/build_station_hourly_json.py.`;
        return;
      }

      const ctx = chartCanvas.getContext("2d");
      if (!ctx) return;

      let datasets, yAxis;

      if (viewMode === "fullness") {
        datasets = [{
          label: "Fullness estimate [0 = empty, 1 = full]",
          data: buildFullnessChartPoints(station),
          borderColor: "#7c3aed",
          backgroundColor: "rgba(124, 58, 237, 0.12)",
          borderWidth: 2, fill: true, tension: 0,
          pointRadius: slotsPerDay <= 24 ? 3 : 2, pointHoverRadius: 6, parsing: false,
        }];
        yAxis = {
          min: 0, max: 1,
          title: { display: true, text: "Fullness estimate", font: { family: "system-ui, sans-serif", size: 12 } },
          ticks: { font: { family: "system-ui, sans-serif", size: 11 }, callback: (v) => `${Math.round(v * 100)}%` },
          grid: { color: "rgba(15, 23, 42, 0.06)" },
        };
      } else {
        datasets = [
          {
            label: `${rollingWindowHoursLabel()} rolling net (arrivals/h)`,
            data: buildRollingChartPoints(station),
            borderColor: "#0369a1", backgroundColor: "rgba(3, 105, 161, 0.12)",
            borderWidth: 2, fill: true, tension: 0,
            pointRadius: slotsPerDay <= 24 ? 3 : 2, pointHoverRadius: 6,
            parsing: false, order: 1,
          },
          {
            label: "Departures (trips/h)",
            data: buildRawChartPoints(station, "dep"),
            borderColor: "rgba(220, 38, 38, 0.7)", borderWidth: 1.5, borderDash: [4, 3],
            fill: false, tension: 0, pointRadius: 0, pointHoverRadius: 4,
            parsing: false, order: 2,
          },
          {
            label: "Arrivals (trips/h)",
            data: buildRawChartPoints(station, "arr"),
            borderColor: "rgba(22, 163, 74, 0.7)", borderWidth: 1.5, borderDash: [4, 3],
            fill: false, tension: 0, pointRadius: 0, pointHoverRadius: 4,
            parsing: false, order: 2,
          },
        ];
        yAxis = {
          title: { display: true, text: "Trips/h", font: { family: "system-ui, sans-serif", size: 12 } },
          ticks: { font: { family: "system-ui, sans-serif", size: 11 } },
          grid: { color: "rgba(15, 23, 42, 0.06)" },
        };
      }

      stationChart = new Chart(ctx, {
        plugins: [sliderLinePlugin],
        type: "line",
        data: { datasets },
        options: {
          responsive: true, maintainAspectRatio: false,
          interaction: { intersect: false, mode: "index" },
          plugins: {
            legend: { display: true, labels: { font: { family: "system-ui, sans-serif", size: 11 }, boxWidth: 12 } },
            sliderLine: { hourAtMidSlot: cursorHourAtMidSlot() },
            tooltip: {
              titleFont: { family: "system-ui, sans-serif" },
              bodyFont: { family: "system-ui, sans-serif" },
              callbacks: {
                title(items) { return items.length ? formatClockFromDecimalHour(items[0].parsed.x) : ""; },
                label(item) {
                  const y = item.parsed.y;
                  const v = typeof y === "number" && !Number.isNaN(y)
                    ? (viewMode === "fullness" ? `${Math.round(y * 100)}%` : y.toFixed(3))
                    : String(y);
                  return `${item.dataset.label}: ${v}`;
                },
              },
            },
          },
          scales: {
            x: {
              type: "linear", min: 0, max: 24,
              title: { display: true, text: "Time of day (24 h)", font: { family: "system-ui, sans-serif", size: 12 } },
              ticks: { stepSize: 2, font: { family: "system-ui, sans-serif", size: 11 }, callback: (v) => formatAxisTickHour(v) },
              grid: { color: "rgba(15, 23, 42, 0.06)" },
            },
            y: yAxis,
          },
        },
      });

      chartModalClose.focus();
    }

    chartModalClose.addEventListener("click", closeStationChart);
    chartModalBackdrop.addEventListener("click", closeStationChart);
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && chartModal.classList.contains("is-open")) closeStationChart();
    });

    // ── Grid vector field (canvas) ─────────────────────────────────────────

    function drawVectorField() {
      if (!gridData || viewMode !== "vector") return;
      const ctx = vectorCanvas.getContext("2d");
      ctx.clearRect(0, 0, vectorCanvas.width, vectorCanvas.height);

      const m = gridData.meta;
      const { rows, cols, latMin, latMax, lngMin, lngMax } = m;
      const slot = parseInt(hourSlider.value, 10);
      const dxSlot = gridData[dayType].dx[slot];
      const dySlot = gridData[dayType].dy[slot];
      const nSlot  = gridData[dayType].n[slot];
      const maxN   = gridData._maxN;

      // Estimate screen size of one grid cell for arrow scaling
      const ptNW = map.latLngToContainerPoint(L.latLng(latMax, lngMin));
      const ptSE = map.latLngToContainerPoint(L.latLng(latMin, lngMax));
      const cellPx = Math.max(8, Math.min(
        (ptSE.x - ptNW.x) / cols,
        (ptSE.y - ptNW.y) / rows
      ));

      const latRange = latMax - latMin;
      const lngRange = lngMax - lngMin;

      for (let r = 0; r < rows; r++) {
        // Row 0 = northernmost (latMax), row rows-1 = southernmost (latMin)
        const lat = latMax - (r + 0.5) * latRange / rows;
        for (let c = 0; c < cols; c++) {
          const lng = lngMin + (c + 0.5) * lngRange / cols;
          const cellIdx = r * cols + c;
          const n = nSlot[cellIdx];
          if (n < 3) continue;  // skip cells with too few samples
          const dx = dxSlot[cellIdx];
          const dy = dySlot[cellIdx];
          // Weight by traffic volume (sqrt-scaled so low-traffic cells aren't invisible)
          const weight = Math.min(1, Math.sqrt(n / maxN));

          const pt = map.latLngToContainerPoint(L.latLng(lat, lng));
          drawArrow(ctx, pt.x, pt.y, dx, dy, weight, cellPx);
        }
      }
    }

    function loadGridData() {
      if (gridData || gridLoading) return;
      gridLoading = true;
      setStatus(statusEl, true, "Loading direction data…");
      fetch(DATA_GRID)
        .then((r) => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); })
        .then((data) => {
          gridData = data;
          // Compute 95th-percentile of n across all day types / slots for normalization
          const allN = [];
          for (const dt of ["weekday", "weekend"]) {
            if (!data[dt] || !data[dt].n) continue;
            for (const slotArr of data[dt].n) {
              for (const v of slotArr) { if (v > 0) allN.push(v); }
            }
          }
          allN.sort((a, b) => a - b);
          gridData._maxN = allN.length
            ? allN[Math.floor(allN.length * 0.95)]
            : 1;
          gridLoading = false;
          setStatus(statusEl, false);
          if (viewMode === "vector") {
            resizeVectorCanvas();
            drawVectorField();
          }
        })
        .catch((err) => {
          console.error(err);
          gridLoading = false;
          setStatus(statusEl, true, "Could not load data/grid_vectors.json.");
        });
    }

    if (BOUNDARY_URL) {
      fetch(BOUNDARY_URL)
        .then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); })
        .then(data => { boundaryData = data; })
        .catch(err => console.warn("Could not load boundary GeoJSON:", err));
    }

    // Redraw canvas whenever the map view changes
    map.on("move zoom viewreset resize zoomend moveend", () => {
      if (viewMode === "vector") {
        if (map.getContainer().clientWidth !== vectorCanvas.width ||
            map.getContainer().clientHeight !== vectorCanvas.height) {
          resizeVectorCanvas();
        }
        drawVectorField();
      }
      if (voronoiIsActive()) scheduleVoronoiDraw();
    });

    function isInsideBoundary(x, y) {
      if (!activeBoundaryPath) return true;
      const ctx = voronoiCanvas.getContext("2d");
      return ctx.isPointInPath(activeBoundaryPath, x, y);
    }

    voronoiCanvas.addEventListener("mousemove", (e) => {
      if (!activeVoronoi) return;
      const rect = voronoiCanvas.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;
      if (!isInsideBoundary(x, y)) { hideVoronoiTooltip(); return; }
      const i = activeVoronoi.voronoi.delaunay.find(x, y);
      if (i == null || i < 0) {
        hideVoronoiTooltip();
        return;
      }
      showVoronoiTooltip(
        e.clientX,
        e.clientY,
        activeVoronoi.stations[i],
        activeVoronoi.visuals[i].tipBody
      );
    });

    voronoiCanvas.addEventListener("mouseleave", hideVoronoiTooltip);

    voronoiCanvas.addEventListener("click", (e) => {
      if (!activeVoronoi) return;
      const rect = voronoiCanvas.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;
      if (!isInsideBoundary(x, y)) return;
      const i = activeVoronoi.voronoi.delaunay.find(x, y);
      if (i >= 0) openStationChart(activeVoronoi.stations[i]);
    });

    // ── Marker refresh ────────────────────────────────────────────────────

    function refreshMarkers() {
      if (!payload) return;
      const q = searchQuery.toLowerCase();
      const slot = parseInt(hourSlider.value, 10);

      for (let i = 0; i < markers.length; i++) {
        const m = markers[i];
        const s = m.station;
        const dimmed = q.length > 0 && !(s.name || s.id || "").toLowerCase().includes(q);

        if (viewMode === "vector" || voronoiIsActive()) {
          m.setStyle({ fillOpacity: 0, opacity: 0, weight: 0 });
          m.setRadius(0);
          continue;
        }

        m.setRadius(markerRadius(m));

        const visual = getStationVisual(s, slot, dimmed);
        m.setStyle({
          fillColor: visual.fillColor,
          color: "rgba(30, 41, 59, 0.42)",
          weight: 1,
          fillOpacity: dimmed ? 0.1 : 0.92,
          opacity: dimmed ? 0.2 : 1,
        });
        const tt = m.getTooltip();
        if (tt) {
          tt.setContent(`<strong>${escapeHtml(s.name || s.id)}</strong><br/>${visual.tipBody}`);
        }
      }

      if (viewMode === "vector") drawVectorField();
      syncVoronoiLayer();
    }

    // ── Mode / day-type toggles ───────────────────────────────────────────

    function updateLegend() {
      const l = LEGEND[viewMode] || LEGEND.net;
      if (legendBar) {
        legendBar.style.background = viewMode === "vector"
          ? "linear-gradient(90deg,hsl(0,90%,32%),hsl(90,90%,32%),hsl(180,90%,32%),hsl(270,90%,32%),hsl(360,90%,32%))"
          : "";
      }
      if (legendLabelMin) legendLabelMin.textContent = l.min;
      if (legendLabelMid) legendLabelMid.textContent = l.mid;
      if (legendLabelMax) legendLabelMax.textContent = l.max;
      let caption = l.caption;
      if (voronoiIsActive()) {
        caption += " Voronoi regions show nearest-station color at 20% opacity.";
      }
      if (legendCaptionEl) legendCaptionEl.textContent = caption;
    }

    function setViewMode(mode) {
      viewMode = mode;
      btnModeNet.classList.toggle("is-active", mode === "net");
      btnModeFullness.classList.toggle("is-active", mode === "fullness");
      btnModeVector.classList.toggle("is-active", mode === "vector");
      updateLegend();

      if (mode === "vector") {
        vectorCanvas.style.display = "block";
        resizeVectorCanvas();
        loadGridData();
        if (gridData) drawVectorField();
      } else {
        vectorCanvas.style.display = "none";
        const ctx = vectorCanvas.getContext("2d");
        ctx.clearRect(0, 0, vectorCanvas.width, vectorCanvas.height);
      }

      refreshMarkers();

      if (chartModal.classList.contains("is-open") && chartStation) {
        chartModalSubtitle.textContent = getChartModalSubtitle();
        openStationChart(chartStation);
      }
    }

    function setDayType(next) {
      dayType = next;
      btnWeekday.classList.toggle("is-active", next === "weekday");
      btnWeekend.classList.toggle("is-active", next === "weekend");
      refreshMarkers();
      if (chartModal.classList.contains("is-open") && chartStation) {
        chartModalSubtitle.textContent = getChartModalSubtitle();
        syncStationChart();
      }
    }

    btnWeekday.addEventListener("click", () => setDayType("weekday"));
    btnWeekend.addEventListener("click", () => setDayType("weekend"));
    btnModeNet.addEventListener("click", () => setViewMode("net"));
    btnModeFullness.addEventListener("click", () => setViewMode("fullness"));
    btnModeVector.addEventListener("click", () => setViewMode("vector"));

    if (voronoiToggle) {
      voronoiToggle.addEventListener("change", () => {
        voronoiMode = voronoiToggle.checked;
        refreshMarkers();
      });
    }

    // ── Slider / play ─────────────────────────────────────────────────────

    hourSlider.addEventListener("input", () => {
      const slot = parseInt(hourSlider.value, 10);
      hourDisplay.textContent = slotLabel();
      hourSlider.setAttribute("aria-valuenow", String(slot));
      hourSlider.setAttribute("aria-valuetext", slotLabel());
      refreshMarkers();
      syncStationChart();
    });

    function stopPlay() {
      if (playInterval) { clearInterval(playInterval); playInterval = null; }
      playBtn.textContent = "▶";
      playBtn.setAttribute("aria-label", "Play time animation");
      playBtn.classList.remove("is-playing");
    }

    function startPlay() {
      playBtn.textContent = "⏸";
      playBtn.setAttribute("aria-label", "Pause time animation");
      playBtn.classList.add("is-playing");
      playInterval = setInterval(() => {
        const next = (parseInt(hourSlider.value, 10) + 1) % slotsPerDay;
        hourSlider.value = String(next);
        hourSlider.dispatchEvent(new Event("input"));
      }, PLAY_INTERVAL_MS);
    }

    playBtn.addEventListener("click", () => playInterval ? stopPlay() : startPlay());

    // ── Search ────────────────────────────────────────────────────────────

    stationSearch.addEventListener("input", () => {
      searchQuery = stationSearch.value.trim();
      refreshMarkers();
      if (searchQuery) {
        const q = searchQuery.toLowerCase();
        const first = markers.find(m => (m.station.name || m.station.id || "").toLowerCase().includes(q));
        if (first) map.panTo(first.getLatLng());
      }
    });

    markerSizeSlider.addEventListener("input", () => {
      markerScale = parseInt(markerSizeSlider.value, 10) / 100;
      markerSizeDisplay.textContent = `${markerScale.toFixed(1)}×`;
      refreshMarkers();
    });

    // ── Data load ─────────────────────────────────────────────────────────

    fetch(DATA_STATIONS)
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then((data) => {
        payload = data;
        const meta = data.meta || {};
        slotsPerDay = Number(meta.slotsPerDay) || 24;
        slotDurationMinutes = Number(meta.slotDurationMinutes) || 1440 / slotsPerDay;

        hourSlider.min = "0";
        hourSlider.max = String(Math.max(0, slotsPerDay - 1));
        if (parseInt(hourSlider.value, 10) > slotsPerDay - 1) {
          hourSlider.value = String(Math.min(12, slotsPerDay - 1));
        }

        if (provenanceEl) {
          const files = Array.isArray(meta.source_files) ? meta.source_files : [];
          const genAt = data.generated_at
            ? new Date(data.generated_at).toLocaleDateString("en-US", {
                year: "numeric", month: "short", day: "numeric",
              })
            : null;
          const parts = [];
          const MONTH_NAMES = ["January","February","March","April","May","June","July","August","September","October","November","December"];
          const ymValues = files.map(f => { const m = /^(\d{4})(\d{2})/.exec(f); return m ? parseInt(m[1]) * 100 + parseInt(m[2]) : null; }).filter(v => v != null);
          if (ymValues.length) {
            const fmt = ym => `${MONTH_NAMES[ym % 100 - 1]} ${Math.floor(ym / 100)}`;
            const minYm = Math.min(...ymValues);
            const maxYm = Math.max(...ymValues);
            parts.push(minYm === maxYm ? fmt(minYm) : `${fmt(minYm)} – ${fmt(maxYm)}`);
          }
          if (genAt) parts.push(`Built ${genAt}`);
          provenanceEl.textContent = parts.join(" · ");
        }

        const stations = data.stations || [];
        if (stations.length === 0) { setStatus(statusEl, true, "No stations in data."); return; }

        maxVolume = 1;
        for (const s of stations) {
          s._volume = {};
          for (const dt of ["weekday", "weekend"]) {
            const block = s[dt];
            let vol = 0;
            if (block && Array.isArray(block.dep) && Array.isArray(block.arr)) {
              for (let k = 0; k < block.dep.length; k++) vol += block.dep[k] + block.arr[k];
            }
            s._volume[dt] = vol;
            if (vol > maxVolume) maxVolume = vol;
          }
        }

        const latlngs = [];
        for (let i = 0; i < stations.length; i++) {
          const s = stations[i];
          const ll = [s.lat, s.lng];
          latlngs.push(ll);
          const m = L.circleMarker(ll, { radius: 6 });
          m.station = s;
          m._volume = s._volume;
          m.bindTooltip("", {
            direction: "top", offset: [0, -6], opacity: 1,
            className: "station-tip", sticky: true,
          });
          m.on("click", (e) => { L.DomEvent.stopPropagation(e); openStationChart(s); });
          m.addTo(map);
          markers.push(m);
        }

        if (latlngs.length) map.fitBounds(L.latLngBounds(latlngs).pad(0.08));

        hourDisplay.textContent = slotLabel();
        hourSlider.setAttribute("aria-valuemax", String(slotsPerDay - 1));
        refreshMarkers();
        setStatus(statusEl, false);
      })
      .catch((err) => {
        console.error(err);
        setStatus(statusEl, true, "Could not load data/stations_hourly.json. Serve this folder over HTTP.");
      });
  }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;")
      .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", main);
  } else {
    main();
  }
})();
