import "dotenv/config";
import { writeFile } from "fs/promises";
import { Mwn } from "mwn";

const DRY_RUN = false;

const ENDPOINT = "https://en.wikipedia.org/w/api.php";
const UA = "AINBStats/1.0 (https://en.wikipedia.org/wiki/User:DVRTed)";
const CATEGORY = "Category:AINB cases by conduct status: Inactive";
const TITLE_PREFIX = "Wikipedia:AI noticeboard/";
const OUTPUT_PAGE = "User:DVRTed bot/AINB-reports";
const OUTPUT_FILE = "inactive-users-editing.txt";
const EDIT_CAP = 100;

async function api(params) {
  const qs = new URLSearchParams({
    format: "json",
    formatversion: "2",
    ...params,
  });
  const res = await fetch(`${ENDPOINT}?${qs}`, {
    headers: { "User-Agent": UA },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  if (data.error) throw new Error(`${data.error.code}: ${data.error.info}`);
  return data;
}

// pages in the category, with the time each was added to it
async function get_category_cases() {
  const cases = [];
  let cmcontinue;

  do {
    const data = await api({
      action: "query",
      list: "categorymembers",
      cmtitle: CATEGORY,
      cmprop: "title|timestamp",
      cmlimit: "500",
      ...(cmcontinue && { cmcontinue }),
    });

    for (const m of data.query?.categorymembers || []) {
      if (m.title.startsWith(TITLE_PREFIX)) {
        cases.push({ title: m.title, added: m.timestamp });
      }
    }
    cmcontinue = data.continue?.cmcontinue;
  } while (cmcontinue);

  return cases;
}

// "Wikipedia:AI noticeboard/TestUser/2" -> "TestUser"
function get_username(title) {
  return title.slice(TITLE_PREFIX.length).split("/")[0].trim();
}

async function get_edits_since(user, since) {
  const data = await api({
    action: "query",
    list: "usercontribs",
    ucuser: user,
    ucnamespace: "0",
    ucend: since,
    uclimit: String(EDIT_CAP + 1),
    ucprop: "timestamp",
  });
  const contribs = data.query?.usercontribs || [];
  return { last: contribs[0]?.timestamp || null, since: contribs.length };
}

// contribs link starting from the day the case was added to the category
function contribs_url(user, added) {
  const qs = new URLSearchParams({
    title: "Special:Contributions",
    target: user,
    namespace: "0",
    start: added.slice(0, 10),
    limit: "50",
  });
  return `https://en.wikipedia.org/w/index.php?${qs}`;
}

const fmt = (t) => `${t} ({{time ago|${t}}})`;

function format_wikitable(rows) {
  if (!rows.length)
    return "No users found editing after being marked inactive.";

  const headers = [
    "#",
    "Case",
    "User",
    "Category added",
    "Last edit",
    "Edits since",
  ];
  const body = rows
    .map((r, i) => {
      const cells = [
        i + 1,
        `[[${r.title}]]`,
        `[[User:${r.user}|${r.user}]]`,
        fmt(r.added),
        fmt(r.last),
        `[${contribs_url(r.user, r.added)} ${r.since > EDIT_CAP ? `${EDIT_CAP}+` : r.since}]`,
      ];
      return `|-\n| ${cells.join(" || ")}`;
    })
    .join("\n");
  let wikitext = `{{Purge box}}\n\nLast updated: ~~~~~ ({{Time ago|~~~~~}}) \n\n=="Inactive" users editing==\n\n`;
  wikitext += `Users who have edited in mainspace since their conduct status was marked "Inactive". This is based on [[:${CATEGORY}]].

{| class="wikitable sortable"
! ${headers.join(" !! ")}
${body}
|}`;
  return wikitext;
}

async function main() {
  const cases = await get_category_cases();
  console.log(`Found ${cases.length} cases in category.`);

  const rows = [];

  for (const { title, added } of cases) {
    const user = get_username(title);
    if (!user) continue;

    try {
      const { last, since } = await get_edits_since(user, added);
      if (since > 0) {
        rows.push({ title, user, added, last, since });
        console.log(`${user}: edited after ${added} (${since} edits)`);
      }
    } catch (err) {
      console.warn(`Skipping ${user} (${title}): ${err.message}`);
    }
  }

  rows.sort((a, b) => b.last.localeCompare(a.last));

  const wikitext = format_wikitable(rows);
  await writeFile(OUTPUT_FILE, wikitext);
  console.log(`Saved ${rows.length} rows to ${OUTPUT_FILE}.`);

  if (DRY_RUN) return;

  const bot = await Mwn.init({
    apiUrl: ENDPOINT,
    username: process.env.WIKI_USERNAME,
    password: process.env.WIKI_PASSWORD,
    userAgent: UA,
  });

  await bot.edit(OUTPUT_PAGE, () => ({
    text: wikitext,
    summary: "Updating AINB reports (automated)",
  }));
  console.log(`Saved to ${OUTPUT_PAGE}`);
}

main().catch((err) => {
  console.error("Script failed:", err);
  process.exit(1);
});
