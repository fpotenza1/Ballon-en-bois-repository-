const LEAGUES = [
  ["PL", "Premier League"],
  ["PD", "La Liga"],
  ["SA", "Serie A"],
  ["BL1", "Bundesliga"],
  ["FL1", "Ligue 1"],
  ["PPL", "Primeira Liga"],
];

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const MAX_ATTEMPTS = 4;
const BETWEEN_LEAGUES_MS = 7000;

function supabaseConfig() {
  const rawUrl = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!rawUrl || !key) throw new Error("Missing Supabase configuration");
  const url = new URL(rawUrl);
  if (url.protocol !== "https:") throw new Error("SUPABASE_URL must use HTTPS");
  return { origin: url.origin, key };
}

async function saveRows(table, rows, conflict) {
  if (!rows.length) return;
  const { origin, key } = supabaseConfig();

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
      throw new Error(`Supabase ${table}: HTTP ${response.status} ${(await response.text()).slice(0, 300)}`);
    }
  }
}

function retryDelay(response, attempt) {
  const header = response.headers.get("retry-after");
  if (header) {
    const seconds = Number(header);
    if (Number.isFinite(seconds) && seconds >= 0) {
      return Math.min(60000, Math.max(10000, seconds * 1000));
    }
    const dateMs = Date.parse(header);
    if (Number.isFinite(dateMs)) {
      return Math.min(60000, Math.max(10000, dateMs - Date.now()));
    }
  }
  return 10000 * attempt;
}

async function getMatches(code) {
  const url = `https://api.football-data.org/v4/competitions/${encodeURIComponent(code)}/matches`;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const response = await fetch(url, {
      headers: { "X-Auth-Token": process.env.FOOTBALL_DATA_API_KEY },
    });

    if (response.ok) {
      const data = await response.json();
      if (!Array.isArray(data.matches) || data.matches.length === 0) {
        throw new Error(`Football API ${code}: no matches returned; skipping update`);
      }
      return data.matches;
    }

    if (response.status === 429 && attempt < MAX_ATTEMPTS) {
      const delay = retryDelay(response, attempt);
      console.warn(`[Football Import] ${code}: HTTP 429, retry ${attempt + 1}/${MAX_ATTEMPTS} after ${Math.ceil(delay / 1000)}s`);
      await wait(delay);
      continue;
    }

    throw new Error(`Football API ${code}: HTTP ${response.status} ${(await response.text()).slice(0, 200)}`);
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
    season_start: match.season?.startDate ? Number(match.season.startDate.slice(0, 4)) : null,
    matchday: match.matchday ?? null,
    kickoff: match.utcDate || null,
    status: match.status || null,
    home_team_id: Number.isInteger(match.homeTeam?.id) ? match.homeTeam.id : null,
    away_team_id: Number.isInteger(match.awayTeam?.id) ? match.awayTeam.id : null,
    home_goals: match.score?.fullTime?.home ?? null,
    away_goals: match.score?.fullTime?.away ?? null,
    updated_at: new Date().toISOString(),
  };
}

module.exports = async function handler(req, res) {
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });

  const secret = process.env.CRON_SECRET;
  if (!secret || req.headers.authorization !== `Bearer ${secret}`) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  if (!process.env.FOOTBALL_DATA_API_KEY || !process.env.SUPABASE_URL ||
      !(process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY)) {
    return res.status(500).json({ error: "Missing server environment variables" });
  }

  const results = [];
  for (const [code, name] of LEAGUES) {
    try {
      await saveRows("fd_competitions", [{ code, name, updated_at: new Date().toISOString() }], "code");
      const matches = await getMatches(code);
      const teams = new Map();
      for (const match of matches) {
        for (const team of [match.homeTeam, match.awayTeam]) {
          const row = teamRow(team);
          if (row) teams.set(row.provider_id, row);
        }
      }
      await saveRows("fd_teams", [...teams.values()], "provider_id");
      await saveRows("fd_matches", matches.map((match) => matchRow(match, code)), "provider_id");
      results.push({ league: code, status: "success", teams: teams.size, matches: matches.length });
      console.log(`[Football Import] ${code}: imported ${matches.length} matches, ${teams.size} teams`);
    } catch (error) {
      console.error(`[Football Import] League ${code} failed: ${error.message}`);
      results.push({ league: code, status: "error", message: error.message });
    }
    if (code !== "PPL") await wait(BETWEEN_LEAGUES_MS);
  }

  const failed = results.some((result) => result.status === "error");
  console.log(`[Football Import] Finished: ${results.filter((r) => r.status === "success").length}/${LEAGUES.length} leagues succeeded`);
  return res.status(failed ? 207 : 200).json({ completed: !failed, results });
};
