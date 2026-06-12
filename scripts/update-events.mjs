import fs from "fs/promises";
import https from "https";

const ROOT = new URL("../", import.meta.url);
const curatedPath = new URL("data/curated-events.json", ROOT);
const outputPath = new URL("events.json", ROOT);
const indexPath = new URL("index.html", ROOT);

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

function getText(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { "User-Agent": "NYC-Fun-Calendar/1.0" } }, response => {
      if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        response.resume();
        const nextUrl = new URL(response.headers.location, url).toString();
        getText(nextUrl).then(resolve, reject);
        return;
      }
      if (response.statusCode < 200 || response.statusCode >= 300) {
        response.resume();
        reject(new Error(`${url} returned ${response.statusCode}`));
        return;
      }
      let body = "";
      response.setEncoding("utf8");
      response.on("data", chunk => body += chunk);
      response.on("end", () => resolve(body));
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
      iso: date.toISOString().slice(0, 10),
      key: parts.weekday,
      label: parts.weekday,
      date: `${parts.month} ${parts.day}`
    };
  });
}

function buildMonthDays(startDate = new Date()) {
  return Array.from({ length: 31 }, (_, index) => {
    const date = new Date(startDate.getTime() + index * DAY_MS);
    const parts = nyDateParts(date);
    return {
      iso: date.toISOString().slice(0, 10),
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

function postDateMap(title, fallbackDate) {
  const year = fallbackDate.getUTCFullYear();
  const match = title.match(/(\d{1,2})\/(\d{1,2})(?:-(\d{1,2}))?/);
  if (!match) {
    const parts = nyDateParts(fallbackDate);
    return { [parts.weekday.toLowerCase()]: fallbackDate.toISOString().slice(0, 10) };
  }

  const month = Number(match[1]);
  const startDay = Number(match[2]);
  const endDay = Number(match[3] || match[2]);
  const map = {};
  for (let day = startDay; day <= endDay; day += 1) {
    const date = new Date(Date.UTC(year, month - 1, day, 12));
    map[nyDateParts(date).weekday.toLowerCase()] = date.toISOString().slice(0, 10);
  }
  return map;
}

function normalizeTime(timeText) {
  const compact = timeText.toLowerCase().replace(/\s+/g, "");
  const match = compact.match(/(\d{1,2})(?::(\d{2}))?(am|pm)?/);
  if (!match) return { bucket: "10 AM", label: timeText.trim() };
  let hour = Number(match[1]);
  const minute = match[2] || "";
  let period = match[3] || "";
  if (!period) {
    const laterPeriod = compact.match(/(?:-|–|to)\d{1,2}(?::\d{2})?(am|pm)/);
    period = laterPeriod?.[1] || "pm";
  }
  if (period === "pm" && hour !== 12) hour += 12;
  if (period === "am" && hour === 12) hour = 0;
  const displayHour = hour % 12 || 12;
  const displayPeriod = hour >= 12 ? "PM" : "AM";
  return {
    bucket: minute && minute !== "00" ? `${displayHour}:${minute} ${displayPeriod}` : `${displayHour} ${displayPeriod}`,
    label: timeText.trim()
  };
}

function dateFromMonthDay(monthDay, baseDate = new Date()) {
  const match = String(monthDay || "").match(/([A-Za-z]{3,9})\s+(\d{1,2})|(\d{1,2})\/(\d{1,2})/);
  if (!match) return null;
  const monthNames = {
    jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3,
    apr: 4, april: 4, may: 5, jun: 6, june: 6, jul: 7, july: 7,
    aug: 8, august: 8, sep: 9, sept: 9, september: 9, oct: 10, october: 10,
    nov: 11, november: 11, dec: 12, december: 12
  };
  const month = match[1] ? monthNames[match[1].toLowerCase()] : Number(match[3]);
  const day = Number(match[2] || match[4]);
  if (!month || !day) return null;
  let year = baseDate.getUTCFullYear();
  let date = new Date(Date.UTC(year, month - 1, day, 12));
  if (date.getTime() < baseDate.getTime() - 180 * DAY_MS) {
    year += 1;
    date = new Date(Date.UTC(year, month - 1, day, 12));
  }
  return date.toISOString().slice(0, 10);
}

function isWithinLookahead(date, days = 45) {
  if (!date) return false;
  const today = new Date();
  const start = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() - 1, 0));
  const end = new Date(start.getTime() + days * DAY_MS);
  const value = new Date(`${date}T12:00:00Z`);
  return value >= start && value <= end;
}

function sortForTime(bucket) {
  const match = bucket.match(/^(\d{1,2})(?::(\d{2}))?\s(AM|PM)$/);
  if (!match) return 10;
  let hour = Number(match[1]);
  if (match[3] === "PM" && hour !== 12) hour += 12;
  if (match[3] === "AM" && hour === 12) hour = 0;
  return hour + Number(match[2] || 0) / 60;
}

function formatTimeFromDetails(details = {}) {
  const hour = Number(details.hour || 0);
  const minutes = String(details.minutes || "00").padStart(2, "0");
  const displayHour = hour % 12 || 12;
  const period = hour >= 12 ? "PM" : "AM";
  return {
    bucket: minutes === "00" ? `${displayHour} ${period}` : `${displayHour}:${minutes} ${period}`,
    label: minutes === "00" ? `${displayHour}${period.toLowerCase()}` : `${displayHour}:${minutes}${period.toLowerCase()}`
  };
}

function inferType(title, categoryText = "") {
  const text = `${title} ${categoryText}`.toLowerCase();
  if (/\bai\b|artificial intelligence|\bagent\b|agentic|tech|startup|founder|\bvc\b|venture|cloud|\bdata\b|developer|engineering|engineer|product|business|fintech|crypto|web3|quantum|robot|software|snowflake|\baws\b|\bnyse\b|seminar|lecture|panel|讲座/.test(text)) return ["tech", "Tech / AI"];
  if (/film|movie|screening|cinema/.test(text)) return ["film", "Movie"];
  if (/comedy/.test(text)) return ["art", "Comedy"];
  if (/concert|music|jazz|opera|dj|band|dance party|performance/.test(text)) return ["music", "Live music"];
  if (/food|market|fair|festival|bazaar|shopping|street|farmers/.test(text)) return ["food", "Market"];
  if (/park|garden|outdoor|walk|tour/.test(text)) return ["park", "Outdoor"];
  return ["art", "Arts"];
}

function extractLink(html) {
  const match = html.match(/href="([^"]+)"/i);
  return match ? decodeHtml(match[1]) : "https://www.theskint.com/";
}

function paragraphBlocks(html) {
  return [...html.matchAll(/<p[\s\S]*?<\/p>/gi)].map(match => match[0]);
}

function parseSkintPost(post) {
  const postTitle = decodeHtml(post.title?.rendered || "The Skint NYC picks");
  const postDate = new Date(post.date_gmt ? `${post.date_gmt}Z` : post.date);
  const dates = postDateMap(postTitle, postDate);
  let category = "Daily picks";
  const entries = [];

  for (const block of paragraphBlocks(post.content?.rendered || "")) {
    const text = decodeHtml(block).replace(/\s+/g, " ").trim();
    if (!text) continue;

    if (!text.startsWith("►")) {
      if (!text.includes(">>") && text.length < 140) category = text.replace(/:$/, "");
      continue;
    }

    const listing = text.replace(/^►\s*/, "").replace(/\s*>>\s*$/, "");
    const match = listing.match(/^(fri|sat|sun|mon|tues?|wed|thu(?:rs)?)(?:day)?\s+([^:]+):\s+(.+)$/i);
    if (!match) continue;

    const dayToken = match[1].slice(0, 3).toLowerCase();
    const date = dates[dayToken];
    if (!date) continue;

    const titleMatch = block.match(/<b[^>]*>([\s\S]*?)<\/b>/i);
    const title = decodeHtml(titleMatch ? titleMatch[1] : match[3].split(":")[0]).replace(/\s+/g, " ");
    if (!title || title.length < 4) continue;

    const afterTitle = match[3].replace(title, "").replace(/^[:\s]+/, "");
    const place = afterTitle.split(".")[0].replace(/\s+/g, " ").trim() || "NYC";
    const priceMatch = listing.match(/(?:^|[. ])(\$\d+(?:\.\d{2})?(?:\s*(?:adv|door|suggested|admission)?)?|free admission|free)(?:[. ]|$)/i);
    const price = priceMatch ? priceMatch[1].replace(/^./, char => char.toUpperCase()) : "Free / cheap";
    const time = normalizeTime(match[2]);
    const [type, label] = inferType(title, category);
    const day = nyDateParts(new Date(`${date}T12:00:00Z`)).weekday;
    const id = `skint_${post.id}_${entries.length}_${slug(title)}`;

    entries.push([id, {
      title,
      type,
      label,
      day,
      date,
      time: time.bucket,
      sort: sortForTime(time.bucket),
      when: `${day}, ${date.slice(5).replace("-", "/")} · ${time.label}`,
      price,
      free: !price.includes("$"),
      place,
      source: "The Skint",
      link: extractLink(block) || post.link,
      map: `https://maps.google.com/?q=${encodeURIComponent(place + " NYC")}`,
      summary: `${category}. Pulled from The Skint's public article feed: ${listing}`
    }]);
  }

  return entries;
}

async function fetchSkintEvents() {
  const posts = await getJson("https://www.theskint.com/wp-json/wp/v2/posts?per_page=12");
  const parsed = posts
    .filter(post => !decodeHtml(post.title?.rendered).toUpperCase().includes("SPONSORED"))
    .filter(post => /SKINT|TUES|THURS|FRI|SAT|SUN|MON|WEEKEND|\d+\/\d+/.test(decodeHtml(post.title?.rendered).toUpperCase()))
    .slice(0, 4)
    .flatMap(parseSkintPost);
  return parsed.slice(0, 80);
}

function parseJerseyCityEvent(event) {
  const title = decodeHtml(event.title || "");
  if (!title || /postponed|cancelled|canceled/i.test(title)) return null;

  const details = event.start_date_details || {};
  const year = Number(details.year);
  const month = Number(details.month);
  const dayOfMonth = Number(details.day);
  if (!year || !month || !dayOfMonth) return null;

  const date = `${year}-${String(month).padStart(2, "0")}-${String(dayOfMonth).padStart(2, "0")}`;
  const dateForDay = new Date(Date.UTC(year, month - 1, dayOfMonth, 12));
  const day = nyDateParts(dateForDay).weekday;
  const time = formatTimeFromDetails(details);
  const categories = (event.categories || []).map(category => decodeHtml(category.name)).join(" ");
  const [type, label] = inferType(title, categories);
  const venue = event.venue || {};
  const venueName = decodeHtml(venue.venue || "Jersey City");
  const address = [venue.address, venue.city, venue.state || venue.province].filter(Boolean).map(decodeHtml).join(", ");
  const place = address ? `${venueName}, ${address}` : venueName;
  const costValues = event.cost_details?.values || [];
  const cost = decodeHtml(event.cost || "");
  const price = cost || (costValues.includes("0") ? "Free" : "Free / varies");
  const summary = decodeHtml(event.description || event.excerpt || "")
    .replace(/\s+/g, " ")
    .trim();

  return [`jc_culture_${event.id}_${slug(date)}_${slug(title)}`, {
    title,
    type,
    label,
    day,
    date,
    time: time.bucket,
    sort: sortForTime(time.bucket),
    when: `${day}, ${date.slice(5).replace("-", "/")} · ${time.label}`,
    price,
    free: !price.includes("$"),
    place,
    source: "Jersey City Cultural Affairs",
    link: event.url || "https://jerseycityculture.org/events/",
    map: venue.show_map_link && event.venue?.address
      ? `https://maps.google.com/?q=${encodeURIComponent(place)}`
      : "https://maps.google.com/?q=Jersey+City+events",
    summary: summary || `Official Jersey City Cultural Affairs listing. Categories: ${categories || "community events"}.`
  }];
}

async function fetchJerseyCityEvents() {
  const today = new Date();
  const start = today.toISOString().slice(0, 10);
  const end = new Date(today.getTime() + 31 * DAY_MS).toISOString().slice(0, 10);
  const url = `https://www.jerseycityculture.org/wp-json/tribe/events/v1/events?per_page=50&start_date=${encodeURIComponent(`${start} 00:00:00`)}&end_date=${encodeURIComponent(`${end} 23:59:59`)}`;
  const data = await getJson(url);
  return (data.events || [])
    .map(parseJerseyCityEvent)
    .filter(Boolean)
    .slice(0, 45);
}

function techSummary(source, text) {
  const cleaned = decodeHtml(text || "").replace(/\s+/g, " ").trim();
  return cleaned ? `${source}: ${cleaned}` : `${source} listing for a tech, AI, business, or founder event.`;
}

function isGenericGarySummary(summary) {
  return summary === "Gary's Guide listing for a tech, AI, business, or founder event.";
}

function extractGaryDetailSummary(html) {
  const match = html.match(/<font class="fdescription">\s*([\s\S]*?)\s*<\/font>/);
  if (!match) return "";
  return decodeHtml(match[1])
    .replace(/\s+/g, " ")
    .trim();
}

function parseGaryGuideEvents(html) {
  const entries = [];
  const rowPattern = /<td align='center' valign='top' width='48'><b>([^<]+)<\/b><br\/>([^<]+)<\/td>[\s\S]*?<td align='center' width='37' valign='top'>([\s\S]*?)<\/td>[\s\S]*?<font class='ftitle'><a[^>]+href='([^']+)'[^>]*><b>([\s\S]*?)<\/b><\/a>[\s\S]*?<font class='fdescription'><br\/><b>([\s\S]*?)<\/b>([\s\S]*?)<\/font>(?:<br\/><font class='fgray'>([\s\S]*?)<\/font>)?/g;
  for (const match of html.matchAll(rowPattern)) {
    const date = dateFromMonthDay(match[1]);
    if (!isWithinLookahead(date)) continue;
    const title = decodeHtml(match[5]);
    if (!title || /after party|gala/i.test(title)) continue;
    const time = normalizeTime(match[2]);
    const day = nyDateParts(new Date(`${date}T12:00:00Z`)).weekday;
    const priceText = decodeHtml(match[3]).replace(/\s+/g, " ").trim();
    const price = priceText || "Varies";
    const venue = decodeHtml(match[6]);
    const address = decodeHtml(match[7]).replace(/^,\s*/, "");
    const place = [venue, address].filter(Boolean).join(", ") || "NYC";
    if (/palo alto|san francisco|mountain view|california/i.test(place)) continue;
    const details = decodeHtml(match[8] || "");
    const id = `gary_${slug(date)}_${slug(title)}`;
    entries.push([id, {
      title,
      type: "tech",
      label: /ai|agent|data|cloud|snowflake|aws/i.test(`${title} ${details}`) ? "AI / Data" : "Tech / Business",
      day,
      date,
      time: time.bucket,
      sort: sortForTime(time.bucket),
      when: `${day}, ${date.slice(5).replace("-", "/")} · ${time.label}`,
      price,
      free: /free/i.test(price),
      place,
      source: "Gary's Guide",
      link: match[4].startsWith("http") ? match[4] : `https://www.garysguide.com${match[4]}`,
      map: `https://maps.google.com/?q=${encodeURIComponent(place)}`,
      summary: techSummary("Gary's Guide", details)
    }]);
  }
  return entries.slice(0, 45);
}

