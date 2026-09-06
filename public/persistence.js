const keyFor = (jobId) => `tiku:import-studio:${jobId}`;

export function saveStudio(jobId, value) {
  try { localStorage.setItem(keyFor(jobId), JSON.stringify(value)); } catch { /* local storage is an optional recovery layer */ }
}

export function loadStudio(jobId) {
  try { return JSON.parse(localStorage.getItem(keyFor(jobId)) || 'null'); } catch { return null; }
}
