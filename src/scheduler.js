import { config } from './config.js';
import { startPull } from './l10.js';

// Daily wall-clock trigger in a fixed IANA timezone, with no cron dependency
// (the project deliberately avoids extra deps — see config.js's hand-rolled .env
// loader). We read "now" in the target zone via Intl, so DST is handled by the
// zone database rather than a fixed UTC offset. Sandbox VMs usually run on UTC,
// which is exactly why the zone must be pinned and not inferred from the clock.

let nextRunISO = null;
let timer = null;

export function getSchedule() {
  return {
    enabled: config.l10.enabled,
    tz: config.l10.tz,
    hour: config.l10.hour,
    minute: config.l10.minute,
    nextRun: nextRunISO,
  };
}

export function startScheduler() {
  if (!config.l10.enabled) {
    console.log('L10 daily pull: disabled (L10_PULL_ENABLED=false)');
    return;
  }
  scheduleNext();
}

function scheduleNext() {
  const ms = msUntilNext(config.l10.hour, config.l10.minute, config.l10.tz);
  nextRunISO = new Date(Date.now() + ms).toISOString();
  console.log(`L10 daily pull: next run ${nextRunISO} (${config.l10.hour}:${String(config.l10.minute).padStart(2, '0')} ${config.l10.tz})`);
  clearTimeout(timer);
  timer = setTimeout(() => {
    console.log('L10 daily pull: firing scheduled run');
    startPull({ trigger: 'schedule' });
    scheduleNext(); // re-arm for tomorrow (recomputed, so DST shifts self-correct)
  }, ms);
  timer.unref?.(); // don't keep the event loop alive just for this
}

// Milliseconds from now until the next HH:MM in `tz`. Computes the current
// seconds-of-day in the zone and the delta to the target, rolling to tomorrow
// when the target has already passed today.
function msUntilNext(hour, minute, tz) {
  const { h, m, s } = wallClock(tz);
  const nowSec = h * 3600 + m * 60 + s;
  const targetSec = hour * 3600 + minute * 60;
  let deltaSec = targetSec - nowSec;
  if (deltaSec <= 0) deltaSec += 86400;
  return deltaSec * 1000;
}

function wallClock(tz) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(new Date());
  const get = (t) => Number(parts.find((p) => p.type === t)?.value || 0);
  // Intl renders midnight as "24" in some engines; normalize to 0.
  return { h: get('hour') % 24, m: get('minute'), s: get('second') };
}