async function fetchGaryGuideEvents() {
  const entries = parseGaryGuideEvents(await getText("https://www.garysguide.com/events?region=nyc"));
  const enriched = [];
  for (const [id, event] of entries) {
    if (!isGenericGarySummary(event.summary)) {
      enriched.push([id, event]);
      continue;
    }
    try {
      const detail = extractGaryDetailSummary(await getText(event.link));
      enriched.push([id, {
        ...event,
        summary: detail ? techSummary("Gary's Guide", detail) : event.summary
      }]);
    } catch {
      enriched.push([id, event]);
    }
  }
  return enriched;
}

function lumaPrice(event) {
  const offers = Array.isArray(event.offers) ? event.offers : event.offers ? [event.offers] : [];
  const prices = offers.map(offer => Number(offer.price)).filter(price => Number.isFinite(price));
  if (!prices.length) return "RSVP";
  const min = Math.min(...prices);
  return min === 0 ? "Free" : `$${min}`;
}

function parseLumaEvents(html) {
  const entries = [];
  const scripts = [...html.matchAll(/<script[^>]+type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi)];
  for (const script of scripts) {
    let data;
    try {
      data = JSON.parse(script[1]);
    } catch {
      continue;
    }
    const items = data?.itemListElement || [];
    for (const itemWrapper of items) {
      const event = itemWrapper.item;
      if (!event || event["@type"] !== "Event") continue;
      const haystack = `${event.name || ""} ${event.description || ""} ${(event.organizer || []).map(org => org.name).join(" ")}`;
      if (!/\bai\b|artificial intelligence|agentic|tech|startup|founder|enterprise|cloud|\bdata\b|developer|\bdev\b|business|fintech|investor|\bvc\b|\bproduct\b|interface|\baws\b|snowflake|\bnyse\b/i.test(haystack)) continue;
      const start = new Date(event.startDate);
      if (Number.isNaN(start.getTime())) continue;
      const date = start.toISOString().slice(0, 10);
      if (!isWithinLookahead(date)) continue;
      const parts = nyDateParts(start);
      const time = formatTimeFromDetails({ hour: start.getHours(), minutes: String(start.getMinutes()).padStart(2, "0") });
      const place = event.location?.name || event.location?.address?.streetAddress || "New York";
      const price = lumaPrice(event);
      const id = `luma_${slug(date)}_${slug(event.name)}`;
      entries.push([id, {
        title: decodeHtml(event.name),
        type: "tech",
        label: /ai|agentic|cloud|data|aws|snowflake/i.test(haystack) ? "AI / Tech" : "Business / Tech",
        day: parts.weekday,
        date,
        time: time.bucket,
        sort: sortForTime(time.bucket),
        when: `${parts.weekday}, ${date.slice(5).replace("-", "/")} · ${time.label}`,
        price,
        free: price === "Free",
        place: decodeHtml(place),
        source: "Luma NYC",
        link: event.url || event["@id"] || "https://luma.com/nyc",
        map: `https://maps.google.com/?q=${encodeURIComponent(`${place} NYC`)}`,
        summary: techSummary("Luma NYC", `${decodeHtml(event.description || "")} ${(event.organizer || []).map(org => org.name).join(", ")}`)
      }]);
    }
  }
  return entries.slice(0, 30);
}

