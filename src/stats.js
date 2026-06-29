// src/stats.js
//
// Reine Statistik-Helfer (Win-Rate, Expectancy) für Worker + HTML-Rendering.
// Bewusst seiteneffektfrei und ohne env/DB, damit sie isoliert testbar und
// von mehreren Modulen (worker.js, src/render/pages.js) nutzbar sind.
// Re-exportiert über worker.js (Test-Kontrakt: import aus ../worker.js).
// winRate = wins / (wins+losses) * 100, OPEN/etc never in denominator.
function computeWinRate(wins, losses) {
  const closed = (wins || 0) + (losses || 0);
  return closed > 0 ? parseFloat(((wins || 0) / closed * 100).toFixed(1)) : 0;
}

// expectancy = (winRate/100 * avgWinPct) - (lossRate/100 * |avgLossPct|)
function computeExpectancy(wins, losses, avgWinPct, avgLossPct) {
  const winRate = computeWinRate(wins, losses);
  const lossRate = 100 - winRate;
  const expectancy = (winRate / 100) * (avgWinPct || 0) - (lossRate / 100) * Math.abs(avgLossPct || 0);
  return parseFloat(expectancy.toFixed(2));
}

export { computeWinRate, computeExpectancy };
