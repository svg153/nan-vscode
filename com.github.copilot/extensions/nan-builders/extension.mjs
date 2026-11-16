// NaN Builders plugin for the GitHub Copilot app: quota/usage canvas + nan_ask / nan_usage
// tools + session context. Talks to api.nan.builders with the key from
// $COPILOT_HOME/extensions/nan-builders/artifacts/config.json (or NAN_BUILDERS_API_KEY).
// stdout is reserved for JSON-RPC: never console.log here.

import { createServer } from "node:http";
import { CanvasError, createCanvas, joinSession } from "@github/copilot-sdk/extension";
import { configPath, loadConfig, saveApiKey, saveBaseUrl } from "./lib/config.mjs";
import { DEFAULT_BASE_URL, NanError, createChatCompletion, fetchModels, fetchUsage, isChatModel, redactSecret } from "./lib/nan.mjs";
import { compactTokens, composeUsage, formatCredits, getKnownModel, quotaCapLabel } from "./lib/quota.mjs";
import { renderHtml } from "./ui.mjs";

const MODELS_TTL_MS = 300_000;
const USAGE_TTL_MS = 60_000;
const MAX_BODY_BYTES = 64 * 1024;

const cache = { models: null, usage: null, lastError: undefined };
const servers = new Map(); // instanceId -> { server, url, clients:Set<ServerResponse> }

function describe(error, cfg) {
  if (error instanceof NanError) {
    return redactSecret(error.message, cfg.apiKey).slice(0, 300);
  }
  return redactSecret(String(error?.message ?? error), cfg.apiKey).slice(0, 300);
}

function invalidateCache() {
  cache.models = null;
  cache.usage = null;
  cache.lastError = undefined;
}

/**
 * Model catalog rows for the canvas Models tab: the API reports the models, the
 * plugin only enriches known ids with published metadata.
 */
function modelsForView(list) {
  return list.map((entry) => {
    const known = getKnownModel(entry.id);
    return {
      id: entry.id,
      chat: isChatModel(entry),
      name: known?.name,
      contextWindow: known?.contextWindow,
      maxOutputTokens: known?.maxOutputTokens,
      imageInput: known?.imageInput,
      toolCalling: known?.toolCalling,
      cap: quotaCapLabel(entry.id),
    };
  });
}

async function buildSnapshot({ force = false } = {}) {
  const cfg = await loadConfig();
  const base = {
    hasKey: cfg.hasKey,
    keySource: cfg.keySource ?? null,
    baseUrl: cfg.baseUrl,
    defaultBaseUrl: DEFAULT_BASE_URL,
    insecure: classifyInsecure(cfg),
    configPath: configPath(),
    error: undefined,
    models: null,
    usage: null,
  };
  if (!cfg.hasKey) {
    return base;
  }
  if (force || !cache.models || Date.now() - cache.models.at > MODELS_TTL_MS) {
    try {
      cache.models = { list: await fetchModels(cfg), at: Date.now() };
    } catch (error) {
      cache.lastError = describe(error, cfg);
    }
  }
  if (force || !cache.usage || Date.now() - cache.usage.at > USAGE_TTL_MS) {
    try {
      cache.usage = { data: composeUsage(await fetchUsage(cfg)), at: Date.now() };
    } catch (error) {
      cache.lastError = describe(error, cfg);
    }
  }
  base.error = cache.lastError;
  base.models = cache.models ? modelsForView(cache.models.list) : null;
  base.usage = cache.usage ? { ...cache.usage.data, fetchedAt: cache.usage.at } : null;
  return base;
}

function classifyInsecure(cfg) {
  return cfg.insecureConfirmed === true;
}

// ---------------------------------------------------------------- loopback server

