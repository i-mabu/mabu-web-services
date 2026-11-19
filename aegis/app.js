"use strict";
/* AEGIS Web — 地震・津波・EEW（P2P地震情報）と天気（Open-Meteo）のクライアント実装。
   震度ラベル・色分け・天気コード表は既存 AEGIS（Discord Bot / Android）の規則に合わせている。 */

// ===== 1. 定数・対応表 =====
const P2P_HISTORY = "https://api.p2pquake.net/v2/history";
const FORECAST_URL = "https://api.open-meteo.com/v1/forecast";
const GEOCODING_URL = "https://geocoding-api.open-meteo.com/v1/search";
const REFRESH_MS = 30_000;
const EEW_BANNER_WINDOW_MS = 10 * 60_000; // EEW は発生から10分以内だけバナー表示

const SCALE_LABELS = { 10: "1", 20: "2", 30: "3", 40: "4", 45: "5弱", 50: "5強", 55: "6弱", 60: "6強", 70: "7" };
// AEGIS Android の scaleColor と同じ5段階
const SCALE_COLORS = [
  { min: 45, color: "#c93a3a", cls: "scale-5" },
  { min: 40, color: "#d97a2b", cls: "scale-4" },
  { min: 30, color: "#a8871d", cls: "scale-3" },
  { min: 20, color: "#3e6b9e", cls: "scale-2" },
  { min: 10, color: "#54687f", cls: "scale-1" },
];

const TSUNAMI_LABELS = {
  None: "津波の心配なし",
  Forecast: "若干の海面変動の可能性あり",
  Advisory: "津波注意報レベル",
  Warning: "津波警報レベル",
  Unknown: "津波の有無は確認中",
};
const GRADE_LABELS = { MajorWarning: "大津波警報", Warning: "津波警報", Watch: "津波注意報" };
const GRADE_RANK = { MajorWarning: 3, Warning: 2, Watch: 1 };

const WMO_WEATHER = {
  0: "快晴", 1: "晴れ", 2: "一部曇り", 3: "曇り", 45: "霧", 48: "霧",
  51: "霧雨", 53: "霧雨", 55: "霧雨", 56: "着氷性の霧雨", 57: "着氷性の霧雨",
  61: "雨", 63: "雨", 65: "大雨", 66: "着氷性の雨", 67: "着氷性の雨",
  71: "雪", 73: "雪", 75: "大雪", 77: "雪あられ",
  80: "にわか雨", 81: "にわか雨", 82: "激しい雨", 85: "雪", 86: "雪",
  95: "雷雨", 96: "雷雨（雹）", 99: "雷雨（雹）",
};
const WMO_EMOJI = {
  0: "☀", 1: "🌤", 2: "⛅", 3: "☁", 45: "🌫", 48: "🌫",
  51: "🌦", 53: "🌦", 55: "🌦", 56: "🌧", 57: "🌧",
  61: "🌧", 63: "🌧", 65: "🌧", 66: "🌧", 67: "🌧",
  71: "🌨", 73: "🌨", 75: "🌨", 77: "🌨",
  80: "🌦", 81: "🌦", 82: "⛈", 85: "🌨", 86: "🌨",
  95: "⛈", 96: "⛈", 99: "⛈",
};

// 既定の表示地点（運用者の生活圏）
const DEFAULT_PLACES = [
  { name: "高崎", sub: "群馬県", lat: 36.3219, lon: 139.0023, removable: false },
  { name: "大宮", sub: "埼玉県", lat: 35.9064, lon: 139.6239, removable: false },
];

// ===== 2. ユーティリティ =====
const $ = (sel) => document.querySelector(sel);

