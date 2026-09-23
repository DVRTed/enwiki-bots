import "dotenv/config";
import * as cheerio from "cheerio";
import { writeFile } from "fs/promises";
import { Mwn } from "mwn";

const ENDPOINT = "https://en.wikipedia.org/w/api.php";
const UA = "AINBStats/1.0 (https://en.wikipedia.org/wiki/User:DVRTed)";
const PAGE = "AI noticeboard/";
const PAGE_NS = "4";
const STATS_PAGE = "User:DVRTed bot/AINB-stats.json";
const EXTENDED_STATS_PAGE = "User:DVRTed bot/AINB-stats-extended.json";
const EXTENDED_TABLE_PAGE = "User:DVRTed bot/AINB-stats-extended-table";

async function get_subpages() {
  const subpages = [];
  let apcontinue;

  do {
    const params = new URLSearchParams({
      format: "json",
      action: "query",
      list: "allpages",
      apnamespace: PAGE_NS,
      apprefix: PAGE,
      aplimit: "500",
    });
    if (apcontinue) params.set("apcontinue", apcontinue);

    const res = await fetch(`${ENDPOINT}?${params}`, {
      headers: { "User-Agent": UA },
    });
    const data = await res.json();

    for (const page of data.query?.allpages || []) {
      if (/\/\d{4}-\d{2}-\d{2}[ _]/.test(page.title)) {
        subpages.push(page.title);
      }
    }
    apcontinue = data.continue?.apcontinue;
  } while (apcontinue);

  return subpages;
}

async function generate_stats() {
  const subpages = await get_subpages();
  console.log(`Scanning ${subpages.length} subpages...`);

  const overall = {
    total_cases: 0,
    active_cases: 0,
    closed_cases: 0,
    total_completed: 0,
    total_todo: 0,
    total_unnecessary: 0,
    total_tagged: 0,
    total_in_progress: 0,
  };

  const extended = [];

  for (let i = 0; i < subpages.length; i++) {
    const title = subpages[i];
    console.log(`[${i + 1}/${subpages.length}] ${title}`);

    const params = new URLSearchParams({
      format: "json",
      action: "parse",
      page: title,
      prop: "text",
    });
    const res = await fetch(`${ENDPOINT}?${params}`, {
      headers: { "User-Agent": UA },
    });
    const data = await res.json();

    const html = data.parse?.text?.["*"];
    if (!html) continue;

    const $ = cheerio.load(html);
    const counts = {
      completed: 0,
      unnecessary: 0,
      tagged: 0,
      ongoing: 0,
      todo: 0,
      unknown: 0,
    };

    $("tr[class*='aic-row-']").each((_, el) => {
      const cls = $(el).attr("class") || "";
      if (cls.includes("aic-row-completed")) counts.completed++;
      else if (cls.includes("aic-row-unnecessary")) counts.unnecessary++;
      else if (cls.includes("aic-row-tagged")) counts.tagged++;
      else if (cls.includes("aic-row-ongoing")) counts.ongoing++;
      else if (cls.includes("aic-row-todo")) counts.todo++;
      else counts.unknown++;
    });

    const total =
      counts.completed +
      counts.unnecessary +
      counts.tagged +
      counts.ongoing +
      counts.todo +
      counts.unknown;
    const is_active = counts.todo > 0 || counts.ongoing > 0;

    overall.total_cases++;
    if (is_active) overall.active_cases++;
    else overall.closed_cases++;

    overall.total_completed += counts.completed;
    overall.total_todo += counts.todo;
    overall.total_unnecessary += counts.unnecessary;
    overall.total_tagged += counts.tagged;
    overall.total_in_progress += counts.ongoing;

    const pagename = title.replace(/^(?:Wikipedia:)?AI noticeboard\//i, "");
    extended.push([
      pagename,
      total,
      counts.todo,
      counts.completed,
      counts.ongoing,
      counts.unnecessary,
      counts.tagged,
    ]);
  }

  return { overall, extended };
}

function format_wikitable(extended) {
  const active = [];
  const closed = [];
  const other = [];

  for (const entry of extended) {
    const [, , todo, completed, inprogress, unnecessary, tagged] = entry;
    if (todo > 0 || inprogress > 0) {
      active.push(entry);
    } else if (completed > 0 || unnecessary > 0 || tagged > 0) {
      closed.push(entry);
    } else {
      other.push(entry);
    }
  }

  const renderTable = (rows) => {
    const rowContent = rows
      .map(
        ([pagename, total, todo, completed, inprogress, unnecessary, tagged]) => {

          return `|-\n| [[Wikipedia:AI noticeboard/${pagename}|${pagename}]] || ${total} || ${todo} || ${completed} || ${inprogress} || ${unnecessary} || ${tagged}`
        }
      )
      .join("\n");

    return `{| class="wikitable sortable"
! Page !! Total !! Todo !! Completed !! In progress !! Unnecessary !! Tagged
${rowContent}
|}`;
  };

  return [
    `== Active cases ==\n${renderTable(active)}`,
    `== Closed cases ==\n${renderTable(closed)}`,
    `== Other cases ==\n${renderTable(other)}`,
  ].join("\n\n");
}

async function save(overall, extended) {
  const overall_json = JSON.stringify(overall);
  const extended_json = JSON.stringify(extended);

  await writeFile("AINB-stats.json", overall_json);
  await writeFile("AINB-stats-extended.json", extended_json);
  console.log("saved stats to local files.");

  const bot = await Mwn.init({
    apiUrl: ENDPOINT,
    username: process.env.WIKI_USERNAME,
    password: process.env.WIKI_PASSWORD,
    userAgent: UA,
  });

  await bot.edit(STATS_PAGE, () => ({
    text: overall_json,
    summary: "Updating AINB stats (automated)",
  }));
  console.log(`Saved to ${STATS_PAGE}`);

  await bot.edit(EXTENDED_STATS_PAGE, () => ({
    text: extended_json,
    summary: "Updating AINB extended stats (automated)",
  }));
  console.log(`Saved to ${EXTENDED_STATS_PAGE}`);

  await bot.edit(EXTENDED_TABLE_PAGE, () => ({
    text: format_wikitable(extended),
    summary: "Updating AINB extended stats table (automated)",
  }));
  console.log(`Saved to ${EXTENDED_TABLE_PAGE}`);
}

async function main() {
  const { overall, extended } = await generate_stats();
  if (overall.total_cases) {
    await save(overall, extended);
  }
}

main().catch((err) => {
  console.error("Script failed:", err);
  process.exit(1);
});
