const ALLOWED_COMPETITIONS = [
  "PL", "PD", "SA", "BL1", "FL1", "PPL", "CL", "WC", "EC"
];

const ALLOWED_TYPES = ["results", "fixtures", "all"];

module.exports = async function handler(req, res) {
  if (req.method !== "GET") {
    return res.status(405).json({
      error: "Method not allowed"
    });
  }

  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey =
    process.env.SUPABASE_SECRET_KEY ||
    process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !supabaseKey) {
    return res.status(500).json({
      error: "Database configuration missing"
    });
  }

  const competition = String(
    req.query.competition || "PL"
  ).toUpperCase();

  const type = String(
    req.query.type || "results"
  ).toLowerCase();

  if (!ALLOWED_COMPETITIONS.includes(competition)) {
    return res.status(400).json({
      error: "Invalid competition"
    });
  }

  if (!ALLOWED_TYPES.includes(type)) {
    return res.status(400).json({
      error: "Invalid type"
    });
  }

  const rawLimit = String(req.query.limit || "20");

  if (!/^\d+$/.test(rawLimit)) {
    return res.status(400).json({
      error: "Invalid limit"
    });
  }

  const limit = Math.min(
    100,
    Math.max(1, Number(rawLimit))
  );

  const origin = new URL(supabaseUrl).origin;

  const query = new URL(
    `${origin}/rest/v1/fd_matches`
  );

  query.searchParams.set(
    "select",
    "provider_id,competition_code,season_start,matchday,kickoff,status,home_goals,away_goals,home_team:fd_teams!fd_matches_home_team_id_fkey(name,short_name,tla),away_team:fd_teams!fd_matches_away_team_id_fkey(name,short_name,tla)"
  );

  query.searchParams.set(
    "competition_code",
    `eq.${competition}`
  );

  if (type === "results") {
    query.searchParams.set(
      "status",
      "eq.FINISHED"
    );
    query.searchParams.set(
      "order",
      "kickoff.desc"
    );
  } else if (type === "fixtures") {
    query.searchParams.set(
      "status",
      "in.(SCHEDULED,TIMED)"
    );
    query.searchParams.set(
      "kickoff",
      `gte.${new Date().toISOString()}`
    );
    query.searchParams.set(
      "order",
      "kickoff.asc"
    );
  } else {
    query.searchParams.set(
      "order",
      "kickoff.desc"
    );
  }

  query.searchParams.set(
    "limit",
    String(limit)
  );

  try {
    const response = await fetch(query, {
      headers: {
        apikey: supabaseKey,
        Authorization: `Bearer ${supabaseKey}`,
        Accept: "application/json"
      }
    });

    if (!response.ok) {
      console.error(
        "[Football API] Supabase error:",
        response.status,
        (await response.text()).slice(0, 300)
      );

      return res.status(502).json({
        error: "Unable to retrieve football data"
      });
    }

    const matches = await response.json();

    res.setHeader(
      "Cache-Control",
      "public, s-maxage=300, stale-while-revalidate=600"
    );

    return res.status(200).json({
      competition,
      type,
      count: matches.length,
      matches
    });
  } catch (error) {
    console.error(
      "[Football API] Request failed:",
      error.message
    );

    return res.status(500).json({
      error: "Internal server error"
    });
  }
};
