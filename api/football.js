
"use strict";

const ALLOWED_COMPETITIONS = new Set([
  "PL", "PD", "SA", "BL1", "FL1", "PPL", "CL", "WC", "EC"
]);

const ALLOWED_TYPES = new Set([
  "results", "fixtures", "matchdays"
]);

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SECRET_KEY = process.env.SUPABASE_SECRET_KEY;

function send(res, status, body) {
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader(
    "Cache-Control",
    "public, s-maxage=300, stale-while-revalidate=600"
  );
  return res.status(status).json(body);
}

function readInteger(value, min, max) {
  if (value === undefined || value === null || value === "") {
    return null;
  }

  if (!/^\d+$/.test(String(value))) return NaN;

  const number = Number(value);

  if (!Number.isSafeInteger(number) ||
      number < min || number > max) {
    return NaN;
  }

  return number;
}

async function supabaseRead(table, params) {
  const url = new URL(
    `${SUPABASE_URL.replace(/\/+$/, "")}/rest/v1/${table}`
  );

  for (const [key, value] of params.entries()) {
    url.searchParams.append(key, value);
  }

  const response = await fetch(url, {
    headers: {
      apikey: SUPABASE_SECRET_KEY,
      Authorization: `Bearer ${SUPABASE_SECRET_KEY}`,
      Accept: "application/json"
    }
  });

  if (!response.ok) {
    const details = await response.text();
    console.error(
      `[Football API] Supabase ${response.status}: ${details}`
    );
    throw new Error("Database request failed");
  }

  return response.json();
}

function matchQuery(competition, season, matchday) {
  const params = new URLSearchParams();

  params.set("select", [
    "provider_id",
    "competition_code",
    "season_start",
    "matchday",
    "kickoff",
    "status",
    "home_team_id",
    "away_team_id",
    "home_goals",
    "away_goals"
  ].join(","));

  params.set("competition_code", `eq.${competition}`);

  if (season !== null) {
    params.set("season_start", `eq.${season}`);
  }

  if (matchday !== null) {
    params.set("matchday", `eq.${matchday}`);
  }

  return params;
}

async function getLastUpdated(competition) {
  const params = new URLSearchParams();

  params.set("select", "updated_at");
  params.set("competition_code", `eq.${competition}`);
  params.set("updated_at", "not.is.null");
  params.set("order", "updated_at.desc");
  params.set("limit", "1");

  const rows = await supabaseRead("fd_matches", params);

  return rows.length ? rows[0].updated_at : null;
}

async function attachTeams(matches) {
  const ids = [
    ...new Set(
      matches.flatMap(match => [
        match.home_team_id,
        match.away_team_id
      ]).filter(id => id !== null && id !== undefined)
    )
  ];

  if (!ids.length) {
    return matches.map(match => ({
      ...match,
      home_team: null,
      away_team: null
    }));
  }

  const params = new URLSearchParams();

  params.set(
    "select",
    "provider_id,name,short_name,tla"
  );

  params.set("provider_id", `in.(${ids.join(",")})`);

  const teams = await supabaseRead("fd_teams", params);

  const byId = new Map(
    teams.map(team => [String(team.provider_id), team])
  );

  return matches.map(match => {
    const {
      home_team_id,
      away_team_id,
      ...publicMatch
    } = match;

    return {
      ...publicMatch,
      home_team: byId.get(String(home_team_id)) || null,
      away_team: byId.get(String(away_team_id)) || null
    };
  });
}

module.exports = async function handler(req, res) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return send(res, 405, { error: "Method not allowed" });
  }

  if (!SUPABASE_URL || !SUPABASE_SECRET_KEY) {
    console.error("[Football API] Missing Supabase configuration");
    return send(res, 503, { error: "Service unavailable" });
  }

  const competition = String(req.query.competition || "PL")
    .toUpperCase();

  const type = String(req.query.type || "results")
    .toLowerCase();

  const season = readInteger(req.query.season, 2000, 2100);
  const matchday = readInteger(req.query.matchday, 1, 100);
  const requestedLimit = readInteger(req.query.limit, 1, 100);

  if (!ALLOWED_COMPETITIONS.has(competition)) {
    return send(res, 400, { error: "Invalid competition" });
  }

  if (!ALLOWED_TYPES.has(type)) {
    return send(res, 400, { error: "Invalid type" });
  }

  if (
    Number.isNaN(season) ||
    Number.isNaN(matchday) ||
    Number.isNaN(requestedLimit)
  ) {
    return send(res, 400, { error: "Invalid query parameter" });
  }

  const limit = requestedLimit ?? (matchday !== null ? 100 : 20);

  try {
    if (type === "matchdays") {
      const params = matchQuery(competition, season, null);

      params.set("select", "matchday,season_start");
      params.set("matchday", "not.is.null");
      params.set("order", "season_start.desc,matchday.desc");
      params.set("limit", "1000");

      const [rows, lastUpdated] = await Promise.all([
        supabaseRead("fd_matches", params),
        getLastUpdated(competition)
      ]);

      const seasons = {};

      for (const row of rows) {
        const key = String(row.season_start);

        if (!seasons[key]) seasons[key] = new Set();

        seasons[key].add(row.matchday);
      }

      const availableSeasons = Object.entries(seasons)
        .map(([year, days]) => ({
          season: Number(year),
          matchdays: [...days].sort((a, b) => b - a)
        }))
        .sort((a, b) => b.season - a.season);

      return send(res, 200, {
        competition,
        type,
        last_updated: lastUpdated,
        seasons: availableSeasons
      });
    }

    const params = matchQuery(competition, season, matchday);

    if (type === "results") {
      params.set("status", "eq.FINISHED");
      params.set("order", "kickoff.desc");
    } else {
      params.set(
        "status",
        "in.(SCHEDULED,TIMED,POSTPONED)"
      );
      params.set("order", "kickoff.asc");
    }

    params.set("limit", String(limit));

    const [matches, lastUpdated] = await Promise.all([
      supabaseRead("fd_matches", params),
      getLastUpdated(competition)
    ]);

    const enrichedMatches = await attachTeams(matches);

    return send(res, 200, {
      competition,
      type,
      season,
      matchday,
      last_updated: lastUpdated,
      count: enrichedMatches.length,
      matches: enrichedMatches
    });

  } catch (error) {
    console.error("[Football API]", error);

    return send(res, 502, {
      error: "Unable to retrieve football data"
    });
  }
};
