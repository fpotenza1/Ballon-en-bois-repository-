
"use strict";

/*
  BALLON EN BOIS
  Football results, fixtures and official-source standings importer.

  Match data: 9 competitions
  Standings: 6 domestic leagues

  Club crests are saved to fd_teams automatically.
  Existing crests are preserved when a provider response
  does not include an image URL.

  Standings are provided by football-data.org.
  No league positions or points are calculated locally.
*/

const COMPETITIONS = [
  { code: "PL", name: "Premier League", standings: true },
  { code: "PD", name: "La Liga", standings: true },
  { code: "SA", name: "Serie A", standings: true },
  { code: "BL1", name: "Bundesliga", standings: true },
  { code: "FL1", name: "Ligue 1", standings: true },
  { code: "PPL", name: "Primeira Liga", standings: true },
  { code: "CL", name: "UEFA Champions League", standings: false },
  { code: "WC", name: "FIFA World Cup", season: 2026, standings: false },
  { code: "EC", name: "UEFA European Championship", season: 2024, standings: false },
];

const wait = (ms) =>
  new Promise((resolve) => setTimeout(resolve, ms));

function supabaseCredentials() {
  const url = new URL(process.env.SUPABASE_URL);

  const key =
    process.env.SUPABASE_SECRET_KEY ||
    process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!key) {
    throw new Error("Missing Supabase secret key");
  }

  return {
    origin: url.origin,
    key,
  };
}

async function saveRows(table, rows, conflict) {
  if (!rows.length) return;

  const { origin, key } = supabaseCredentials();

  for (let i = 0; i < rows.length; i += 100) {
    const batch = rows.slice(i, i + 100);

    const endpoint =
      `${origin}/rest/v1/${encodeURIComponent(table)}` +
      `?on_conflict=${encodeURIComponent(conflict)}`;

    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        apikey: key,
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
        Prefer: "resolution=merge-duplicates,return=minimal",
      },
      body: JSON.stringify(batch),
    });

    if (!response.ok) {
      const details = await response.text();

      throw new Error(
        `Supabase ${table}: HTTP ${response.status} ` +
        details.slice(0, 300)
      );
    }
  }
}

/*
  Read existing team crest URLs.

  This protects saved crests when the football
  provider returns a team without a crest.
*/

async function existingTeamCrests(teamIds) {
  const crests = new Map();

  if (!teamIds.length) {
    return crests;
  }

  const { origin, key } = supabaseCredentials();

  for (let i = 0; i < teamIds.length; i += 100) {
    const batch = teamIds.slice(i, i + 100);

    const endpoint = new URL(
      `${origin}/rest/v1/fd_teams`
    );

    endpoint.searchParams.set(
      "select",
      "provider_id,crest"
    );

    endpoint.searchParams.set(
      "provider_id",
      `in.(${batch.join(",")})`
    );

    const response = await fetch(endpoint, {
      headers: {
        apikey: key,
        Authorization: `Bearer ${key}`,
        Accept: "application/json",
      },
    });

    if (!response.ok) {
      const details = await response.text();

      throw new Error(
        `Supabase existing team crests: ` +
        `HTTP ${response.status} ` +
        details.slice(0, 300)
      );
    }

    const rows = await response.json();

    for (const row of rows) {
      if (row.crest) {
        crests.set(row.provider_id, row.crest);
      }
    }
  }

  return crests;
}

/*
  Save team rows while preserving known crests.

  Crest priority:
  1. Current provider response
  2. Previously saved database value
  3. Null for a genuinely new team without a crest
*/

async function saveTeamsPreservingCrests(rows) {
  if (!rows.length) return;

  const ids = rows.map(row => row.provider_id);

  const savedCrests = await existingTeamCrests(ids);

  const protectedRows = rows.map(row => ({
    ...row,
    crest:
      row.crest ||
      savedCrests.get(row.provider_id) ||
      null,
  }));

  await saveRows(
    "fd_teams",
    protectedRows,
    "provider_id"
  );
}

function retryDelay(response, attempt) {
  const retryAfter = response.headers.get("retry-after");

  if (retryAfter) {
    const seconds = Number(retryAfter);

    if (Number.isFinite(seconds) && seconds >= 0) {
      return Math.max(
        10000,
        Math.min(60000, seconds * 1000)
      );
    }

    const date = Date.parse(retryAfter);

    if (Number.isFinite(date)) {
      return Math.max(
        10000,
        Math.min(60000, date - Date.now())
      );
    }
  }

  return attempt * 10000;
}

/*
  Shared football-data.org request helper.
  Handles HTTP 429 rate limiting.
*/

