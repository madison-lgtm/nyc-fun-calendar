import fs from "fs/promises";
import https from "https";

const ROOT = new URL("../", import.meta.url);
const curatedPath = new URL("data/curated-events.json", ROOT);
const outputPath = new URL("events.json", ROOT);

const DAY_MS = 24 * 60 * 60 * 1000;
const TIME_ZONE = "America/New_York";

function getJson(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { "User-Agent": "NYC-Fun-Calendar/1.0" } }, response => {
      if (response.statusCode < 200 || response.statusCode >= 300) {
        response.resume();
        reject(new Error(`${url} returned ${response.statusCode}`));
        return;
      }
      let body = "";
      response.setEncoding("utf8");
      response.on("data", chunk => body += chunk);
      response.on("end", () => {
        try {
          resolve(JSON.parse(body));
        } catch (error) {
          reject(error);
        }
      });
    }).on("error", reject);
  });
}

function decodeHtml(value) {
  return String(value || "")
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/&#x([a-f0-9]+);/gi, (_, code) => String.fromCharCode(parseInt(code, 16)))
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, "\"")
    .replace(/&#8220;|&#8221;/g, "\"")
    .replace(/&#8211;|&#8212;/g, "-")
    .replace(/&#8217;/g, "'")
    .replace(/<[^>]*>/g, "")
    .trim();
}

function nyDateParts(date) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: TIME_ZONE,
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric"
  }).formatToParts(date);
  return Object.fromEntries(parts.map(part => [part.type, part.value]));
}

function buildWeekDays(startDate = new Date()) {
  return Array.from({ length: 7 }, (_, index) => {
    const date = new Date(startDate.getTime() + index * DAY_MS);
    const parts = nyDateParts(date);
    return {
      key: parts.weekday,
      label: parts.weekday,
      date: `${parts.month} ${parts.day}`
    };
  });
}

function slug(value) {
  return decodeHtml(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 52);
}

function inferDayFromTitle(title, fallbackDate) {
  const upper = title.toUpperCase();
  if (upper.includes("FRI")) return "Fri";
  if (upper.includes("SAT")) return "Sat";
  if (upper.includes("SUN")) return "Sun";
  if (upper.includes("MON")) return "Mon";
  if (upper.includes("TUES") || upper.includes("TUE")) return "Tue";
  if (upper.includes("WED")) return "Wed";
  if (upper.includes("THURS") || upper.includes("THU")) return "Thu";
  return nyDateParts(fallbackDate).weekday;
}

function skintDigestEvent(post, index) {
  const title = decodeHtml(post.title?.rendered || "The Skint NYC picks");
  const date = new Date(post.date_gmt ? `${post.date_gmt}Z` : post.date);
  const day = inferDayFromTitle(title, date);
  const id = `skint_${slug(title) || post.id}`;
  return [id, {
    title: title.replace(/\s+/g, " "),
    type: "art",
    label: "Daily picks",
    day,
    time: "10 AM",
    sort: 10 + index / 100,
    when: `${day} · Latest Skint digest`,
    price: "Free / cheap",
    free: true,
    place: "NYC",
    source: "The Skint",
    link: post.link,
    map: "https://maps.google.com/?q=New+York+City",
    summary: "Automatically pulled from The Skint's public WordPress API. Open the source for the full list of picks and details."
  }];
}

async function fetchSkintEvents() {
  const posts = await getJson("https://www.theskint.com/wp-json/wp/v2/posts?per_page=12");
  return posts
    .filter(post => !decodeHtml(post.title?.rendered).toUpperCase().includes("SPONSORED"))
    .filter(post => /SKINT|TUES|THURS|FRI|SAT|SUN|MON|WEEKEND|\d+\/\d+/.test(decodeHtml(post.title?.rendered).toUpperCase()))
    .slice(0, 4)
    .map(skintDigestEvent);
}

function buildClusters(events) {
  const byCell = {};
  for (const [id, event] of Object.entries(events)) {
    const key = `${event.day}|${event.time}`;
    byCell[key] = byCell[key] || [];
    byCell[key].push(id);
  }

  const clusters = {};
  for (const [key, ids] of Object.entries(byCell)) {
    if (ids.length > 1) {
      clusters[`cluster_${slug(key)}`] = ids;
    }
  }
  return clusters;
}

function buildTimes(events) {
  const order = new Map([
    ["8 AM", 8], ["9 AM", 9], ["10 AM", 10], ["11 AM", 11], ["11:30 AM", 11.5],
    ["12 PM", 12], ["12:30 PM", 12.5], ["1 PM", 13], ["2 PM", 14], ["2:30 PM", 14.5],
    ["3 PM", 15], ["4 PM", 16], ["5 PM", 17], ["6 PM", 18], ["6:30 PM", 18.5],
    ["7 PM", 19], ["8 PM", 20], ["8:30 PM", 20.5], ["9 PM", 21]
  ]);
  return [...new Set(Object.values(events).map(event => event.time))]
    .sort((a, b) => (order.get(a) ?? 99) - (order.get(b) ?? 99));
}

async function main() {
  const curated = JSON.parse(await fs.readFile(curatedPath, "utf8"));
  const skintEntries = await fetchSkintEvents().catch(error => {
    console.warn(`The Skint update failed: ${error.message}`);
    return [];
  });

  const events = {
    ...curated.events,
    ...Object.fromEntries(skintEntries)
  };

  const checked = new Intl.DateTimeFormat("en-US", {
    timeZone: TIME_ZONE,
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short"
  }).format(new Date());

  const data = {
    meta: {
      checked,
      coverage: "Curated Bryant Park listings plus latest non-sponsored The Skint digest posts",
      refresh: "Checks for updated events.json every 30 minutes while open.",
      weekDays: buildWeekDays(),
      todayKey: nyDateParts(new Date()).weekday,
      times: buildTimes(events)
    },
    events,
    clusters: buildClusters(events)
  };

  await fs.writeFile(outputPath, `${JSON.stringify(data, null, 2)}\n`);
  console.log(`Wrote ${Object.keys(events).length} events to ${outputPath.pathname}`);
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
