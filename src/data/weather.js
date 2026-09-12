/**
 * Weather and time of day are separate axes, deliberately: "storm at dusk" and
 * "storm at noon" are different missions (spec §61-63, §111 on contrast).
 *
 * Every field here is consumed by something the player can feel — wind pushes the
 * aircraft, gust shakes it, visibility decides how late a checkpoint appears out of
 * the murk. None of it is decoration (§62).
 */
export const WEATHER = {
  clear: {
    id: 'clear', name: 'CLEAR',
    cloudCover: 0.12, cloudHeight: 1500, rain: 0, wind: 2.5, gust: 0.05,
    visibility: 1, lightning: 0, hazeTint: 0xb9d6ea,
  },
  cloudy: {
    id: 'cloudy', name: 'OVERCAST',
    cloudCover: 0.62, cloudHeight: 1050, rain: 0, wind: 6, gust: 0.22,
    visibility: 0.82, lightning: 0, hazeTint: 0xa8b6c2,
  },
  fog: {
    id: 'fog', name: 'SEA FOG',
    cloudCover: 0.4, cloudHeight: 700, rain: 0, wind: 2, gust: 0.08,
    visibility: 0.38, lightning: 0, hazeTint: 0xc3ccd2,
  },
  rain: {
    id: 'rain', name: 'RAIN',
    cloudCover: 0.86, cloudHeight: 820, rain: 0.6, wind: 9, gust: 0.4,
    visibility: 0.58, lightning: 0.04, hazeTint: 0x8c99a4,
  },
  storm: {
    id: 'storm', name: 'STORM',
    cloudCover: 0.98, cloudHeight: 640, rain: 1, wind: 17, gust: 1,
    visibility: 0.34, lightning: 1, hazeTint: 0x6b747e,
  },
};

export const WEATHER_ORDER = ['clear', 'cloudy', 'fog', 'rain', 'storm'];

/** Named times of day, in hours. */
export const TIMES = {
  dawn: 6.2,
  morning: 9,
  noon: 12.5,
  afternoon: 15.5,
  sunset: 18.7,
  dusk: 19.8,
  night: 22.5,
  midnight: 1,
};

export const TIME_ORDER = ['dawn', 'morning', 'noon', 'afternoon', 'sunset', 'dusk', 'night', 'midnight'];

export function weatherLabel(id) {
  return WEATHER[id]?.name ?? 'CLEAR';
}

export function timeLabel(key) {
  const h = TIMES[key] ?? 12;
  const hh = Math.floor(h);
  const mm = Math.round((h - hh) * 60);
  return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
}