async function footballRequest(endpoint, code) {
  for (let attempt = 1; attempt <= 4; attempt++) {
    const response = await fetch(endpoint, {
      headers: {
        "X-Auth-Token": process.env.FOOTBALL_DATA_API_KEY,
        Accept: "application/json",
      },
    });

    if (response.ok) {
      return response.json();
    }

    if (response.status === 429 && attempt < 4) {
      const delay = retryDelay(response, attempt);

      console.warn(
        `[Football Import] ${code}: HTTP 429, ` +
        `retry ${attempt + 1}/4 after ` +
        `${Math.ceil(delay / 1000)} seconds`
      );

      await wait(delay);
      continue;
    }

    const details = await response.text();

    throw new Error(
      `${code}: HTTP ${response.status} ` +
      details.slice(0, 200)
    );
  }

  throw new Error(`${code}: request failed`);
}

/*
  MATCH IMPORT
*/

async function getMatches({ code, season }) {
  const endpoint = new URL(
    `https://api.football-data.org/v4/competitions/${code}/matches`
  );

  if (season) {
    endpoint.searchParams.set(
      "season",
      String(season)
    );
  }

  const data = await footballRequest(
    endpoint,
    `${code} matches`
  );

  if (
    !Array.isArray(data.matches) ||
    data.matches.length === 0
  ) {
    throw new Error(`${code}: API returned no matches`);
  }

  return data.matches;
}

/*
  TEAM ROW

  The crest field is now included.
*/

function teamRow(team) {
  if (!team || !Number.isInteger(team.id)) {
    return null;
  }

  return {
    provider_id: team.id,

    name:
      team.name ||
      team.shortName ||
      `Team ${team.id}`,

    short_name: team.shortName || null,
    tla: team.tla || null,
    crest: team.crest || null,

    updated_at: new Date().toISOString(),
  };
}

function matchRow(match, code) {
  return {
    provider_id: match.id,
    competition_code: code,

    season_start: match.season?.startDate
      ? Number(match.season.startDate.slice(0, 4))
      : null,

    matchday: match.matchday ?? null,
    kickoff: match.utcDate || null,
    status: match.status || null,

    home_team_id: Number.isInteger(match.homeTeam?.id)
      ? match.homeTeam.id
      : null,

    away_team_id: Number.isInteger(match.awayTeam?.id)
      ? match.awayTeam.id
      : null,

    home_goals:
      match.score?.fullTime?.home ?? null,

    away_goals:
      match.score?.fullTime?.away ?? null,

    updated_at: new Date().toISOString(),
  };
}

/*
  OFFICIAL-SOURCE STANDINGS IMPORT
*/

async function getStandings({ code, season }) {
  const endpoint = new URL(
    `https://api.football-data.org/v4/competitions/${code}/standings`
  );

  if (season) {
    endpoint.searchParams.set(
      "season",
      String(season)
    );
  }

  const data = await footballRequest(
    endpoint,
    `${code} standings`
  );

  if (
    !Array.isArray(data.standings) ||
    data.standings.length === 0
  ) {
    throw new Error(
      `${code}: API returned no standings`
    );
  }

  return data;
}

function standingsSeason(data) {
  const startDate = data.season?.startDate;

  if (!startDate) {
    throw new Error(
      "Standings response has no season start date"
    );
  }

  const year = Number(startDate.slice(0, 4));

  if (
    !Number.isInteger(year) ||
    year < 2000 ||
    year > 2100
  ) {
    throw new Error(
      "Invalid standings season"
    );
  }

  return year;
}

function standingsRows(data, code) {
  const season = standingsSeason(data);
  const timestamp = new Date().toISOString();

  /*
    Domestic leagues normally provide TOTAL,
    HOME and AWAY tables. We import TOTAL only.
  */

  const total = data.standings.find(
    item => item.type === "TOTAL" &&
      Array.isArray(item.table)
  );

  if (!total || !total.table.length) {
    throw new Error(
      `${code}: no TOTAL standings table`
    );
  }

  const rows = [];

  for (const entry of total.table) {
    const team = entry.team || {};

    if (
      !Number.isInteger(team.id) ||
      !Number.isInteger(entry.position)
    ) {
      throw new Error(
        `${code}: invalid standings entry`
      );
    }

    rows.push({
      competition_code: code,
      season_start: season,
      standing_type: "TOTAL",

      team_id: team.id,
      position: entry.position,

      played_games: entry.playedGames ?? 0,
      won: entry.won ?? 0,
      drawn: entry.draw ?? 0,
      lost: entry.lost ?? 0,

      goals_for: entry.goalsFor ?? 0,
      goals_against: entry.goalsAgainst ?? 0,
      goal_difference: entry.goalDifference ?? 0,
      points: entry.points ?? 0,

      team_name:
        team.name ||
        team.shortName ||
        `Team ${team.id}`,

      team_short_name: team.shortName || null,
      team_tla: team.tla || null,
      team_crest: team.crest || null,

      team_form: entry.form || null,
      updated_at: timestamp,
    });
  }

  return rows;
}

