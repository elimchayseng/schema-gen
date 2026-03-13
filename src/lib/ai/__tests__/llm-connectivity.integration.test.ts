/**
 * Integration test: validates that the LLM endpoint is reachable
 * and returns a well-formed response.
 *
 * Requires HEROKU_INFERENCE_URL, HEROKU_INFERENCE_KEY, and
 * HEROKU_INFERENCE_MODEL to be set in the environment (e.g. via .env.local).
 *
 * Run with: npx vitest run src/lib/ai/__tests__/llm-connectivity.integration.test.ts
 */
import { describe, it, expect } from "vitest";

const INFERENCE_URL = process.env.HEROKU_INFERENCE_URL;
const INFERENCE_KEY = process.env.HEROKU_INFERENCE_KEY;
const INFERENCE_MODEL = process.env.HEROKU_INFERENCE_MODEL;

const hasCredentials = INFERENCE_URL && INFERENCE_KEY && INFERENCE_MODEL;

describe.skipIf(!hasCredentials)("LLM connectivity", () => {
  it("returns a valid chat completion response", async () => {
    const endpoint =
      INFERENCE_URL!.replace(/\/+$/, "") + "/v1/chat/completions";

    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${INFERENCE_KEY}`,
      },
      body: JSON.stringify({
        model: INFERENCE_MODEL,
        messages: [
          {
            role: "user",
            content: 'Respond with exactly: {"status":"ok"}',
          },
        ],
        temperature: 0,
        max_tokens: 32,
      }),
    });

    expect(response.ok, `LLM API returned ${response.status}`).toBe(true);

    const json = await response.json();

    // Validate OpenAI-compatible response shape
    expect(json).toHaveProperty("choices");
    expect(json.choices).toBeInstanceOf(Array);
    expect(json.choices.length).toBeGreaterThan(0);
    expect(json.choices[0]).toHaveProperty("message");
    expect(json.choices[0].message).toHaveProperty("content");
    expect(typeof json.choices[0].message.content).toBe("string");
    expect(json.choices[0].message.content.length).toBeGreaterThan(0);
  }, 30_000);
});
