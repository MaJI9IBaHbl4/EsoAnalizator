/* Checks the bucketing maths outside the browser: timezone bugs are silent. */
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const docs = path.join(__dirname, "..", "docs", "js");
const sandbox = { window: {}, document: { getElementById: () => null }, console, Intl, Date, Math, Number, Object, Array, Set, Map, JSON, isNaN };
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
for (const file of ["core.js", "agg.js"]) {
  vm.runInContext(fs.readFileSync(path.join(docs, file), "utf8"), sandbox, { filename: file });
}
const { core, agg } = sandbox.window.ESO;

let failures = 0;
function check(name, actual, expected) {
  const ok = actual === expected;
  if (!ok) failures += 1;
  console.log(`${ok ? "OK  " : "FAIL"} ${name}: ${actual}${ok ? "" : `  (ожидалось ${expected})`}`);
}

const asVilnius = (t) => new Intl.DateTimeFormat("lt-LT", {
  timeZone: "Europe/Vilnius", year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", hourCycle: "h23",
}).format(new Date(t));

// Summer: Vilnius is UTC+3. 2026-08-28 00:30 local = 2026-08-27 21:30 UTC.
const summer = Date.parse("2026-08-27T21:30:00Z");
check("день (лето) начинается в местную полночь", asVilnius(agg.bucketStart(summer, "day")), "2026-08-28 00:00");
check("час (лето)", asVilnius(agg.bucketStart(summer, "hour")), "2026-08-28 00:00");

// Winter: Vilnius is UTC+2. 2026-01-15 00:30 local = 2026-01-14 22:30 UTC.
const winter = Date.parse("2026-01-14T22:30:00Z");
check("день (зима) начинается в местную полночь", asVilnius(agg.bucketStart(winter, "day")), "2026-01-15 00:00");

// 2026-08-28 is a Friday; its week must start on Monday 2026-08-24.
check("неделя начинается с понедельника", asVilnius(agg.bucketStart(summer, "week")), "2026-08-24 00:00");
check("месяц", asVilnius(agg.bucketStart(summer, "month")), "2026-08-01 00:00");

// Day-of-week and hour-of-day, as the heatmap reads them.
check("пятница = индекс 4", core.weekdayIndex(Date.parse("2026-08-28T12:00:00Z")), 4);
check("час 00 по местному, а не по UTC", core.hourOfDay(summer), 0);

// A DST spring-forward day has 23 hours; the next bucket must still be midnight.
const dstDay = Date.parse("2026-03-29T00:30:00Z"); // 03:30 local, right after the jump
check("день перехода на летнее время", asVilnius(agg.bucketStart(dstDay, "day")), "2026-03-29 00:00");
check("следующий день после перехода", asVilnius(agg.nextBucket(agg.bucketStart(dstDay, "day"), "day")), "2026-03-30 00:00");

// Aggregation never sums: these are states, not events.
const rows = [
  { t: summer, n: 10, c: 1, k: 2, p: 0 },
  { t: summer + 900000, n: 30, c: 3, k: 4, p: 0 },
];
check("среднее", agg.overall(rows, ["n"], "avg").n, 20);
check("максимум", agg.overall(rows, ["n"], "max").n, 30);
check("минимум", agg.overall(rows, ["n"], "min").n, 10);
check("последнее", agg.overall(rows, ["n"], "last").n, 30);
check("суммы нет в списке агрегаций", Object.keys(agg.AGGREGATIONS).includes("sum"), false);

// Gaps must survive bucketing as gaps, not be closed silently.
const gapRows = [
  { t: Date.parse("2026-08-20T09:00:00Z"), n: 5, c: 0, k: 0, p: 0 },
  { t: Date.parse("2026-08-23T09:00:00Z"), n: 7, c: 0, k: 0, p: 0 },
];
const buckets = agg.bucketRows(gapRows, "day");
check("пропуск даёт пустые интервалы", buckets.length, 4);
check("средний интервал пуст", agg.summarise(buckets, ["n"], "avg")[1].n, null);

console.log(failures ? `\n${failures} проверок провалено` : "\nвсе проверки прошли");
process.exit(failures ? 1 : 0);
