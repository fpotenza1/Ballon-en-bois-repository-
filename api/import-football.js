
const LEAGUES = [
  ["PL", "Premier League"],
  ["PD", "La Liga"],
  ["SA", "Serie A"],
  ["BL1", "Bundesliga"],
  ["FL1", "Ligue 1"],
  ["PPL", "Primeira Liga"],
];

const wait = (ms) =>
  new Promise((resolve) => setTimeout(resolve, ms));

async function saveRows(table, rows, conflict) {
  if (!rows.length) return;

  const url = process.env.SUPABASE_URL.replace(/\/$/, "");
  const key =
    process.env.SUPABASE_SECRET_KEY ||
    process.env.SUPABASE_SERVICE_ROLE_KEY;

  for (let i = 0; i < rows.length; i += 100) {
    const batch = rows.slice(i, i + 100);

    const response = await fetch(
      `${url}/rest/v1/${table}?on_conflict=${conflict}`,
      {
        method: "POST",
        headers: {
          apikey: key,
          Authorization: `Bearer ${key}`,
          "Content-Type": "application/json",
          Prefer: "resolution=merge-duplicates,return=minimal",
        },
        body: JSON.stringify(batch),
      }
    );

    if (!response.ok) {
      throw new Error(
        `Supabase ${table}: ${response.status} ` +
        (await response.text()).slice(0, 300)
      );
    }
  }
}

async function getMatches(code) {
  const response = await fetch(
    `https://api.football-data.org/v4/competitions/${code}/matches`,
    {
      headers: {
        "X-Auth-Token": process.env.FOOTBALL_DATA_API_KEY,
      },
    }
  );

  if (!response.ok) {
    throw new Error(
      `Football API ${code}: HTTP ${response.status} ` +
      (await response.text()).slice(0, 200)
    );
  }

  return response.json();
}

function teamRow(team) {
  if (!team || !Number.isInteger(team.id)) return null;

  return {
    provider_id: team.id,
    name: team.name || team.shortName || `Team ${team.id}`,
    short_name: team.shortName || null,
    tla: team.tla || null,
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
    home_goals: match.score?.fullTime?.home ?? null,
    away_goals: match.score?.fullTime?.away ?? null,
    updated_at: new Date().toISOString(),
  };
}

module.exports = async function handler(req, res) {
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const secret = process.env.CRON_SECRET;

  if (
    !secret ||
    req.headers.authorization !== `Bearer ${secret}`
  ) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const required = [
    "FOOTBALL_DATA_API_KEY",
    "SUPABASE_URL",
  ];

  if (
    required.some((name) => !process.env[name]) ||
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

  for (const [code, name] of LEAGUES) {
    try {
      await saveRows(
        "fd_competitions",
        [{
          code,
          name,
          updated_at: new Date().toISOString(),
        }],
        "code"
      );

      const data = await getMatches(code);
      const matches = Array.isArray(data.matches)
        ? data.matches
        : [];

      const teams = new Map();

      for (const match of matches) {
        for (const team of [
          match.homeTeam,
          match.awayTeam,
        ]) {
          const row = teamRow(team);
          if (row) teams.set(row.provider_id, row);
        }
      }

      await saveRows(
        "fd_teams",
        [...teams.values()],
        "provider_id"
      );

      await saveRows(
        "fd_matches",
        matches.map((match) => matchRow(match, code)),
        "provider_id"
      );

      results.push({
        league: code,
        status: "success",
        teams: teams.size,
        matches: matches.length,
      });
    } catch (error) {
  console.error(
    `[Football Import] League ${code} failed:`,
    error.message
  );

  results.push({
    league: code,
    status: "error",
    message: error.message,
  });
}

    // Stay below the free API rate limit.
    if (code !== "PPL") await wait(7000);
  }

  const failed = results.some(
    (result) => result.status === "error"
  );

  return res.status(failed ? 207 : 200).json({
    completed: !failed,
    results,
  });
};
