(async function () {
  const $ = (s) => document.querySelector(s);
  const cfg = window.MODEL_CONFIG;

  // ========== ユーティリティ ==========
  const iso = (d, offset=0) => {
    const x = new Date(d); x.setDate(x.getDate()+offset);
    x.setHours(0,0,0,0);
    return x.toISOString().slice(0,10);
  };
  const weekStartISO = (d) => {
    const x = new Date(d);
    const w = (x.getDay()+6)%7; x.setDate(x.getDate()-w); x.setHours(0,0,0,0);
    return x;
  };
  function isHolidayJP(date){
    try {
      const w = date.getDay();
      const isHol = window.holiday_jp.isHoliday(new Date(iso(date)));
      return w===0 || w===6 || isHol;
    } catch { return false; }
  }

  // ========== データ取得 ==========
  async function loadHistory(){
    const res = await fetch('history.json', {cache:'no-store'});
    if(!res.ok) throw new Error('history.json not found');
    const js = await res.json();
    return js.map(d=>({date:new Date(d.date), calls:Number(d.calls)}))
             .sort((a,b)=>a.date-b.date);
  }

  async function fetchJMAWithCache(areaCode, ttlMs=60*60*1000){
    const key = `jma_forecast_${areaCode}`;
    const now = Date.now();
    const cached = localStorage.getItem(key);
    if (cached){
      const obj = JSON.parse(cached);
      if (now - obj.ts < ttlMs){ console.log('📦 JMA cache hit'); return obj.payload; }
    }
    console.log('🌐 Fetch JMA');
    const url = `https://www.jma.go.jp/bosai/forecast/data/forecast/${areaCode}.json`;
    const res = await fetch(url, {cache:'no-store'});
    if(!res.ok) throw new Error('JMA fetch failed');
    const payload = await res.json();
    localStorage.setItem(key, JSON.stringify({ts: now, payload}));
    return payload;
  }

  function extractDailyTemps(jmaJson){
    const tsArr = jmaJson?.[0]?.timeSeries || [];
    for (const ts of tsArr){
      const areas = ts.areas;
      if(!areas || !ts.timeDefines) continue;
      const dates = ts.timeDefines.map(t=>new Date(t));
      const a0 = areas[0] || {};
      if (a0.tempsMin || a0.tempsMax){
        const tmin = (a0.tempsMin||[]).map(v => v===""? null : Number(v));
        const tmax = (a0.tempsMax||[]).map(v => v===""? null : Number(v));
        return dates.map((d,i)=>({date:d, tmin:tmin[i]??null, tmax:tmax[i]??null}));
      }
    }
    throw new Error('No daily temps in JMA payload');
  }

  // ========== 特徴量生成 ==========
  function movingAverage(arr, k){
    const out=[]; for(let i=0;i<arr.length;i++){ const s=Math.max(0,i-k+1); const sl=arr.slice(s,i+1); out.push(sl.reduce((a,b)=>a+b,0)/sl.length); }
    return out;
  }
  function attachLags(forecast, history){
    const map = new Map(history.map(h=>[iso(h.date), h.calls]));
    const ma7_last = movingAverage(history.map(h=>h.calls), 7).slice(-1)[0] ?? 0;
    return forecast.map(r=>{
      const l1 = map.get(iso(r.date, -1));
      const l7 = map.get(iso(r.date, -7));
      return {...r, lag1: l1 ?? ma7_last, lag7: l7 ?? ma7_last, ma7: ma7_last};
    });
  }
  function buildFeatures(rows){
    return rows.map(r=>{
      const holiday_flag = Number(isHolidayJP(r.date));
      // MVP: 雨/雪は0（後でAPI接続）
      const rain_flag = 0, snow_flag = 0;
      // ヒンジ特徴量
      const hot = r.tmax!=null ? Math.max(0, r.tmax - cfg.hot_threshold) : 0;
      const cold = r.tmin!=null ? Math.max(0, cfg.cold_threshold - r.tmin) : 0;
      const summer = cfg.isSummer(r.date);
      return {...r, holiday_flag, rain_flag, snow_flag, hot_excess:hot, cold_excess:cold, is_summer: summer};
    });
  }

  // ========== 予測（夏モデル or 冬モデル） ==========
  function predictOne(row){
    const m = row.is_summer ? cfg.summer : cfg.winter;
    let lp = m.intercept
      + (m.beta_lag1||0)*(row.lag1??0)
      + (m.beta_lag7||0)*(row.lag7??0)
      + (m.beta_ma7 ||0)*(row.ma7 ??0)
      + (m.beta_rain||0)*(row.rain_flag??0)
      + (m.beta_snow||0)*(row.snow_flag??0);

    if (row.is_summer) lp += (m.beta_hot||0)  * (row.hot_excess ?? 0);
    else               lp += (m.beta_cold||0) * (row.cold_excess?? 0);

    return Math.max(0, Math.exp(lp));
  }

  // ========== 集計 & 表示 ==========
  function toWeekly(rows){
    const m = new Map();
    for (const r of rows){
      const wk = iso(weekStartISO(r.date));
      m.set(wk, (m.get(wk)||0) + r.pred);
    }
    return [...m.entries()].map(([week, pred])=>({week, pred}));
  }
  function fillDaily(tbl, rows){
    const tb = tbl.querySelector('tbody'); tb.innerHTML='';
    rows.forEach(r=>{
      const tr=document.createElement('tr');
      tr.innerHTML = `
        <td>${iso(r.date)}</td>
        <td>${r.tmin ?? ''}</td>
        <td>${r.tmax ?? ''}</td>
        <td>${r.is_summer ? '夏' : '冬'}</td>
        <td>${r.holiday_flag ? '◎' : ''}</td>
        <td>${r.rain_flag ? '◎' : ''}</td>
        <td>${r.snow_flag ? '◎' : ''}</td>
        <td><b>${r.pred.toFixed(1)}</b></td>`;
      tb.appendChild(tr);
    });
  }
  function fillWeekly(tbl, rows){
    const tb = tbl.querySelector('tbody'); tb.innerHTML='';
    rows.forEach(r=>{
      const tr=document.createElement('tr');
      tr.innerHTML = `<td>${r.week}</td><td><b>${r.pred.toFixed(1)}</b></td>`;
      tb.appendChild(tr);
    });
  }

  // ========== 実行 ==========
  async function runForecast(){
    try{
      $('#status').textContent = '取得中…';
      const areaCode = $('#areaCode').value.trim();
      const start = new Date($('#startDate').value);
      const horizon = Math.max(1, Math.min(14, Number($('#horizon').value)));

      const [history, jmaRaw] = await Promise.all([
        loadHistory(),
        fetchJMAWithCache(areaCode, 60*60*1000)
      ]);
      const temps = extractDailyTemps(jmaRaw)
        .filter(r => r.date >= start && r.date < new Date(start.getTime()+horizon*86400000));

      const withLags = attachLags(temps, history);
      const feats = buildFeatures(withLags);
      const daily = feats.map(f => ({...f, pred: predictOne(f)}));
      const weekly = toWeekly(daily);

      fillDaily($('#dailyTbl'), daily);
      fillWeekly($('#weeklyTbl'), weekly);
      $('#status').textContent = 'OK';
    }catch(e){
      console.error(e);
      $('#status').textContent = 'エラー: ' + e.message;
    }
  }

  // 初期設定＆自動実行
  $('#startDate').value = new Date().toISOString().slice(0,10);
  $('#runBtn').addEventListener('click', runForecast);
  runForecast();
})();
