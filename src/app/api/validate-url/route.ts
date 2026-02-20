import { NextResponse } from "next/server";
import { z } from "zod";
import { scanUrl } from "@/lib/url-validator";

const bodySchema = z.object({
  url: z.string().url("Must be a valid URL including http:// or https://"),
});

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "Invalid request" },
      { status: 400 }
    );
  }

  const result = await scanUrl(parsed.data.url);
  return NextResponse.json(result);
}
