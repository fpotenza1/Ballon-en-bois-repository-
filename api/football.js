
"use strict";

/*
  BALLON EN BOIS
  Public football data API

  Supported types:
  - results
  - fixtures
  - matchdays
  - standings

  Standings are imported from football-data.org
  and stored in Supabase.

  The API does not recalculate league rankings.
*/

const ALLOWED_COMPETITIONS = new Set([
  "PL", "PD", "SA", "BL1", "FL1", "PPL",
  "CL", "WC", "EC"
]);

const STANDINGS_COMPETITIONS = new Set([
  "PL", "PD", "SA", "BL1", "FL1", "PPL"
]);

const ALLOWED_TYPES = new Set([
  "results",
  "fixtures",
  "matchdays",
  "standings"
]);

const SUPABASE_URL = process.env.SUPABASE_URL;

const SUPABASE_SECRET_KEY =
  process.env.SUPABASE_SECRET_KEY ||
  process.env.SUPABASE_SERVICE_ROLE_KEY;

/*
  HTTP RESPONSE
*/

function send(res, status, body) {
  res.setHeader(
    "Content-Type",
    "application/json; charset=utf-8"
  );

  res.setHeader(
    "Cache-Control",
    "public, s-maxage=300, stale-while-revalidate=600"
  );

  return res.status(status).json(body);
}

/*
  QUERY PARAMETER VALIDATION
*/

function readInteger(value, min, max) {
  if (
    value === undefined ||
    value === null ||
    value === ""
  ) {
    return null;
  }

  if (!/^\d+$/.test(String(value))) {
    return NaN;
  }

  const number = Number(value);

  if (
    !Number.isSafeInteger(number) ||
    number < min ||
    number > max
  ) {
    return NaN;
  }

  return number;
}

/*
  SUPABASE READ HELPER
*/

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

/*
  MATCH QUERY BUILDER
*/

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

  params.set(
    "competition_code",
    `eq.${competition}`
  );

  if (season !== null) {
    params.set(
      "season_start",
      `eq.${season}`
    );
  }

  if (matchday !== null) {
    params.set(
      "matchday",
      `eq.${matchday}`
    );
  }

  return params;
}

/*
  LAST MATCH DATABASE UPDATE
*/

async function getLastUpdated(competition) {
  const params = new URLSearchParams();

  params.set("select", "updated_at");

  params.set(
    "competition_code",
    `eq.${competition}`
  );

  params.set(
    "updated_at",
    "not.is.null"
  );

  params.set(
    "order",
    "updated_at.desc"
  );

  params.set("limit", "1");

  const rows = await supabaseRead(
    "fd_matches",
    params
  );

  return rows.length
    ? rows[0].updated_at
    : null;
}

/*
  ATTACH TEAM DETAILS TO MATCHES
*/

