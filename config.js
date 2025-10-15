// ====== 夏冬 分割モデル用 設定 ======
// R の summary() の Estimate をここに貼ってください。
// 例：calls ~ lag1 + lag7 + ma7 + hot_excess(夏) + cold_excess(冬) + rain_flag(+任意) + snow_flag(+任意)

window.MODEL_CONFIG = {
  // 閾値（必要なら変更）
  hot_threshold: 28,  // 夏: tmax - 28℃
  cold_threshold: 3,  // 冬: 3℃ - tmin

  // --- 夏モデル（5–10月） ---
  summer: {
    intercept: 1.73,
    beta_lag1:  -0.010,
    beta_lag7:  -0.005,
    beta_ma7:    0.076,
    beta_hot:    0.000,   // => pmax(tmax - hot_threshold, 0)
    beta_rain:   0.000,   // 必要なければ 0 のままでOK
    beta_snow:   0.000
  },

  // --- 冬モデル（11–4月） ---
  winter: {
    intercept: 1.73,
    beta_lag1:  -0.012,
    beta_lag7:  -0.001,
    beta_ma7:    0.077,
    beta_cold:   0.000,   // => pmax(cold_threshold - tmin, 0)
    beta_rain:   0.000,
    beta_snow:   0.000
  },

  // 季節判定（必要なら変更）
  isSummer: (date) => {
    const m = date.getMonth() + 1;
    return m >= 5 && m <= 10;
  }
};
