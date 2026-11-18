
const PRODUCTION_API =
  "https://www.ballonenbois.com/api/football";

module.exports = async function handler(req, res) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({
      error: "Method not allowed"
    });
  }

  // Prevent this proxy from operating in production.
  if (process.env.VERCEL_ENV !== "preview") {
    return res.status(403).json({
      error: "Preview only"
    });
  }

  const allowedParams = [
    "competition",
    "type",
    "season",
    "matchday",
    "limit"
  ];

  const params = new URLSearchParams();

  for (const key of allowedParams) {
    const value = req.query[key];

    if (typeof value === "string") {
      params.set(key, value);
    }
  }

  try {
    const response = await fetch(
      `${PRODUCTION_API}?${params.toString()}`,
      {
        method: "GET",
        headers: {
          Accept: "application/json"
        },
        signal: AbortSignal.timeout(10000)
      }
    );

    if (!response.ok) {
      return res.status(502).json({
        error: "Production football API unavailable"
      });
    }

    const data = await response.json();

    res.setHeader(
      "Cache-Control",
      "public, s-maxage=60, stale-while-revalidate=300"
    );

    return res.status(200).json(data);
  } catch (error) {
    console.error(
      "Football preview proxy error:",
      error.message
    );

    return res.status(502).json({
      error: "Football preview proxy unavailable"
    });
  }
};
