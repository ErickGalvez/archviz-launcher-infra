'use strict';
// Pure time-window maths shared by the model supervisor (on each PC) and the hub's routines (in the launcher).
// Deliberately free of any process/file/network access, so the launcher can load it without gaining any capability.

function parseHHMM(s) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(s || ''));
  if (!m) return null;
  const h = +m[1], mi = +m[2];
  return h < 24 && mi < 60 ? h * 60 + mi : null;
}
const minutesOfDay = (ms, tz) => { const d = new Date(ms + tz * 60000); return d.getUTCHours() * 60 + d.getUTCMinutes(); };

// win = { enabled, start: 'HH:MM', end: 'HH:MM', tz: minutes east of UTC }. A window may cross midnight (22:00-06:00).
function inWindow(ms, win) {
  if (!win || win.enabled === false) return false;
  const s = parseHHMM(win.start), e = parseHHMM(win.end);
  if (s == null || e == null) return false;
  if (s === e) return true;
  const m = minutesOfDay(ms, win.tz == null ? -360 : win.tz);
  return s < e ? m >= s && m < e : m >= s || m < e;
}

// Identifies "this night": the local date on which the current window STARTED, so a job that should run once per night
// runs once even when the window crosses midnight.
function nightKey(ms, win) {
  const tz = win && win.tz != null ? win.tz : -360, s = parseHHMM(win && win.start), e = parseHHMM(win && win.end);
  let local = ms + tz * 60000;
  if (s != null && e != null && e < s && minutesOfDay(ms, tz) < e) local -= 86400000;
  return new Date(local).toISOString().slice(0, 10);
}

const DEFAULT_WINDOW = { enabled: true, start: '00:00', end: '07:00', tz: -360 };
module.exports = { parseHHMM, minutesOfDay, inWindow, nightKey, DEFAULT_WINDOW };
