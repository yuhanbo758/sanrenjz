// 纯计算模块：日期运算使用 UTC 日历日，避免夏令时让“加一天”变成 23/25 小时。
const ZONES = ['local', 'UTC', 'Asia/Shanghai', 'Asia/Tokyo', 'Europe/London', 'America/New_York', 'America/Los_Angeles', 'Australia/Sydney'];

function parseInstant(value, now = Date.now()) {
  const input = String(value || '').trim();
  if (!input) return new Date(now);
  if (/^-?\d{10}$/.test(input)) return validDate(Number(input) * 1000);
  if (/^-?\d{13}$/.test(input)) return validDate(Number(input));
  // 无时区的日期时间统一按系统本地时间解析；带 Z/偏移量的 ISO 保留其明确时区。
  if (!/^\d{4}-\d{2}-\d{2}(?:[ T]\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})?)?$/.test(input)) throw new Error('请输入 10/13 位时间戳或 ISO 日期时间');
  parseDay(input.slice(0, 10));
  const date = validDate(new Date(input.replace(' ', 'T')));
  if (input.length === 10 && date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate()) !== input) throw new Error('日期不存在');
  return date;
}
function validDate(value) { const date = value instanceof Date ? value : new Date(value); if (!Number.isFinite(date.getTime())) throw new Error('日期或时间戳超出范围'); return date; }
function pad(value) { return String(value).padStart(2, '0'); }
function formatZone(date, zone) {
  if (!ZONES.includes(zone)) throw new Error('不支持的时区');
  const options = { year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' };
  return new Intl.DateTimeFormat('zh-CN', zone === 'local' ? options : { ...options, timeZone: zone }).format(date);
}
function timeDetails(value, zone = 'local', now) {
  const date = parseInstant(value, now);
  return { iso: date.toISOString(), display: formatZone(date, zone), seconds: Math.floor(date.getTime() / 1000), milliseconds: date.getTime(), utc: formatZone(date, 'UTC') };
}
function parseDay(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || ''));
  if (!match) throw new Error('日期请使用 YYYY-MM-DD');
  const day = new Date(Date.UTC(+match[1], +match[2] - 1, +match[3]));
  if (day.toISOString().slice(0, 10) !== value) throw new Error('日期不存在');
  return day;
}
function addDays(value, amount) {
  if (!Number.isInteger(amount) || Math.abs(amount) > 100000) throw new Error('天数须为绝对值不超过 100000 的整数');
  const day = parseDay(value);
  day.setUTCDate(day.getUTCDate() + amount);
  return day.toISOString().slice(0, 10);
}
function dayDifference(first, second) { return Math.round((parseDay(second) - parseDay(first)) / 86400000); }
function addBusinessDays(value, amount) {
  if (!Number.isInteger(amount) || Math.abs(amount) > 10000) throw new Error('工作日数须为绝对值不超过 10000 的整数');
  const day = parseDay(value); let remaining = Math.abs(amount); const step = Math.sign(amount);
  while (remaining) { day.setUTCDate(day.getUTCDate() + step); if (![0, 6].includes(day.getUTCDay())) remaining--; }
  return day.toISOString().slice(0, 10);
}
const UNIT_GROUPS = {
  length: { mm:.001, cm:.01, m:1, km:1000, in:.0254, ft:.3048, mi:1609.344 },
  mass: { mg:.000001, g:.001, kg:1, t:1000, lb:.45359237, oz:.028349523125 },
  area: { 'm²':1, 'km²':1e6, mu:2000/3, ha:10000, acre:4046.8564224 },
  volume: { ml:.001, l:1, 'm³':1000, 'fl oz':.0295735295625, gal:3.785411784 },
  speed: { 'm/s':1, 'km/h':1/3.6, mph:.44704, knot:1852/3600 },
  data: { B:1, KB:1000, MB:1e6, GB:1e9, KiB:1024, MiB:1048576, GiB:1073741824 },
  duration: { ms:.001, s:1, min:60, h:3600, day:86400, week:604800 }
};
function convertUnit(value, group, from, to) {
  const number = Number(value);
  if (value === '' || !Number.isFinite(number)) throw new Error('请输入有效数字');
  if (group === 'temperature') {
    if (!['°C', '°F', 'K'].includes(from) || !['°C', '°F', 'K'].includes(to)) throw new Error('请选择有效温度单位');
    const celsius = from === '°F' ? (number - 32) * 5 / 9 : from === 'K' ? number - 273.15 : number;
    if (celsius < -273.15 - 1e-9) throw new Error('温度低于绝对零度');
    return to === '°F' ? celsius * 9 / 5 + 32 : to === 'K' ? celsius + 273.15 : celsius;
  }
  const units = UNIT_GROUPS[group];
  if (!units || !Object.hasOwn(units, from) || !Object.hasOwn(units, to)) throw new Error('请选择同一类别的有效单位');
  return number * units[from] / units[to];
}
module.exports = { ZONES, UNIT_GROUPS, parseInstant, formatZone, timeDetails, parseDay, addDays, dayDifference, addBusinessDays, convertUnit };