async function attachTeams(matches) {
  const ids = [
    ...new Set(
      matches.flatMap(match => [
        match.home_team_id,
        match.away_team_id
      ]).filter(
        id => id !== null && id !== undefined
      )
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
    "provider_id,name,short_name,tla,crest"
  );

  params.set(
    "provider_id",
    `in.(${ids.join(",")})`
  );

  const teams = await supabaseRead(
    "fd_teams",
    params
  );

  const byId = new Map(
    teams.map(team => [
      String(team.provider_id),
      team
    ])
  );

  return matches.map(match => {
    const {
      home_team_id,
      away_team_id,
      ...publicMatch
    } = match;

    return {
      ...publicMatch,

      home_team:
        byId.get(String(home_team_id)) || null,

      away_team:
        byId.get(String(away_team_id)) || null
    };
  });
}

/*
  OFFICIAL-SOURCE LEAGUE STANDINGS

  Returns the positions and statistics
  supplied by football-data.org.

  No rankings or tiebreakers are
  recalculated by Ballon en Bois.
*/

async function getStandings(competition, season) {
  const params = new URLSearchParams();

  params.set("select", [
    "competition_code",
    "season_start",
    "standing_type",
    "team_id",
    "position",
    "played_games",
    "won",
    "drawn",
    "lost",
    "goals_for",
    "goals_against",
    "goal_difference",
    "points",
    "team_name",
    "team_short_name",
    "team_tla",
    "team_crest",
    "team_form",
    "updated_at"
  ].join(","));

  params.set(
    "competition_code",
    `eq.${competition}`
  );

  params.set(
    "standing_type",
    "eq.TOTAL"
  );

  if (season !== null) {
    params.set(
      "season_start",
      `eq.${season}`
    );
  }

  params.set(
    "order",
    "season_start.desc,position.asc"
  );

  params.set("limit", "100");

  const rows = await supabaseRead(
    "fd_standings",
    params
  );

  /*
    When no season is requested, select
    the most recent available season.
  */

  const selectedSeason =
    season !== null
      ? season
      : (rows[0]?.season_start ?? null);

  const selectedRows = rows.filter(
    row => row.season_start === selectedSeason
  );

  const lastUpdated = selectedRows.length
    ? selectedRows.reduce(
        (latest, row) =>
          !latest || row.updated_at > latest
            ? row.updated_at
            : latest,
        null
      )
    : null;

  const standings = selectedRows
    .sort((a, b) => a.position - b.position)
    .map(row => ({
      position: row.position,

      team: {
        id: row.team_id,
        name: row.team_name,
        short_name: row.team_short_name,
        tla: row.team_tla,
        crest: row.team_crest
      },

      played_games: row.played_games,
      won: row.won,
      drawn: row.drawn,
      lost: row.lost,

      goals_for: row.goals_for,
      goals_against: row.goals_against,
      goal_difference: row.goal_difference,

      points: row.points,
      form: row.team_form
    }));

  return {
    competition,
    type: "standings",
    source: "football-data.org",
    standing_type: "TOTAL",
    season: selectedSeason,
    last_updated: lastUpdated,
    count: standings.length,
    standings
  };
}

/*
  MAIN API HANDLER
*/

module.exports = async function handler(req, res) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");

    return send(res, 405, {
      error: "Method not allowed"
    });
  }

  if (
    !SUPABASE_URL ||
    !SUPABASE_SECRET_KEY
  ) {
    console.error(
      "[Football API] Missing Supabase configuration"
    );

    return send(res, 503, {
      error: "Service unavailable"
    });
  }

  const competition = String(
    req.query.competition || "PL"
  ).toUpperCase();

  const type = String(
    req.query.type || "results"
  ).toLowerCase();

  const season = readInteger(
    req.query.season,
    2000,
    2100
  );

  const matchday = readInteger(
    req.query.matchday,
    1,
    100
  );

  const requestedLimit = readInteger(
    req.query.limit,
    1,
    100
  );

  if (
    !ALLOWED_COMPETITIONS.has(competition)
  ) {
    return send(res, 400, {
      error: "Invalid competition"
    });
  }

  if (
    !ALLOWED_TYPES.has(type)
  ) {
    return send(res, 400, {
      error: "Invalid type"
    });
  }

  if (
    Number.isNaN(season) ||
    Number.isNaN(matchday) ||
    Number.isNaN(requestedLimit)
  ) {
    return send(res, 400, {
      error: "Invalid query parameter"
    });
  }

  /*
    Standings are available for the
    six domestic leagues only.
  */

  if (
    type === "standings" &&
    !STANDINGS_COMPETITIONS.has(competition)
  ) {
    return send(res, 400, {
      error:
        "Standings are available for domestic leagues only"
    });
  }

  const limit =
    requestedLimit ??
    (matchday !== null ? 100 : 20);

  try {

    /*
      OFFICIAL-SOURCE STANDINGS
    */

    if (type === "standings") {
      const data = await getStandings(
        competition,
        season
      );

      return send(res, 200, data);
    }

    /*
      AVAILABLE MATCHDAYS
    */

    
    if (type === "matchdays") {
      const rows = [];
      const pageSize = 1000;
      const maxPages = 30;

      // Retrieve all match records, not just the
      // first 100 or 1,000.
      for (let page = 0; page < maxPages; page++) {
        const params = matchQuery(
          competition,
          season,
          null
        );

        params.set(
          "select",
          "provider_id,season_start,matchday,kickoff,status"
        );

        params.set("matchday", "not.is.null");

        params.set(
          "order",
          "season_start.desc,provider_id.asc"
        );

        params.set("limit", String(pageSize));
        params.set(
          "offset",
          String(page * pageSize)
        );

        const batch = await supabaseRead(
          "fd_matches",
          params
        );

        rows.push(...batch);

        if (batch.length < pageSize) break;

        if (page === maxPages - 1) {
          throw new Error(
            "Matchday query exceeded pagination limit"
          );
        }
      }

      const lastUpdated =
        await getLastUpdated(competition);

      const now = Date.now();
      const seasons = new Map();

      for (const match of rows) {
        const year = Number(match.season_start);
        const day = Number(match.matchday);

        if (
          !Number.isInteger(year) ||
          !Number.isInteger(day) ||
          day < 1
        ) {
          continue;
        }

        if (!seasons.has(year)) {
          seasons.set(year, {
            all: new Set(),
            results: new Set(),
            fixtures: new Set(),
            latestResult: null,
            nextFixture: null
          });
        }

        const entry = seasons.get(year);
        entry.all.add(day);

        const kickoffTime = match.kickoff
          ? Date.parse(match.kickoff)
          : NaN;

        if (match.status === "FINISHED") {
          entry.results.add(day);

          if (
            Number.isFinite(kickoffTime) &&
            (
              entry.latestResult === null ||
              kickoffTime > entry.latestResult.time
            )
          ) {
            entry.latestResult = {
              day,
              time: kickoffTime
            };
          }
        }

        const scheduled =
          match.status === "SCHEDULED" ||
          match.status === "TIMED";

        // Only confirmed future kickoffs count
        // toward upcoming fixture navigation.
        if (
          scheduled &&
          Number.isFinite(kickoffTime) &&
          kickoffTime > now
        ) {
          entry.fixtures.add(day);

          if (
            entry.nextFixture === null ||
            kickoffTime < entry.nextFixture.time
          ) {
            entry.nextFixture = {
              day,
              time: kickoffTime
            };
          }
        }

        // A postponed match is included only
        // if it has a future-dated kickoff.
        if (
          match.status === "POSTPONED" &&
          Number.isFinite(kickoffTime) &&
          kickoffTime > now
        ) {
          entry.fixtures.add(day);
        }
      }

      const availableSeasons =
        [...seasons.entries()]
          .map(([year, entry]) => ({
            season: year,

            // Keep the existing field for
            // backward compatibility.
            matchdays:
              [...entry.all].sort((a, b) => b - a),

            results_matchdays:
              [...entry.results].sort((a, b) => a - b),

            fixtures_matchdays:
              [...entry.fixtures].sort((a, b) => a - b),

            latest_result_matchday:
              entry.latestResult?.day ?? null,

            next_fixture_matchday:
              entry.nextFixture?.day ?? null
          }))
          .sort((a, b) => b.season - a.season);

      return send(res, 200, {
        competition,
        type,
        last_updated: lastUpdated,
        seasons: availableSeasons
      });
    }


    /*
      MATCH RESULTS AND FIXTURES
    */

    const params = matchQuery(
      competition,
      season,
      matchday
    );

    if (type === "results") {
      params.set(
        "status",
        "eq.FINISHED"
      );

      params.set(
        "order",
        "kickoff.desc"
      );
    
    } else {
      // Upcoming fixtures must have a future kickoff.
      // Exclude postponed matches until they are
      // assigned a confirmed scheduled status.

      params.set(
        "status",
        "in.(SCHEDULED,TIMED)"
      );

      params.set(
        "kickoff",
        `gt.${new Date().toISOString()}`
      );

      params.set(
        "order",
        "kickoff.asc"
      );
    }


    params.set(
      "limit",
      String(limit)
    );

    const [matches, lastUpdated] =
      await Promise.all([
        supabaseRead("fd_matches", params),
        getLastUpdated(competition)
      ]);

    const enrichedMatches =
      await attachTeams(matches);

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
    console.error(
      "[Football API]",
      error
    );

    return send(res, 502, {
      error:
        "Unable to retrieve football data"
    });
  }
};