function esc(s) {
  return String(s ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function numOrNull(v) {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
}

// P2P の時刻表記 "2026/11/19 06:41:00" → Date（失敗時は null）
function parseP2pTime(s) {
  if (typeof s !== "string" || !s) return null;
  const d = new Date(s.replaceAll("/", "-").replace(" ", "T") + "+09:00");
  return Number.isNaN(d.getTime()) ? null : d;
}

function fmtTime(d) {
  if (!d) return "";
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getMonth() + 1}/${d.getDate()} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

async function fetchJson(url, timeoutMs = 12_000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

function scaleLabel(scale) {
  if (!Number.isFinite(scale) || scale <= 0) return "不明";
  return SCALE_LABELS[scale] ?? String(scale);
}
function scaleStyle(scale) {
  for (const s of SCALE_COLORS) if (scale >= s.min) return s;
  return { color: "#3a465c", cls: "scale-unknown" };
}
function depthLabel(depthKm) {
  if (depthKm === null || depthKm === undefined) return "深さ不明";
  if (depthKm === -1) return "ごく浅い";
  return `約${depthKm}km`;
}

// ===== 3. P2P データのパース =====
function parseQuakes(data) {
  if (!Array.isArray(data)) return [];
  const out = [];
  for (const item of data) {
    const eq = item?.earthquake;
    if (!eq) continue;
    const hypo = eq.hypocenter ?? {};
    const magRaw = numOrNull(hypo.magnitude);
    out.push({
      id: String(item.id ?? ""),
      time: String(eq.time ?? item.time ?? ""),
      hypocenter: String(hypo.name ?? "不明"),
      magnitude: magRaw !== null && magRaw >= 0 ? magRaw : null,
      depthKm: numOrNull(hypo.depth),
      maxScale: numOrNull(eq.maxScale) ?? -1,
      tsunamiKind: String(eq.domesticTsunami ?? "None"),
      lat: numOrNull(hypo.latitude),
      lon: numOrNull(hypo.longitude),
    });
  }
  return out;
}

function parseTsunamiLatest(data) {
  if (!Array.isArray(data) || data.length === 0) return null;
  const item = data[0];
  const areas = (Array.isArray(item?.areas) ? item.areas : []).map((a) => ({
    name: String(a?.name ?? ""),
    grade: String(a?.grade ?? ""),
    cancelled: Boolean(a?.cancelled),
    maxHeight: typeof a?.maxHeight?.description === "string" ? a.maxHeight.description : null,
    arrival:
      typeof a?.firstHeight?.arrivalTime === "string" && a.firstHeight.arrivalTime.length >= 16
        ? a.firstHeight.arrivalTime.slice(11, 16)
        : null,
  }));
  let grade = "Unknown";
  for (const a of areas) {
    if (!a.cancelled && (GRADE_RANK[a.grade] ?? 0) > (GRADE_RANK[grade] ?? 0)) grade = a.grade;
  }
  const allCancelled = areas.length > 0 && areas.every((a) => a.cancelled);
  return {
    time: String(item?.issue?.time ?? item?.time ?? ""),
    cancelled: Boolean(item?.cancelled) || allCancelled,
    grade,
    areas,
  };
}

function parseEewLatest(data) {
  if (!Array.isArray(data)) return null;
  for (const item of data) {
    const eq = item?.earthquake;
    if (!eq) continue; // プレースホルダは採用しない
    const hypo = eq.hypocenter ?? {};
    const prefs = [];
    for (const a of Array.isArray(item.areas) ? item.areas : []) {
      if (a?.pref && !prefs.includes(a.pref)) prefs.push(a.pref);
    }
    return {
      originTime: String(eq.time ?? item.time ?? ""),
      cancel: Boolean(item.isCancel),
      isFinal: Boolean(item.isFinal),
      hypocenter: String(hypo.name ?? "不明"),
      estScale: numOrNull(eq.maxScale) ?? -1,
      estMagnitude: numOrNull(hypo.magnitude),
      prefs: prefs.slice(0, 8),
    };
  }
  return null;
}

// ===== 4. バナー表示（津波・EEW） =====
function renderBanners(tsunami, eew) {
  const box = $("#banners");
  const html = [];

  if (tsunami) {
    if (tsunami.cancelled) {
      html.push(
        `<div class="banner banner-tsunami-info">✅ 津波警報・注意報は解除されました` +
          `<div class="banner-sub">${esc(fmtTime(parseP2pTime(tsunami.time)))} 発表</div></div>`
      );
    } else if (tsunami.grade !== "Unknown") {
      const cls =
        tsunami.grade === "MajorWarning"
          ? "banner-tsunami-major"
          : tsunami.grade === "Warning"
            ? "banner-tsunami-warning"
            : "banner-tsunami-watch";
      const lines = tsunami.areas
        .filter((a) => !a.cancelled)
        .map((a) => {
          const bits = [esc(a.name)];
          if (a.arrival) bits.push(`到達予想 ${esc(a.arrival)}`);
          if (a.maxHeight) bits.push(`予想高さ ${esc(a.maxHeight)}`);
          return bits.join(" ／ ");
        })
        .join("<br>");
      html.push(
        `<div class="banner ${cls}">🌊 ${esc(GRADE_LABELS[tsunami.grade] ?? "津波情報")} 発表中` +
          (lines ? `<div class="banner-sub">${lines}</div>` : "") +
          `</div>`
      );
    }
  }

  if (eew) {
    const origin = parseP2pTime(eew.originTime);
    const fresh = origin && Date.now() - origin.getTime() <= EEW_BANNER_WINDOW_MS;
    if (fresh) {
      if (eew.cancel) {
        html.push(
          `<div class="banner banner-eew-cancel">緊急地震速報は取り消されました` +
            `<div class="banner-sub">震源: ${esc(eew.hypocenter)}</div></div>`
        );
      } else {
        const mag = eew.estMagnitude !== null ? ` M${eew.estMagnitude.toFixed(1)}` : "";
        const prefs = eew.prefs.length ? `<div class="banner-sub">対象: ${esc(eew.prefs.join("、"))}</div>` : "";
        html.push(
          `<div class="banner banner-eew">⚠ 緊急地震速報（${eew.isFinal ? "最終報" : "速報"}）` +
            ` 推定最大震度 ${esc(scaleLabel(eew.estScale))}` +
            `<div class="banner-sub">震源: ${esc(eew.hypocenter)}${esc(mag)} ／ ${esc(fmtTime(origin))} 発生</div>` +
            prefs +
            `</div>`
        );
      }
    }
  }

  box.innerHTML = html.join("");
}

// ===== 5. 地図と地震リスト =====
let map = null;
let markerLayer = null;

function initMap() {
  if (typeof L === "undefined") return; // CDN が読めなければ地図なしで続行
  map = L.map("map", { scrollWheelZoom: false }).setView([37.5, 138.5], 5);
  L.tileLayer("https://cyberjapandata.gsi.go.jp/xyz/std/{z}/{x}/{y}.png", {
    attribution: '<a href="https://maps.gsi.go.jp/development/ichiran.html" target="_blank" rel="noopener">地理院タイル</a>',
    maxZoom: 18,
  }).addTo(map);
  markerLayer = L.layerGroup().addTo(map);
  map.on("focus", () => map.scrollWheelZoom.enable());
  map.on("blur", () => map.scrollWheelZoom.disable());
}

function renderQuakes(quakes) {
  const list = $("#quake-list");
  if (quakes.length === 0) {
    list.innerHTML = '<li class="loading">地震情報はありません。</li>';
    return;
  }
  list.innerHTML = quakes
    .map((q, i) => {
      const st = scaleStyle(q.maxScale);
      const mag = q.magnitude !== null ? `M${q.magnitude.toFixed(1)}` : "M不明";
      const tsunami = TSUNAMI_LABELS[q.tsunamiKind] ?? TSUNAMI_LABELS.Unknown;
      return (
        `<li class="quake-item" data-idx="${i}" tabindex="0">` +
        `<div class="scale-badge ${st.cls}"><span class="scale-cap">震度</span>` +
        `<span class="scale-num">${esc(scaleLabel(q.maxScale))}</span></div>` +
        `<div class="quake-main"><div class="quake-top">` +
        `<span class="quake-place">${esc(q.hypocenter)}</span>` +
        `<span class="quake-time">${esc(fmtTime(parseP2pTime(q.time)))}</span></div>` +
        `<div class="quake-detail">${esc(mag)} ／ ${esc(depthLabel(q.depthKm))} ／ ${esc(tsunami)}</div>` +
        `</div></li>`
      );
    })
    .join("");

  // 地図マーカー
  if (map && markerLayer) {
    markerLayer.clearLayers();
    const markers = [];
    quakes.forEach((q, i) => {
      if (q.lat === null || q.lon === null) return;
      const st = scaleStyle(q.maxScale);
      const radius = 6 + Math.max(0, (q.maxScale - 10) / 10) * 2.5;
      const mag = q.magnitude !== null ? `M${q.magnitude.toFixed(1)}` : "M不明";
      const m = L.circleMarker([q.lat, q.lon], {
        radius,
        color: st.color,
        weight: 2,
        fillColor: st.color,
        fillOpacity: 0.55,
      }).bindPopup(
        `<div class="popup-title">${esc(q.hypocenter)}</div>` +
          `${esc(fmtTime(parseP2pTime(q.time)))} 発生<br>` +
          `最大震度 ${esc(scaleLabel(q.maxScale))} ／ ${esc(mag)} ／ ${esc(depthLabel(q.depthKm))}<br>` +
          esc(TSUNAMI_LABELS[q.tsunamiKind] ?? TSUNAMI_LABELS.Unknown)
      );
      m.addTo(markerLayer);
      markers[i] = m;
    });
    list.querySelectorAll(".quake-item").forEach((el) => {
      const open = () => {
        const m = markers[Number(el.dataset.idx)];
        if (m) {
          map.setView(m.getLatLng(), Math.max(map.getZoom(), 7));
          m.openPopup();
        }
      };
      el.addEventListener("click", open);
      el.addEventListener("keydown", (ev) => {
        if (ev.key === "Enter" || ev.key === " ") {
          ev.preventDefault();
          open();
        }
      });
    });
  }
}

// ===== 6. 天気 =====
let places = [...DEFAULT_PLACES];

function weatherLabel(code) {
  return code === null || code === undefined ? "不明" : (WMO_WEATHER[code] ?? "不明");
}
function weatherEmoji(code, pop) {
  let icon = code === null || code === undefined ? "☁" : (WMO_EMOJI[code] ?? "☁");
  if (pop !== null && pop !== undefined && pop >= 50 && ["☀", "🌤", "⛅", "☁"].includes(icon)) {
    icon = pop >= 80 ? "🌧" : "🌦";
  }
  return icon;
}

const WEEKDAYS = ["日", "月", "火", "水", "木", "金", "土"];
function dayLabel(dateStr) {
  const d = new Date(`${dateStr}T00:00:00+09:00`);
  if (Number.isNaN(d.getTime())) return dateStr;
  return `${d.getMonth() + 1}/${d.getDate()}(${WEEKDAYS[d.getDay()]})`;
}

async function fetchForecast(place) {
  const url =
    `${FORECAST_URL}?latitude=${place.lat}&longitude=${place.lon}` +
    `&current=temperature_2m,weather_code,wind_speed_10m` +
    `&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max` +
    `&timezone=Asia%2FTokyo&forecast_days=7`;
  const data = await fetchJson(url);
  const daily = data?.daily ?? {};
  const days = (daily.time ?? []).map((date, i) => ({
    date,
    code: numOrNull((daily.weather_code ?? [])[i]),
    tmax: numOrNull((daily.temperature_2m_max ?? [])[i]),
    tmin: numOrNull((daily.temperature_2m_min ?? [])[i]),
    pop: numOrNull((daily.precipitation_probability_max ?? [])[i]),
  }));
  const cur = data?.current ?? {};
  return {
    nowTemp: numOrNull(cur.temperature_2m),
    nowCode: numOrNull(cur.weather_code),
    nowWind: numOrNull(cur.wind_speed_10m),
    days,
  };
}

function renderWeatherCard(place, fc) {
  const rows = fc.days
    .map(
      (d) =>
        `<tr><td>${esc(dayLabel(d.date))}</td>` +
        `<td>${weatherEmoji(d.code, d.pop)} ${esc(weatherLabel(d.code))}</td>` +
        `<td><span class="tmax">${d.tmax === null ? "—" : Math.round(d.tmax) + "°"}</span>` +
        ` / <span class="tmin">${d.tmin === null ? "—" : Math.round(d.tmin) + "°"}</span></td>` +
        `<td class="pop">${d.pop === null ? "—" : Math.round(d.pop) + "%"}</td></tr>`
    )
    .join("");
  const removeBtn = place.removable
    ? `<button type="button" class="remove-place" data-remove="${esc(place.name)}">✕ 外す</button>`
    : "";
  return (
    `<div class="weather-card"><div class="weather-card-head">` +
    `<h3>${esc(place.name)}<span class="muted small"> ${esc(place.sub ?? "")}</span></h3>${removeBtn}</div>` +
    `<div class="weather-now"><span class="emoji">${weatherEmoji(fc.nowCode, null)}</span>` +
    `<span class="temp">${fc.nowTemp === null ? "—" : fc.nowTemp.toFixed(1) + "℃"}</span>` +
    `<span class="cond">現在: ${esc(weatherLabel(fc.nowCode))}` +
    (fc.nowWind !== null ? ` ／ 風速 ${fc.nowWind.toFixed(0)}m/s` : "") +
    `</span></div>` +
    `<table class="week"><thead><tr><th>日付</th><th>天気</th><th>最高/最低</th><th>降水確率</th></tr></thead>` +
    `<tbody>${rows}</tbody></table></div>`
  );
}

async function refreshWeather() {
  const box = $("#weather-cards");
  const results = await Promise.allSettled(places.map((p) => fetchForecast(p)));
  let anyOk = false;
  box.innerHTML = results
    .map((r, i) => {
      if (r.status === "fulfilled") {
        anyOk = true;
        return renderWeatherCard(places[i], r.value);
      }
      return `<div class="weather-card"><h3>${esc(places[i].name)}</h3><p class="muted">取得に失敗しました。</p></div>`;
    })
    .join("");
  $("#weather-error").hidden = anyOk;
  box.querySelectorAll("[data-remove]").forEach((btn) => {
    btn.addEventListener("click", () => {
      places = places.filter((p) => !(p.removable && p.name === btn.dataset.remove));
      refreshWeather();
    });
  });
}

async function searchPlaces(query) {
  const url = `${GEOCODING_URL}?name=${encodeURIComponent(query)}&count=5&language=ja&format=json`;
  const data = await fetchJson(url);
  const results = Array.isArray(data?.results) ? data.results : [];
  // 日本国内を優先
  return results.sort((a, b) => (b.country_code === "JP") - (a.country_code === "JP"));
}

function initSearch() {
  const form = $("#place-search");
  const input = $("#place-input");
  const list = $("#place-results");
  form.addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const q = input.value.trim();
    if (!q) return;
    list.innerHTML = '<li class="loading">検索中…</li>';
    try {
      const results = await searchPlaces(q);
      if (results.length === 0) {
        list.innerHTML = '<li class="loading">見つかりませんでした。</li>';
        return;
      }
      list.innerHTML = "";
      for (const r of results) {
        const li = document.createElement("li");
        const btn = document.createElement("button");
        btn.type = "button";
        const sub = [r.admin1, r.country].filter(Boolean).join(" ／ ");
        btn.textContent = `${r.name}（${sub}）を追加`;
        btn.addEventListener("click", () => {
          const exists = places.some(
            (p) => Math.abs(p.lat - r.latitude) < 0.01 && Math.abs(p.lon - r.longitude) < 0.01
          );
          if (!exists) {
            places = [
              ...places,
              { name: String(r.name), sub: String(r.admin1 ?? ""), lat: r.latitude, lon: r.longitude, removable: true },
            ];
          }
          list.innerHTML = "";
          input.value = "";
          refreshWeather();
        });
        li.appendChild(btn);
        list.appendChild(li);
      }
    } catch {
      list.innerHTML = '<li class="loading">検索に失敗しました。</li>';
    }
  });
}

// ===== 7. 自動更新まわり =====
let lastUpdatedAt = null;
let nextUpdateAt = null;

async function refreshDisaster() {
  const [q, t, e] = await Promise.allSettled([
    fetchJson(`${P2P_HISTORY}?codes=551&limit=10`),
    fetchJson(`${P2P_HISTORY}?codes=552&limit=5`),
    fetchJson(`${P2P_HISTORY}?codes=554&limit=10`),
  ]);
  if (q.status === "fulfilled") {
    $("#quake-error").hidden = true;
    renderQuakes(parseQuakes(q.value));
  } else {
    $("#quake-error").hidden = false;
  }
  renderBanners(
    t.status === "fulfilled" ? parseTsunamiLatest(t.value) : null,
    e.status === "fulfilled" ? parseEewLatest(e.value) : null
  );
}

async function refreshAll() {
  await Promise.allSettled([refreshDisaster(), refreshWeather()]);
  lastUpdatedAt = new Date();
  nextUpdateAt = new Date(Date.now() + REFRESH_MS);
  const p = (n) => String(n).padStart(2, "0");
  $("#last-updated").textContent =
    `最終更新 ${p(lastUpdatedAt.getHours())}:${p(lastUpdatedAt.getMinutes())}:${p(lastUpdatedAt.getSeconds())}`;
}

function tickCountdown() {
  const el = $("#next-update");
  if (!nextUpdateAt) {
    el.textContent = "";
    return;
  }
  const sec = Math.max(0, Math.round((nextUpdateAt.getTime() - Date.now()) / 1000));
  el.textContent = `次回更新まで ${sec} 秒`;
}

// ===== 8. 起動 =====
document.addEventListener("DOMContentLoaded", () => {
  initMap();
  initSearch();
  $("#reload-btn").addEventListener("click", refreshAll);
  document.querySelectorAll("[data-reload]").forEach((b) => b.addEventListener("click", refreshAll));
  refreshAll();
  setInterval(refreshAll, REFRESH_MS);
  setInterval(tickCountdown, 1000);
});