async function fetchLumaEvents() {
  return parseLumaEvents(await getText("https://luma.com/nyc"));
}

function parseNyuTandonEvents(html) {
  const entries = [];
  const blocks = [...html.matchAll(/<article class="node node--type-event node--view-mode-teaser">([\s\S]*?)<\/article>/g)].map(match => match[1]);
  for (const block of blocks) {
    const href = block.match(/<h3[\s\S]*?<a href="([^"]+)"/)?.[1];
    const title = decodeHtml(block.match(/field--name-title[\s\S]*?>([\s\S]*?)<\/span>/)?.[1]);
    const category = decodeHtml(block.match(/field--name-field-event-type[\s\S]*?<div class="field__item">([\s\S]*?)<\/div>/)?.[1]);
    const monthDay = decodeHtml(block.match(/<div class="month-day">([\s\S]*?)<\/div>/)?.[1]);
    const dayTime = decodeHtml(block.match(/<div class="day-time">([\s\S]*?)<\/div>/)?.[1]);
    const date = dateFromMonthDay(monthDay);
    if (!href || !title || !isWithinLookahead(date)) continue;
    const timeText = dayTime.split(",").slice(1).join(",").trim() || "12:00 PM";
    const time = normalizeTime(timeText);
    const day = nyDateParts(new Date(`${date}T12:00:00Z`)).weekday;
    const id = `nyu_tandon_${slug(date)}_${slug(title)}`;
    entries.push([id, {
      title,
      type: "tech",
      label: category || "University Talk",
      day,
      date,
      time: time.bucket,
      sort: sortForTime(time.bucket),
      when: `${day}, ${date.slice(5).replace("-", "/")} · ${time.label}`,
      price: "Free / varies",
      free: true,
      place: "NYU Tandon / Online",
      source: "NYU Tandon",
      link: href.startsWith("http") ? href : `https://engineering.nyu.edu${href}`,
      map: "https://maps.google.com/?q=NYU+Tandon+School+of+Engineering",
      summary: techSummary("NYU Tandon", category)
    }]);
  }
  return entries.slice(0, 20);
}

