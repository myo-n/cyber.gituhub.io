// app.js  — history.json なし版（夏冬分割＋baseline自己更新）

(async function () {
  const $ = (s) => document.querySelector(s);
  const cfg = window.MODEL_CONFIG;

  // -------- Utils --------
  const iso = (d, off = 0) => {
    const x = new Date(d); x.setDate(x.getDate() + off); x.setHours(0,0,0,0);
    return x.toISOString().slice(0, 10);
  };
  const weekStartISO = (d) => {
    const x = new Date(d);
    const w = (x.getDay() + 6) % 7; // Mon=0
    x.setDate(x.getDate() - w); x.setHours(0,0,0,0);
    return x;
  };

  // 祝日・土日（holiday-jp を index.html で読み込み済み）
  function isHolidayJP(date) {
    try {
      const w = date.getDay();
      const isHol = window.holiday_jp.isHoliday(new Date(iso(date)));
      return w === 0 || w === 6 || isHol;
    } catch { return false; }
  }

  // -------- JMA fetch（1時間キャッシュ） --------
  async function fetchJMA(areaCode, ttlMs = 60 * 60 * 1000) {
    const key = `jma_forecast_${areaCode}`;
    const now = Date.now();
    const cached = localStorage.getItem(key);
    if (cached) {
      const obj = JSON.parse(cached);
      if (now - obj.ts < ttlMs) {
        console.log("📦 JMA cache hit");
        return obj.payload;
      }
    }
    console.log("🌐 Fetch JMA");
    const url = `https://www.jma.go.jp/bosai/forecast/data/forecast/${areaCode}.json`;
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) throw new Error("JMA fetch failed");
    const payload = await res.json();
    localStorage.setItem(key, JSON.stringify({ ts: now, payload }));
    return payload;
  }

// --- JMA forecast JSONから日別tmin/tmaxを抽出（彦根固定 60131） ---
function extractDailyTemps(jmaJson) {
  const preferCode = "60131"; // 彦根地点コード固定
  // すべてのトップレベルブロックを走査
  for (const root of jmaJson) {
    for (const ts of root.timeSeries || []) {
      const areas = ts.areas || [];
      const hit = areas.find(a => a.tempsMin || a.tempsMax);
      if (!hit) continue;

      // 彦根(60131)優先、なければ最初のエリア
      const area = areas.find(a => a.area?.code === preferCode) || hit;

      const dates = (ts.timeDefines || []).map(t => new Date(t));
      const tmin = (area.tempsMin || []).map(v => v === "" ? null : Number(v));
      const tmax = (area.tempsMax || []).map(v => v === "" ? null : Number(v));

      return dates.map((d, i) => ({
        date: d,
        tmin: tmin[i] ?? null,
        tmax: tmax[i] ?? null
      }));
    }
  }
  throw new Error("No daily temps (彦根) found in JMA payload");
}

  // -------- 特徴量（lagは後で入れる） --------
  function baseFeatures(rows) {
    return rows.map((r) => {
      const is_summer = cfg.isSummer(r.date);
      const holiday_flag = Number(isHolidayJP(r.date));
      // MVP: 雨/雪は0（後でAPI接続）
      const rain_flag = 0, snow_flag = 0;
      const hot_excess  = r.tmax != null ? Math.max(0, r.tmax - cfg.hot_threshold) : 0;
      const cold_excess = r.tmin != null ? Math.max(0, cfg.cold_threshold - r.tmin) : 0;
      return { ...r, is_summer, holiday_flag, rain_flag, snow_flag, hot_excess, cold_excess };
    });
  }

  // ベースライン（日平均）取得
  function baselineFor(d) {
    return cfg.isSummer(d) ? (cfg.baseline?.summer_daily ?? 6)
                           : (cfg.baseline?.winter_daily ?? 5.5);
  }

  // 予測（夏/冬の式を切替）
  function predictOne(row) {
    const m = row.is_summer ? cfg.summer : cfg.winter;
    let lp = m.intercept
      + (m.beta_lag1 || 0) * (row.lag1 ?? 0)
      + (m.beta_lag7 || 0) * (row.lag7 ?? 0)
      + (m.beta_ma7  || 0) * (row.ma7  ?? 0)
      + (m.beta_rain || 0) * (row.rain_flag ?? 0)
      + (m.beta_snow || 0) * (row.snow_flag ?? 0);

    if (row.is_summer) lp += (m.beta_hot  || 0) * (row.hot_excess  ?? 0);
    else               lp += (m.beta_cold || 0) * (row.cold_excess ?? 0);

    return Math.max(0, Math.exp(lp));
  }

  // 週合計
  function toWeekly(rows) {
    const m = new Map();
    for (const r of rows) {
      const wk = iso(weekStartISO(r.date));
      m.set(wk, (m.get(wk) || 0) + r.pred);
    }
    return [...m.entries()].map(([week, pred]) => ({ week, pred }));
  }

  // 表描画
  function fillDaily(tbl, rows) {
    const tb = tbl.querySelector("tbody"); tb.innerHTML = "";
    rows.forEach((r) => {
      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td>${iso(r.date)}</td>
        <td>${r.tmin ?? ""}</td>
        <td>${r.tmax ?? ""}</td>
        <td>${r.is_summer ? "夏" : "冬"}</td>
        <td>${r.holiday_flag ? "◎" : ""}</td>
        <td>${r.rain_flag ? "◎" : ""}</td>
        <td>${r.snow_flag ? "◎" : ""}</td>
        <td><b>${r.pred.toFixed(1)}</b></td>`;
      tb.appendChild(tr);
    });
  }
  function fillWeekly(tbl, rows) {
    const tb = tbl.querySelector("tbody"); tb.innerHTML = "";
    rows.forEach((r) => {
      const tr = document.createElement("tr");
      tr.innerHTML = `<td>${r.week}</td><td><b>${r.pred.toFixed(1)}</b></td>`;
      tb.appendChild(tr);
    });
  }

  // -------- 実行本体（history.jsonなし：baseline→自己更新） --------
  async function runForecast() {
    try {
      $("#status").textContent = "取得中…";
      const areaCode = $("#areaCode").value.trim();
    const start = new Date(); // 今日
    $("#startDate").value = start.toISOString().slice(0,10); // UI表示も更新

    const horizon = Math.max(1, Math.min(14, Number($("#horizon").value)));

    // 彦根固定（県予報コード）
    const jmaRaw = await fetchJMA("250000", 60 * 60 * 1000);
    const temps = extractDailyTemps(jmaRaw)
      .filter(r => r.date >= start && r.date < new Date(start.getTime() + horizon * 86400000))
      .sort((a, b) => a.date - b.date);


      // 初期の7日ラグを季節ベースラインで埋める
      let prev7 = [];
      for (let i = 0; i < 7; i++) prev7.push(baselineFor(start));

      const daily = [];
      for (const f of feats0) {
        const lag1 = prev7[6];
        const lag7 = prev7[0];
        const ma7  = prev7.reduce((a, b) => a + b, 0) / prev7.length;

        const row = { ...f, lag1, lag7, ma7 };
        const pred = predictOne(row);
        daily.push({ ...row, pred });

        // 今日の予測で prev7 を更新して「転がす」
        prev7.shift(); prev7.push(pred);
      }

      const weekly = toWeekly(daily);
      fillDaily($("#dailyTbl"), daily);
      fillWeekly($("#weeklyTbl"), weekly);
      $("#status").textContent = "OK";
    } catch (e) {
      console.error(e);
      $("#status").textContent = "エラー: " + e.message;
    }
  }

  // 初期化：今日セット＆自動実行
  $("#startDate").value = new Date().toISOString().slice(0, 10);
  $("#runBtn").addEventListener("click", runForecast);
  runForecast();
})();
