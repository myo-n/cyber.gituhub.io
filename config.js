// ====== 夏冬 分割モデル用 設定 ======
// R の summary() の Estimate をここに貼ってください。
// 例：calls ~ lag1 + lag7 + ma7 + hot_excess(夏) + cold_excess(冬) + rain_flag(+任意) + snow_flag(+任意)

window.MODEL_CONFIG = {
  // 閾値（必要なら変更）
  hot_threshold: 28,  // 夏: tmax - 28℃
  cold_threshold: 3,  // 冬: 3℃ - tmin

   baseline: {
    summer_daily: 13.7, // 5-10月の平均日件数（例）
    winter_daily: 14.3  // 11-4月の平均日件数（例）
  },

  // --- 夏モデル（5–10月） ---
  summer: {
    intercept: 1.729792,
    beta_lag1:  -0.009982,
    beta_lag7:  -0.005223,
    beta_ma7:    0.075590,
    beta_hot:    0.005346,
    beta_rain:   0.037396,
    beta_snow:   0.0         // 夏はNA→0固定
  },

  // ---- 冬（11–4月）　----
  winter: {
    intercept: 1.7303914,
    beta_lag1:  -0.0121234,
    beta_lag7:  -0.0013908,
    beta_ma7:    0.0771805,
    beta_cold:   0.0037811,   // cold_excess = max(cold_threshold - tmin, 0)
    beta_rain:   0.0321400,
    beta_snow:   0.0123866
    // temp_range や weekday/holiday は JS では使わないので未設定
  },

  // 季節判定（必要なら変更）
  isSummer: (date) => {
    const m = date.getMonth() + 1;
    return m >= 5 && m <= 10;
  }
};