async function fetchUniversityEvents() {
  const nyu = await getText("https://engineering.nyu.edu/events");
  return parseNyuTandonEvents(nyu);
}

function dedupeEntries(entries) {
  const seen = new Set();
  return entries.filter(([, event]) => {
    const titleKey = slug(event.title).split("_").slice(0, 7).join("_");
    const key = `${event.date}|${titleKey}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function scriptSafeJson(data) {
  return JSON.stringify(data)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026");
}

async function writeEmbeddedEventData(data) {
  const html = await fs.readFile(indexPath, "utf8");
  const next = html.replace(
    /<script id="embeddedEventData" type="application\/json">[\s\S]*?<\/script>/,
    `<script id="embeddedEventData" type="application/json">${scriptSafeJson(data)}</script>`
  );
  if (next === html) {
    throw new Error("Could not find embeddedEventData script tag in index.html");
  }
  await fs.writeFile(indexPath, next);
}

function fallbackNearbySourceEvents() {
  const today = new Date();
  const day = nyDateParts(today).weekday;
  const date = today.toISOString().slice(0, 10);
  return {
    nyc_parks_today: {
      title: "NYC Parks events near you",
      type: "park",
      label: "Parks",
      day,
      date,
      time: "10 AM",
      sort: 10.1,
      when: `${day} · Latest NYC Parks calendar`,
      price: "Mostly free",
      free: true,
      place: "NYC parks",
      source: "NYC Parks",
      link: "https://www.nycgovparks.org/events",
      map: "https://maps.google.com/?q=NYC+Parks+events",
      summary: "Official NYC Parks calendar. Use the source link for the latest concerts, movies, tours, fitness, and outdoor events."
    },
    jersey_city_culture: {
      title: "Jersey City events source",
      type: "art",
      label: "Jersey City",
      day,
      date,
      time: "12 PM",
      sort: 12.1,
      when: `${day} · Jersey City calendar unavailable`,
      price: "Varies",
      free: true,
      place: "Jersey City",
      source: "Jersey City Cultural Affairs",
      link: "https://www.jerseycityculture.org/events/",
      map: "https://maps.google.com/?q=Jersey+City+events",
      summary: "The Jersey City event feed could not be parsed on the latest refresh, so this source link is included as a fallback."
    }
  };
}

function buildClusters(events) {
  const byCell = {};
  for (const [id, event] of Object.entries(events)) {
    const key = `${event.date || event.day}|${event.time}`;
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
  return [...new Set(Object.values(events).map(event => event.time))]
    .sort((a, b) => sortForTime(a) - sortForTime(b));
}

async function main() {
  const curated = JSON.parse(await fs.readFile(curatedPath, "utf8"));
  const skintEntries = await fetchSkintEvents().catch(error => {
    console.warn(`The Skint update failed: ${error.message}`);
    return [];
  });
  const jerseyCityEntries = await fetchJerseyCityEvents().catch(error => {
    console.warn(`Jersey City update failed: ${error.message}`);
    return [];
  });
  const garyGuideEntries = await fetchGaryGuideEvents().catch(error => {
    console.warn(`Gary's Guide update failed: ${error.message}`);
    return [];
  });
  const lumaEntries = await fetchLumaEvents().catch(error => {
    console.warn(`Luma update failed: ${error.message}`);
    return [];
  });
  const universityEntries = await fetchUniversityEvents().catch(error => {
    console.warn(`University event update failed: ${error.message}`);
    return [];
  });
  const nearbyEvents = {
    ...fallbackNearbySourceEvents(),
    ...Object.fromEntries(jerseyCityEntries)
  };
  if (jerseyCityEntries.length) delete nearbyEvents.jersey_city_culture;

  const events = {
    ...curated.events,
    ...Object.fromEntries(dedupeEntries([
      ...skintEntries,
      ...garyGuideEntries,
      ...lumaEntries,
      ...universityEntries
    ])),
    ...nearbyEvents
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
      coverage: "Curated Bryant Park listings, latest non-sponsored The Skint digest posts, official Jersey City Cultural Affairs events, Gary's Guide, Luma NYC, and NYU Tandon events",
      refresh: "Checks for updated events.json every 30 minutes while open.",
      weekDays: buildWeekDays(),
      monthDays: buildMonthDays(),
      todayKey: nyDateParts(new Date()).weekday,
      times: buildTimes(events)
    },
    events,
    clusters: buildClusters(events)
  };

  await fs.writeFile(outputPath, `${JSON.stringify(data, null, 2)}\n`);
  await writeEmbeddedEventData(data);
  console.log(`Wrote ${Object.keys(events).length} events to ${outputPath.pathname}`);
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