/*
  IMPORT MATCHES AND TEAMS

  Existing functionality is preserved.
  Team crests are now imported automatically.
*/

async function importMatches(competition) {
  const { code, name } = competition;

  const matches = await getMatches(competition);
  const teams = new Map();

  for (const match of matches) {
    for (const team of [
      match.homeTeam,
      match.awayTeam
    ]) {
      const row = teamRow(team);

      if (row) {
        const previous = teams.get(row.provider_id);

        /*
          If multiple matches contain the same team,
          retain a crest found in any of them.
        */

        if (
          previous?.crest &&
          !row.crest
        ) {
          row.crest = previous.crest;
        }

        teams.set(row.provider_id, row);
      }
    }
  }

  await saveRows(
    "fd_competitions",
    [{
      code,
      name,
      updated_at: new Date().toISOString(),
    }],
    "code"
  );

  await saveTeamsPreservingCrests(
    [...teams.values()]
  );

  await saveRows(
    "fd_matches",
    matches.map(match => matchRow(match, code)),
    "provider_id"
  );

  console.log(
    `[Football Import] ${code}: ` +
    `${matches.length} matches, ` +
    `${teams.size} teams`
  );

  return {
    status: "success",
    teams: teams.size,
    matches: matches.length,
  };
}

/*
  IMPORT OFFICIAL STANDINGS

  Standings also provide club crests.
  We use these to supplement fd_teams.
*/

async function importStandings(competition) {
  const data = await getStandings(competition);

  const rows = standingsRows(
    data,
    competition.code
  );

  await saveRows(
    "fd_standings",
    rows,
    "competition_code,season_start,standing_type,team_id"
  );

  /*
    Refresh the teams table from the same
    official-source standings response.

    This is especially useful when the match
    response does not include club crests.
  */

  const total = data.standings.find(
    item => item.type === "TOTAL" &&
      Array.isArray(item.table)
  );

  if (total) {
    const teamRows = total.table
      .map(entry => teamRow(entry.team))
      .filter(Boolean);

    await saveTeamsPreservingCrests(teamRows);
  }

  console.log(
    `[Football Standings] ${competition.code}: ` +
    `${rows.length} teams, ` +
    `season ${rows[0].season_start}`
  );

  return {
    status: "success",
    season: rows[0].season_start,
    teams: rows.length,
  };
}

/*
  MAIN IMPORT HANDLER
*/

module.exports = async function handler(req, res) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");

    return res.status(405).json({
      error: "Method not allowed",
    });
  }

  if (
    !process.env.CRON_SECRET ||
    req.headers.authorization !==
      `Bearer ${process.env.CRON_SECRET}`
  ) {
    return res.status(401).json({
      error: "Unauthorized",
    });
  }

  if (
    !process.env.FOOTBALL_DATA_API_KEY ||
    !process.env.SUPABASE_URL ||
    !(
      process.env.SUPABASE_SECRET_KEY ||
      process.env.SUPABASE_SERVICE_ROLE_KEY
    )
  ) {
    return res.status(500).json({
      error: "Missing server environment variables",
    });
  }

  const results = [];

  for (const competition of COMPETITIONS) {
    const { code, standings } = competition;

    const result = {
      league: code,
    };

    /*
      Match imports and standings imports
      remain independent.

      A failed standings request will not
      prevent the matches from being saved.
    */

    try {
      result.matches = await importMatches(
        competition
      );
    } catch (error) {
      console.error(
        `[Football Import] ${code}: ${error.message}`
      );

      result.matches = {
        status: "error",
        message: error.message,
      };
    }

    if (standings) {
      /*
        Pause before the second API request
        to reduce rate-limit pressure.
      */

      await wait(7000);

      try {
        result.standings = await importStandings(
          competition
        );
      } catch (error) {
        console.error(
          `[Football Standings] ${code}: ` +
          error.message
        );

        result.standings = {
          status: "error",
          message: error.message,
        };
      }
    } else {
      result.standings = {
        status: "not_applicable",
      };
    }

    results.push(result);

    if (code !== "EC") {
      await wait(7000);
    }
  }

  const matchFailures = results.filter(
    result => result.matches.status === "error"
  );

  const standingsFailures = results.filter(
    result => result.standings.status === "error"
  );

  const completed =
    matchFailures.length === 0 &&
    standingsFailures.length === 0;

  console.log(
    `[Football Import] Finished. ` +
    `Match failures: ${matchFailures.length}. ` +
    `Standings failures: ${standingsFailures.length}.`
  );

  return res.status(completed ? 200 : 207).json({
    completed,
    match_imports_successful:
      matchFailures.length === 0,
    standings_imports_successful:
      standingsFailures.length === 0,
    results,
  });
};
