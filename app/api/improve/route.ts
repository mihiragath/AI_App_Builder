import { auth } from "@clerk/nextjs/server";
import { NextRequest } from "next/server";
import { db } from "@/lib/prisma";
import { CREDIT_COST_PER_GENERATION } from "@/lib/constants";
import {
  extractThoughtLabel,
  formatGeminiError,
  generateContentStreamWithFallback,
} from "@/lib/gemini";
import type { FileData } from "@/types/workspace";

function sseEvent(type: string, payload: object): string {
  return `data: ${JSON.stringify({ type, ...payload })}\n\n`;
}

const IMPROVE_SYSTEM_PROMPT = `You are an expert React developer improving a live browser preview app.

The app uses React (functional components), Tailwind CSS for styling, and runs in Sandpack.
You CANNOT use TypeScript, CSS modules, or real npm install — only what's already available.
Available packages: react, react-dom, tailwindcss (CDN), lucide-react, recharts, react-router-dom, framer-motion, date-fns, zod, react-hook-form.

Always respond with a valid JSON object — no markdown fences, no extra text.
The JSON must match this exact shape:
{
  "summary": "<1-3 sentence friendly summary of all improvements>",
  "files": {
    "/App.js": { "code": "<complete new file content>" }
  }
}

RULES:
- Only include files you actually changed in "files".
- Always write complete file contents — never partial snippets or diffs.
- Keep all existing functionality unless asked to remove it.
- The entry point is always /App.js with a default export.
- All imports must reference files in the project or packages in the available list above.`;

export async function POST(request: NextRequest) {
  const { userId: clerkId } = await auth();
  if (!clerkId)
    return Response.json({ message: "Unauthorized" }, { status: 401 });

  const body = await request.json();
  const { userId, workspaceId, userRequest, fileData } = body as {
    userId: string;
    workspaceId: string;
    userRequest: string;
    fileData: FileData;
  };

  const user = await db.user.findUnique({
    where: { id: userId, clerkId },
    select: { id: true, credits: true, plan: true },
  });

  if (!user)
    return Response.json({ message: "User not found" }, { status: 404 });

  if (user.plan !== "pro")
    return Response.json({ message: "Upgrade required" }, { status: 403 });

  if (user.credits < CREDIT_COST_PER_GENERATION)
    return Response.json({ message: "Insufficient credits" }, { status: 402 });

  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      const enqueue = (chunk: string) =>
        controller.enqueue(encoder.encode(chunk));

      try {
        enqueue(sseEvent("status", { message: "Analyzing your request…" }));

        const fileContext = Object.entries(fileData.files)
          .map(([path, { code }]) => `// ${path}\n${code}`)
          .join("\n\n---\n\n");

        const geminiStream = await generateContentStreamWithFallback({
          contents: [
            {
              role: "user",
              parts: [
                {
                  text: `Improvement request: ${userRequest}

Current files:

${fileContext}`,
                },
              ],
            },
          ],
          config: {
            systemInstruction: IMPROVE_SYSTEM_PROMPT,
            temperature: 0.5,
            responseMimeType: "application/json",
            thinkingConfig: { includeThoughts: true },
          },
        });

        let accumulated = "";
        let lastEmitTime = 0;

        for await (const chunk of geminiStream) {
          const parts = chunk.candidates?.[0]?.content?.parts ?? [];

          for (const part of parts) {
            if (!part.text) continue;

            if (part.thought) {
              const now = Date.now();
              if (now - lastEmitTime > 600) {
                const label = extractThoughtLabel(part.text);
                if (label) {
                  enqueue(sseEvent("thinking", { text: `${label}\n` }));
                  lastEmitTime = now;
                }
              }
            } else {
              accumulated += part.text;
            }
          }
        }

        let parsed: {
          summary: string;
          files: Record<string, { code: string }>;
        };

        try {
          parsed = JSON.parse(accumulated);
        } catch {
          enqueue(
            sseEvent("error", {
              message: "AI returned invalid JSON. Please try again.",
            })
          );
          return;
        }

        const { summary, files: changedFiles } = parsed;

        if (!changedFiles || typeof changedFiles !== "object") {
          enqueue(
            sseEvent("error", {
              message: "AI response missing file updates. Please try again.",
            })
          );
          return;
        }

        const patchedFiles: Record<string, { code: string }> = {
          ...fileData.files,
        };

        for (const [path, { code }] of Object.entries(changedFiles)) {
          patchedFiles[path] = { code };
          enqueue(
            sseEvent("file_patch", {
              path,
              code,
              reason: "Updated based on your request",
            })
          );
        }

        const newFileData: FileData = {
          files: patchedFiles,
          dependencies: fileData.dependencies,
          title: fileData.title,
        };

        await db.$transaction([
          db.workspace.update({
            where: { id: workspaceId, userId },
            data: { fileData: newFileData as never },
          }),
          db.user.update({
            where: { id: userId },
            data: { credits: { decrement: CREDIT_COST_PER_GENERATION } },
          }),
        ]);

        const updatedUser = await db.user.findUnique({
          where: { id: userId },
          select: { credits: true },
        });

        enqueue(
          sseEvent("done", {
            fileData: newFileData,
            summary: summary || "Improvements applied.",
            creditsRemaining:
              updatedUser?.credits ?? user.credits - CREDIT_COST_PER_GENERATION,
          })
        );
      } catch (err) {
        console.error("[improve] error:", err);
        enqueue(
          sseEvent("error", {
            message: formatGeminiError(err),
          })
        );
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}

export const runtime = "nodejs";
export const maxDuration = 300;
