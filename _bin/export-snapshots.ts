import fs from "fs";
import path from "path";
import yaml from "js-yaml";

const snapshotTitlesPath = path.join(__dirname, "../_data/snapshot_titles.yml");
const snapshotSourcesPath = path.join(
  __dirname,
  "../_data/snapshot_sources.yml"
);
const sortedSnapshotDatesPath = path.join(
  __dirname,
  "../_data/sorted_snapshot_dates.yml"
);

function loadYamlData(filePath: string): any {
  return yaml.load(fs.readFileSync(filePath, "utf8"));
}

function getSnapshotData() {
  const snapshotTitles = loadYamlData(snapshotTitlesPath) as Record<
    string,
    string
  >;
  const snapshotSources = loadYamlData(snapshotSourcesPath) as Record<
    string,
    string
  >;
  const sortedSnapshotDates = loadYamlData(sortedSnapshotDatesPath) as Record<
    string,
    string[]
  >;

  return Object.entries(sortedSnapshotDates).map(([date, urls]) => ({
    date,
    snapshots: urls.map((url) => ({
      url,
      title: snapshotTitles[url],
      source: snapshotSources[url],
    })),
  }));
}

const data = getSnapshotData();

fs.writeFileSync(
  path.join(__dirname, "../_data/normalized_snapshots.json"),
  JSON.stringify(data, null, 2)
);

const dailyNotesPath = path.join(
  process.env.HOME as string,
  "Dropbox/Apps/Obsidian/Main/DailyNotes"
);

function processDailyNotes(data: any) {
  for (const { date } of data) {
    const dateObj = new Date(date);
    const year = dateObj.getFullYear();
    const month = (dateObj.getMonth() + 1).toString().padStart(2, "0");
    const day = dateObj.getDate().toString().padStart(2, "0");

    const notePath = path.join(
      dailyNotesPath,
      year.toString(),
      `${year}-${month}`,
      `${year}-${month}-${day}.md`
    );

    if (fs.existsSync(notePath)) {
      console.log(`Note exists for ${notePath}`);
    } else {
      console.log(`Note does not exist for ${notePath}`);
    }

    if (fs.existsSync(notePath)) {
      const content = fs.readFileSync(notePath, "utf8");
      const lines = content.split("\n");

      const webReadingIndex = lines.findIndex((line) =>
        line.startsWith("## Web Reading")
      );
      const tasksIndex = lines.findIndex((line) =>
        line.startsWith("## Tasks for Today")
      );

      if (webReadingIndex === -1) {
        if (tasksIndex !== -1) {
          lines.splice(
            tasksIndex,
            0,
            "## Web Reading",
            "",
            ...generateSnapshotLines(data, date),
            ""
          );
        } else {
          lines.push("", "## Web Reading", "");
          lines.push(...generateSnapshotLines(data, date));
          lines.push("");
        }

        fs.writeFileSync(notePath, lines.join("\n"));
      }
    } else {
      const lines = [`# ${year}-${month}-${day}`, "", "## Web Reading", ""];
      lines.push(...generateSnapshotLines(data, date));
      lines.push("");
      fs.writeFileSync(notePath, lines.join("\n"));
    }
  }
}

function generateSnapshotLines(data: any, date: string): string[] {
  const todaysSnapshots = data.find((d) => d.date === date)?.snapshots || [];
  return todaysSnapshots.map(
    (snapshot) =>
      `- [${snapshot.title}](${snapshot.url}) - [🔗](${snapshot.source})`
  );
}

processDailyNotes(data);
