import { tool } from "ai";
import { z } from "zod";
import { AppError } from "../lib/errors.ts";
import { fetchJsonSafe } from "./_fetch.ts";
import type { ToolContext, ToolGroup } from "./types.ts";

/**
 * 真實的天氣工具（Open-Meteo，免 API key）。
 * 原本的 starter 回隨機數，這裡換成兩段式：先 geocoding，再抓當前天氣。
 */

interface GeocodeHit {
  name: string;
  latitude: number;
  longitude: number;
  country?: string;
  admin1?: string;
}

interface GeocodeResponse {
  results?: GeocodeHit[];
}

interface ForecastResponse {
  current?: {
    temperature_2m?: number;
    relative_humidity_2m?: number;
    apparent_temperature?: number;
    weather_code?: number;
    wind_speed_10m?: number;
  };
  hourly?: { time?: string[] };
  current_units?: Record<string, string>;
}

// WMO weather code → 人類可讀描述（模型看的懂的語言比數字有用）。
const WEATHER_CODES: Record<number, string> = {
  0: "clear sky",
  1: "mainly clear",
  2: "partly cloudy",
  3: "overcast",
  45: "fog",
  48: "depositing rime fog",
  51: "light drizzle",
  53: "moderate drizzle",
  55: "dense drizzle",
  56: "light freezing drizzle",
  57: "dense freezing drizzle",
  61: "slight rain",
  63: "moderate rain",
  65: "heavy rain",
  66: "light freezing rain",
  67: "heavy freezing rain",
  71: "slight snow",
  73: "moderate snow",
  75: "heavy snow",
  77: "snow grains",
  80: "slight rain showers",
  81: "moderate rain showers",
  82: "violent rain showers",
  85: "slight snow showers",
  86: "heavy snow showers",
  95: "thunderstorm",
  96: "thunderstorm with slight hail",
  99: "thunderstorm with heavy hail"
};

async function geocode(ctx: ToolContext, city: string): Promise<GeocodeHit> {
  const url = new URL("https://geocoding-api.open-meteo.com/v1/search");
  url.searchParams.set("name", city);
  url.searchParams.set("count", "1");
  url.searchParams.set("language", "en");
  url.searchParams.set("format", "json");

  const data = await fetchJsonSafe<GeocodeResponse>(ctx, url.toString(), {
    cacheTtl: 86_400,
    label: "open-meteo-geocode"
  });

  const hit = data.results?.[0];
  if (!hit) {
    throw AppError.invalid(`Could not resolve a location for "${city}"`, "city");
  }
  return hit;
}

const weatherGroup: ToolGroup = {
  name: "weather",
  create: (ctx) => ({
    getWeather: tool({
      description:
        "Get current live weather for a city (temperature, humidity, wind, conditions). Uses a real weather API.",
      inputSchema: z.object({
        city: z.string().min(1).max(80).describe("City name, e.g. \"Taipei\""),
        country_code: z
          .string()
          .length(2)
          .optional()
          .describe("Optional ISO 3166-1 alpha-2 country code to disambiguate, e.g. \"TW\"")
      }),
      execute: async ({ city, country_code }) => {
        const hit = await geocode(ctx, country_code ? `${city}, ${country_code}` : city);

        const forecastUrl = new URL("https://api.open-meteo.com/v1/forecast");
        forecastUrl.searchParams.set("latitude", String(hit.latitude));
        forecastUrl.searchParams.set("longitude", String(hit.longitude));
        forecastUrl.searchParams.set(
          "current",
          "temperature_2m,relative_humidity_2m,apparent_temperature,weather_code,wind_speed_10m"
        );
        forecastUrl.searchParams.set("timezone", "auto");

        const forecast = await fetchJsonSafe<ForecastResponse>(ctx, forecastUrl.toString(), {
          cacheTtl: 300,
          label: "open-meteo-forecast"
        });

        const current = forecast.current ?? {};
        const code = current.weather_code;

        return {
          resolved_location: [hit.name, hit.admin1, hit.country].filter(Boolean).join(", "),
          latitude: hit.latitude,
          longitude: hit.longitude,
          temperature_c: current.temperature_2m ?? null,
          feels_like_c: current.apparent_temperature ?? null,
          humidity_percent: current.relative_humidity_2m ?? null,
          wind_kmh: current.wind_speed_10m ?? null,
          conditions: code !== undefined ? (WEATHER_CODES[code] ?? `code ${code}`) : "unknown"
        };
      }
    })
  })
};

export default weatherGroup;
