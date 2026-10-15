import "dotenv/config";
import { writeFile } from "fs/promises";
import { Mwn } from "mwn";

const DRY_RUN = false;

const ENDPOINT = "https://en.wikipedia.org/w/api.php";
const UA = "AINBStats/1.0 (https://en.wikipedia.org/wiki/User:DVRTed)";
const PAGE = "AI noticeboard/";
const PAGE_NS = "4";
const STATS_PAGE = "User:DVRTed bot/AINB-stats.json";
const EXTENDED_STATS_PAGE = "User:DVRTed bot/AINB-stats-extended.json";
const EXTENDED_TABLE_PAGE = "User:DVRTed bot/AINB-stats-extended-table";

const ROW_RE =
  /\{\{AIC article row\s*\|\s*(?:article=)?\s*[^|}]*\s*(?:\|\s*(?:status=)?\s*(?<status>[^|}]*))?(?:\|\s*(?:notes=)?\s*(?<notes>[^}]*))?\}\}/gi;

const STATUS_ALIASES = {
  completed: ["completed", "c"],
  ongoing: ["ongoing", "o"],
  unnecessary: ["unnecessary", "unneeded", "u"],
  tagged: ["tagged", "tag", "tg"],
  requested: ["requested", "todo", "to do", "t", "td"],
};

const STATUS_LOOKUP = {};
for (const [canonical, aliases] of Object.entries(STATUS_ALIASES)) {
  for (const alias of aliases) STATUS_LOOKUP[alias] = canonical;
}

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
      apfilterredir: "nonredirects",
    });
    if (apcontinue) params.set("apcontinue", apcontinue);

    const res = await fetch(`${ENDPOINT}?${params}`, {
      headers: { "User-Agent": UA },
    });
    const data = await res.json();

    for (const page of data.query?.allpages || []) {
      // match "/AINB" and other pages inside it
      // match "Archive" and "Archive N"
      // match "Backlog bonanza" at the start, e.g., match "Backlog bonanza (SPI edition)"
      const match =
        /\/(?:AINB(?:\/|)|Archive(?:\s\d*$|)$|Backlog bonanza)/i.test(
          page.title,
        );
      if (!match) {
        subpages.push(page.title);
      }
    }
    apcontinue = data.continue?.apcontinue;
  } while (apcontinue);
  return subpages;
}

async function get_content(titles) {
  const params = new URLSearchParams({
    format: "json",
    action: "query",
    prop: "revisions",
    rvprop: "content",
    rvslots: "main",
    titles: titles.join("|"),
  });

  const res = await fetch(`${ENDPOINT}?${params}`, {
    headers: { "User-Agent": UA },
  });
  const data = await res.json();

  const out = {};
  for (const page of Object.values(data.query?.pages || {})) {
    if (page.revisions?.length)
      out[page.title] = page.revisions[0].slots.main["*"];
  }
  return out;
}

async function generate_stats() {
  const subpages = await get_subpages();
  console.log(`Found ${subpages.length} subpages.`);

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

  for (let i = 0; i < subpages.length; i += 50) {
    const batch = subpages.slice(i, i + 50);
    console.log(`Fetching ${i + 1}-${i + batch.length}/${subpages.length}...`);
    const content = await get_content(batch);

    for (const [title, wikitext] of Object.entries(content)) {
      const counts = {
        completed: 0,
        unnecessary: 0,
        tagged: 0,
        ongoing: 0,
        requested: 0,
      };

      // check if the content has the AIC templates, excl commented out
      const uncommented_section = wikitext.replace(/<!--[\s\S]*?-->/g, "");

      const list_match = /\{\{AIC article list\s*\|/i.exec(uncommented_section);
      const has_row = /\{\{AIC article row/i.test(uncommented_section);

      if (list_match && has_row) {
        for (const m of wikitext.matchAll(ROW_RE)) {
          const status =
            STATUS_LOOKUP[(m.groups.status || "").trim().toLowerCase()] ||
            "unknown";

          if (status !== "unknown") counts[status]++;
        }
      }

      const total =
        counts.completed +
        counts.unnecessary +
        counts.tagged +
        counts.ongoing +
        counts.requested;
      const is_active = counts.requested > 0 || counts.ongoing > 0;

      overall.total_cases++;
      if (is_active) overall.active_cases++;
      else overall.closed_cases++;

      overall.total_completed += counts.completed;
      overall.total_todo += counts.requested;
      overall.total_unnecessary += counts.unnecessary;
      overall.total_tagged += counts.tagged;
      overall.total_in_progress += counts.ongoing;

      const pagename = title.replace(/^(?:Wikipedia:)?AI noticeboard\//i, "");
      extended.push([
        pagename,
        total,
        counts.requested,
        counts.completed,
        counts.ongoing,
        counts.unnecessary,
        counts.tagged,
      ]);
    }
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
        ([
          pagename,
          total,
          todo,
          completed,
          inprogress,
          unnecessary,
          tagged,
        ]) => {
          return `|-\n| [[Wikipedia:AI noticeboard/${pagename}|${pagename}]] || ${total} || ${todo} || ${completed} || ${inprogress} || ${unnecessary} || ${tagged}`;
        },
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
  const extended_wikitable = format_wikitable(extended);

  await writeFile("AINB-stats.json", overall_json);
  await writeFile("AINB-stats-extended.json", extended_json);
  await writeFile("AINB-stats-extended-wikitable.txt", extended_wikitable);

  console.log("saved stats to local files.");

  if (DRY_RUN) return;

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
    text: extended_wikitable,
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
