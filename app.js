// app.js — history.json なし版（夏冬分割＋baseline自己更新, 彦根固定）

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

  // 祝日・土日
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

  // --- 日別 tmin/tmax を抽出（彦根 60131 を優先） ---
  function extractDailyTemps(jmaJson) {
    const preferCode = "60131"; // 彦根
    for (const root of jmaJson) {
      for (const ts of root.timeSeries || []) {
        const areas = ts.areas || [];
        const hit = areas.find(a => a.tempsMin || a.tempsMax);
        if (!hit) continue;
        const area = areas.find(a => a.area?.code === preferCode) || hit;
        const dates = (ts.timeDefines || []).map(t => new Date(t));
        const tmin = (area.tempsMin || []).map(v => v === "" ? null : Number(v));
        const tmax = (area.tempsMax || []).map(v => v === "" ? null : Number(v));
        return dates.map((d, i) => ({ date: d, tmin: tmin[i] ?? null, tmax: tmax[i] ?? null }));
      }
    }
    throw new Error("No daily temps (彦根) found in payload");
  }
// --- 7日間の「雨/雪フラグ」を県予報から抽出 ---
// 基本は weatherCodes（県全体の翌日〜7日）と POPs（降水確率）で判定
function extractDailyPrecipFlags(jmaJson) {
  // 県予報ブロック（配列[1]）の timeSeries[0] に dayごとの weatherCodes/pops が入ることが多い
  for (const root of jmaJson) {
    for (const ts of root.timeSeries || []) {
      const a = (ts.areas || [])[0];
      if (!a) continue;
      const codes = a.weatherCodes;
      const pops  = a.pops;
      const dates = ts.timeDefines;
      if (!codes || !dates) continue;

      const out = [];
      for (let i = 0; i < dates.length; i++) {
        const d = new Date(dates[i]);
        const code = String(codes[i] || "");
        const pop  = pops && pops[i] !== "" ? Number(pops[i]) : null;

        // ざっくり判定：
        // ・コードが3xx → 雨 / 4xx → 雪（JMA慣例にほぼ合う）
        // ・もしくは POP>=50% を雨扱い
        const rain = /^3/.test(code) || (pop !== null && pop >= 50);
        const snow = /^4/.test(code);
        out.push({ date: d, rain_flag: Number(rain), snow_flag: Number(snow) });
      }
      return out;
    }
  }
  // 取れない場合は空（あとで0埋め）
  return [];
}

  // -------- 特徴量（lagは後で入れる） --------
  function baseFeatures(rows) {
    return rows.map((r) => {
      const is_summer = cfg.isSummer(r.date);
      const holiday_flag = Number(isHolidayJP(r.date));
      const rain_flag = 0, snow_flag = 0; // MVP
      const hot_excess  = r.tmax != null ? Math.max(0, r.tmax - cfg.hot_threshold) : 0;
      const cold_excess = r.tmin != null ? Math.max(0, cfg.cold_threshold - r.tmin) : 0;
      return { ...r, is_summer, holiday_flag, rain_flag, snow_flag, hot_excess, cold_excess };
    });
  }

  // ベースライン（日平均）
  function baselineFor(d) {
    return cfg.isSummer(d) ? (cfg.baseline?.summer_daily ?? 6)
                           : (cfg.baseline?.winter_daily ?? 5.5);
  }

  // 予測（夏/冬）
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

async function runForecast() {
  try {
    $("#status").textContent = "取得中…";

    // ★開始日＝明日固定（UI表示も明日に更新）
    const start = new Date();
    start.setDate(start.getDate() + 1);
    $("#startDate").value = start.toISOString().slice(0, 10);

    // ★日数＝常に7日（入力は無視：必要ならUIも非表示OK）
    const horizon = 7;

    // JMA（滋賀県 250000）から読み取り
    const jmaRaw = await fetchJMA("250000", 60 * 60 * 1000);

    // 気温（彦根 60131 優先）
    const tempsAll = extractDailyTemps(jmaRaw);
    const temps = tempsAll
      .filter(r => r.date >= start && r.date < new Date(start.getTime() + horizon * 86400000))
      .sort((a, b) => a.date - b.date);

    // ★県予報から雨/雪判定（取れなければ後で0埋め）
    const precipAll = extractDailyPrecipFlags(jmaRaw);
    const precipMap = new Map(precipAll.map(p => [p.date.toISOString().slice(0,10), p]));

    // 特徴量（祝日フラグ等）
    const feats0 = temps.map(r => {
      const key = r.date.toISOString().slice(0,10);
      const p = precipMap.get(key);
      const rain_flag = p ? p.rain_flag : 0;
      const snow_flag = p ? p.snow_flag : 0;

      const is_summer = cfg.isSummer(r.date);
      const holiday_flag = Number(isHolidayJP(r.date));
      const hot_excess  = r.tmax != null ? Math.max(0, r.tmax - cfg.hot_threshold) : 0;
      const cold_excess = r.tmin != null ? Math.max(0, cfg.cold_threshold - r.tmin) : 0;

      return { ...r, is_summer, holiday_flag, rain_flag, snow_flag, hot_excess, cold_excess };
    });

    // 初期7日ラグ＝季節ベースラインで転がす
    let prev7 = Array.from({length:7}, () => baselineFor(start));
    const daily = [];
    for (const f of feats0) {
      const lag1 = prev7[6], lag7 = prev7[0];
      const ma7  = prev7.reduce((a,b)=>a+b,0)/prev7.length;
      const row  = { ...f, lag1, lag7, ma7 };
      const pred = predictOne(row);
      daily.push({ ...row, pred });
      prev7.shift(); prev7.push(pred);
    }

    // ★「週合計」は“明日から7日間の合計”を1行で出す
    const sum7 = daily.reduce((a, r) => a + r.pred, 0);
    const rangeLabel = `${start.toISOString().slice(0,10)} 〜 ${new Date(start.getTime()+6*86400000).toISOString().slice(0,10)}`;
    fillWeekly($("#weeklyTbl"), [{ week: rangeLabel, pred: sum7 }]);

    // 日次テーブル：祝日/雨/雪は○で表示
    const tb = $("#dailyTbl").querySelector("tbody");
    tb.innerHTML = "";
    daily.forEach(r => {
      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td>${r.date.toISOString().slice(0,10)}</td>
        <td>${r.tmin ?? ""}</td>
        <td>${r.tmax ?? ""}</td>
        <td>${r.holiday_flag ? "◯" : ""}</td>
        <td>${r.rain_flag ? "◯" : ""}</td>
        <td>${r.snow_flag ? "◯" : ""}</td>
        <td><b>${r.pred.toFixed(1)}</b></td>`;
      tb.appendChild(tr);
    });

    $("#status").textContent = "OK（明日から7日）";
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
