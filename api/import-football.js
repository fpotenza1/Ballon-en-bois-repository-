const COMPETITIONS = [
  { code: "PL", name: "Premier League" },
  { code: "PD", name: "La Liga" },
  { code: "SA", name: "Serie A" },
  { code: "BL1", name: "Bundesliga" },
  { code: "FL1", name: "Ligue 1" },
  { code: "PPL", name: "Primeira Liga" },
  { code: "CL", name: "UEFA Champions League" },
  { code: "WC", name: "FIFA World Cup", season: 2026 },
  { code: "EC", name: "UEFA European Championship", season: 2024 },
];

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function supabaseCredentials() {
  const url = new URL(process.env.SUPABASE_URL);
  const key = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key) throw new Error("Missing Supabase secret key");
  return { origin: url.origin, key };
}

async function saveRows(table, rows, conflict) {
  if (rows.length === 0) return;
  const { origin, key } = supabaseCredentials();

  for (let i = 0; i < rows.length; i += 100) {
    const batch = rows.slice(i, i + 100);
    const response = await fetch(
      `${origin}/rest/v1/${encodeURIComponent(table)}?on_conflict=${encodeURIComponent(conflict)}`,
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
        `Supabase ${table}: HTTP ${response.status} ${(await response.text()).slice(0, 300)}`
      );
    }
  }
}

function retryDelay(response, attempt) {
  const retryAfter = response.headers.get("retry-after");

  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) {
      return Math.max(10000, Math.min(60000, seconds * 1000));
    }

    const date = Date.parse(retryAfter);
    if (Number.isFinite(date)) {
      return Math.max(10000, Math.min(60000, date - Date.now()));
    }
  }

  return attempt * 10000;
}

async function getMatches({ code, season }) {
  const endpoint = new URL(
    `https://api.football-data.org/v4/competitions/${code}/matches`
  );

  if (season) {
    endpoint.searchParams.set("season", String(season));
  }

  for (let attempt = 1; attempt <= 4; attempt++) {
    const response = await fetch(endpoint, {
      headers: {
        "X-Auth-Token": process.env.FOOTBALL_DATA_API_KEY,
      },
    });

    if (response.ok) {
      const data = await response.json();

      if (!Array.isArray(data.matches) || data.matches.length === 0) {
        throw new Error(`${code}: API returned no matches`);
      }

      return data.matches;
    }

    if (response.status === 429 && attempt < 4) {
      const delay = retryDelay(response, attempt);

      console.warn(
        `[Football Import] ${code}: HTTP 429, retry ${attempt + 1}/4 after ${Math.ceil(delay / 1000)} seconds`
      );

      await wait(delay);
      continue;
    }

    throw new Error(
      `${code}: HTTP ${response.status} ${(await response.text()).slice(0, 200)}`
    );
  }
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

  if (
    !process.env.CRON_SECRET ||
    req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`
  ) {
    return res.status(401).json({ error: "Unauthorized" });
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
    const { code, name } = competition;

    try {
      const matches = await getMatches(competition);
      const teams = new Map();

      for (const match of matches) {
        for (const team of [match.homeTeam, match.awayTeam]) {
          const row = teamRow(team);
          if (row) teams.set(row.provider_id, row);
        }
      }

      await saveRows(
        "fd_competitions",
        [{ code, name, updated_at: new Date().toISOString() }],
        "code"
      );

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

      console.log(
        `[Football Import] ${code}: imported ${matches.length} matches, ${teams.size} teams`
      );
    } catch (error) {
      console.error(`[Football Import] ${code}: ${error.message}`);

      results.push({
        league: code,
        status: "error",
        message: error.message,
      });
    }

    if (code !== "EC") {
      await wait(7000);
    }
  }

  const failed = results.some(
    (result) => result.status === "error"
  );

  console.log(
    `[Football Import] Finished: ${
      results.filter((result) => result.status === "success").length
    }/${COMPETITIONS.length} competitions succeeded`
  );

  return res.status(failed ? 207 : 200).json({
    completed: !failed,
    results,
  });
};