function json(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function broadcast(entry, state) {
  const payload = "event: state\ndata: " + JSON.stringify(state) + "\n\n";
  for (const client of entry.clients) {
    try {
      client.write(payload);
    } catch {
      entry.clients.delete(client);
    }
  }
}

async function broadcastAll(state) {
  for (const entry of servers.values()) {
    broadcast(entry, state);
  }
}

async function handle(req, res, entry) {
  const host = String(req.headers.host || "");
  if (!/^(\[::1\]|127\.0\.0\.1|localhost)(:\d+)?$/.test(host)) {
    res.writeHead(403, { "Content-Type": "text/plain" });
    res.end("forbidden");
    return;
  }
  const path = new URL(req.url, "http://127.0.0.1").pathname;

  if (req.method === "GET" && (path === "/" || path === "/index.html")) {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
    res.end(renderHtml());
    return;
  }
  if (req.method === "GET" && path === "/events") {
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store", Connection: "keep-alive" });
    res.write("retry: 2000\n\n");
    entry.clients.add(res);
    req.on("close", () => entry.clients.delete(res));
    return;
  }
  if (req.method === "GET" && path === "/api/state") {
    json(res, 200, await buildSnapshot());
    return;
  }
  if (req.method === "POST") {
    if (!String(req.headers["content-type"] || "").includes("application/json")) {
      json(res, 415, { error: "Expected application/json." });
      return;
    }
    let body = {};
    try {
      body = JSON.parse(await readBody(req)) || {};
    } catch {
      json(res, 400, { error: "Invalid JSON body." });
      return;
    }
    try {
      if (path === "/api/refresh") {
        const state = await buildSnapshot({ force: body.force !== false });
        broadcast(entry, state);
        json(res, 200, { state });
        return;
      }
      if (path === "/api/key") {
        await saveApiKey(typeof body.key === "string" ? body.key : "");
        invalidateCache();
        const state = await buildSnapshot();
        broadcast(entry, state);
        json(res, 200, { state });
        return;
      }
      if (path === "/api/base-url") {
        try {
          await saveBaseUrl(typeof body.url === "string" ? body.url : "", { confirmInsecure: body.confirmInsecure === true });
        } catch (error) {
          if (error instanceof NanError && error.kind === "confirmation_required") {
            json(res, 428, { error: error.message });
            return;
          }
          throw error;
        }
        invalidateCache();
        const state = await buildSnapshot();
        broadcast(entry, state);
        json(res, 200, { state });
        return;
      }
    } catch (error) {
      json(res, 400, { error: describe(error, await loadConfig()) });
      return;
    }
  }
  res.writeHead(404, { "Content-Type": "text/plain" });
  res.end("not found");
}

async function startServer() {
  const entry = { clients: new Set() };
  entry.server = createServer((req, res) => {
    handle(req, res, entry).catch(async (error) => {
      if (!res.headersSent) {
        const cfg = await loadConfig().catch(() => ({ apiKey: "" }));
        json(res, 500, { error: describe(error, cfg) });
      } else {
        res.end();
      }
    });
  });
  await new Promise((resolve) => entry.server.listen(0, "127.0.0.1", resolve));
  entry.url = "http://127.0.0.1:" + entry.server.address().port + "/";
  return entry;
}

// ---------------------------------------------------------------- canvas

const canvas = createCanvas({
  id: "nan-builders",
  displayName: "NaN Builders",
  description: "NaN Builders credit dashboard, model catalog and API key settings (local canvas).",
  inputSchema: {
    type: "object",
    properties: {
      tab: { type: "string", enum: ["usage", "models", "settings"], description: "Initial tab to show." },
    },
    additionalProperties: false,
  },
  actions: [
    {
      name: "get_state",
      description: "Return the current snapshot (key status, models, usage with plan credits and per-model billed credits) without forcing network calls.",
      handler: async () => buildSnapshot(),
    },
    {
      name: "refresh",
      description: "Force-refresh models and usage from api.nan.builders, then return the snapshot.",
      handler: async () => {
        const state = await buildSnapshot({ force: true });
        await broadcastAll(state);
        return state;
      },
    },
  ],
  open: async (ctx) => {
    let entry = servers.get(ctx.instanceId);
    if (!entry) {
      entry = await startServer();
      servers.set(ctx.instanceId, entry);
    }
    const cfg = await loadConfig();
    const hash = ctx.input && ctx.input.tab ? "#tab=" + ctx.input.tab : "";
    return {
      url: entry.url + hash,
      title: "NaN Builders",
      status: cfg.hasKey ? "API key set" : "No API key",
    };
  },
  onClose: async (ctx) => {
    const entry = servers.get(ctx.instanceId);
    if (!entry) {
      return;
    }
    servers.delete(ctx.instanceId);
    for (const client of entry.clients) {
      try {
        client.end();
      } catch {
        // ignore; client already gone
      }
    }
    await new Promise((resolve) => entry.server.close(() => resolve()));
  },
});

// ---------------------------------------------------------------- agent tools

function fail(text) {
  return { textResultForLlm: text, resultType: "failure" };
}

async function ensureModels(cfg) {
  if (!cache.models || Date.now() - cache.models.at > MODELS_TTL_MS) {
    cache.models = { list: await fetchModels(cfg), at: Date.now() };
  }
  return cache.models.list.filter(isChatModel).map((model) => model.id);
}

const tools = [
  {
    name: "nan_ask",
    description:
      "Send a one-shot prompt to a NaN Builders chat model via POST /v1/chat/completions (no streaming, no tool calls). " +
      "Use for cheap second-opinion or verification passes (e.g. qwen3.8-flash, glm5.3-flash). Requires the plugin API key " +
      "(NaN Builders canvas > Settings, or NAN_BUILDERS_API_KEY).",
    parameters: {
      type: "object",
      properties: {
        prompt: { type: "string", description: "User prompt sent to the NaN model." },
        model: { type: "string", description: "NaN chat model id; defaults to the first chat model available for the key." },
        system: { type: "string", description: "Optional system message." },
        maxTokens: { type: "number", description: "Optional max output tokens (capped at 32768)." },
        temperature: { type: "number", description: "Optional sampling temperature (0..2)." },
      },
      required: ["prompt"],
      additionalProperties: false,
    },
    handler: async ({ prompt, model, system, maxTokens, temperature }) => {
      const cfg = await loadConfig();
      if (!cfg.hasKey) {
        return fail("The nan-builders plugin has no API key. Ask the user to open the NaN Builders canvas > Settings tab and save their key, or set NAN_BUILDERS_API_KEY. Never ask them to paste the key into chat.");
      }
      if (!String(prompt ?? "").trim()) {
        return fail("nan_ask: prompt must not be empty.");
      }
      let available;
      try {
        available = await ensureModels(cfg);
      } catch (error) {
        return fail("nan_ask: could not list NaN models: " + describe(error, cfg));
      }
      const requested = String(model ?? "").trim();
      const chosen = requested || available[0];
      if (!chosen || !available.includes(chosen)) {
        return fail('nan_ask: model "' + requested + '" is not an available NaN chat model for this key. Available: ' + available.join(", "));
      }
      try {
        const result = await createChatCompletion(cfg, { model: chosen, prompt, system, maxTokens, temperature });
        if (!result.text.trim()) {
          return fail("nan_ask: model " + chosen + " returned an empty completion.");
        }
        return "nan_ask (" + chosen + "):\n" + result.text;
      } catch (error) {
        return fail("nan_ask failed: " + describe(error, cfg));
      }
    },
  },
  {
    name: "nan_usage",
    description:
      "Force-refresh and summarize NaN Builders usage for the current UTC month: plan credits for the billing period " +
      "(allowance, used, remaining, optional credit pack, frozen state) plus per-model billed credits. Models that draw " +
      "no credits are noted instead of given a percentage. Read-only.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    handler: async () => {
      const cfg = await loadConfig();
      if (!cfg.hasKey) {
        return fail("nan_usage: no API key configured for the nan-builders plugin.");
      }
      let state;
      try {
        state = await buildSnapshot({ force: true });
      } catch (error) {
        return fail("nan_usage failed: " + describe(error, cfg));
      }
      await broadcastAll(state);
      if (!state.usage) {
        return fail("nan_usage: could not fetch usage." + (state.error ? " " + state.error : ""));
      }
      const usage = state.usage;
      const credits = usage.credits;
      const lines = ["NaN Builders usage " + usage.startDate + " .. " + usage.endDate];
      if (!credits) {
        lines.push("This gateway does not report plan credits (no credits block on GET /v1/usage); the token counts below are not a quota.");
      } else {
        if (credits.frozen) {
          lines.push("WARNING: plan credits are frozen - credit-billed requests are refused until the subscription is active again. No usage percentage is implied.");
        }
        const facts = [];
        if (credits.used !== null) facts.push("used " + formatCredits(credits.used));
        if (credits.allowance !== null) facts.push("allowance " + formatCredits(credits.allowance));
        if (credits.remaining !== null) facts.push("remaining " + formatCredits(credits.remaining));
        const period = credits.periodStart && credits.periodEnd
          ? credits.periodStart + " -> " + credits.periodEnd
          : credits.periodEnd
            ? "renews " + credits.periodEnd
            : "";
        if (facts.length) {
          lines.push("Plan credits" + (period ? " (" + period + ")" : "") + ": " + facts.join(" · ") + ".");
        }
        if (credits.percent !== null) {
          lines.push("Credit pool: " + credits.percent + "% of the plan allowance used.");
        }
        if (credits.packCredits) {
          lines.push("Credit pack: " + formatCredits(credits.packCredits) + " credits" + (credits.packExpiresAt ? " · expires " + credits.packExpiresAt : "") + ".");
        }
      }
      if (usage.windowCredits !== null) {
        lines.push("Window credits: " + formatCredits(usage.windowCredits) + " (calendar-month sum of the per-model rows; the billing-period used total can differ by tenths).");
      }
      if (!usage.items.length) {
        lines.push("No usage recorded in this window.");
      }
      for (const item of usage.items) {
        const facts = [];
        if (item.percent !== null) {
          facts.push(formatCredits(item.credits) + " credits (" + item.percent + "% of plan credits)");
        } else if (item.credits !== null && item.credits > 0) {
          facts.push(formatCredits(item.credits) + " credits");
        }
        if (item.note) {
          facts.push(item.note);
        }
        lines.push(
          "- " + item.model + ": " + compactTokens(item.usedTokens) +
          (item.requests ? ", " + item.requests.toLocaleString("en-US") + " requests" : "") +
          (facts.length ? " · " + facts.join(" · ") : ""),
        );
      }
      lines.push("Window total: " + compactTokens(usage.totals.totalTokens) + " tokens." + (usage.truncated ? " (older rows beyond the first pages are omitted)" : ""));
      if (state.error) {
        lines.push("Warning: " + state.error);
      }
      return lines.join("\n");
    },
  },
];

// ---------------------------------------------------------------- join

const session = await joinSession({
  canvases: [canvas],
  tools,
  hooks: {
    onSessionStart: async () => {
      const cfg = await loadConfig().catch(() => ({ hasKey: false }));
      return {
        additionalContext:
          "nan-builders plugin: canvas \"nan-builders\" shows the NaN Builders credit dashboard, model catalog and API key " +
          "settings; tools nan_ask (one-shot prompt to a NaN chat model) and nan_usage (plan credits for the billing period " +
          "plus per-model billed credits) are available. API key status: " +
          (cfg.hasKey ? "configured (" + (cfg.keySource ?? "config-file") + ")" : "NOT configured - if usage/chat tools are needed, ask the user to open the NaN Builders canvas > Settings and save the key there (never in chat) or set NAN_BUILDERS_API_KEY") +
          ". Base URL: " + cfg.baseUrl + ". NaN bills every metered model from one credits pool (allowance per billing period); report shares as \"% of plan credits\" and never as per-model token caps. Models that draw no credits and frozen pools get no percentage.",
      };
    },
  },
});

await session.log("nan-builders plugin ready (" + servers.size + " canvas servers)").catch(() => undefined);

export { buildSnapshot, canvas, tools };
