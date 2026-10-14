import { createFileRoute } from "@tanstack/react-router";

// Background worker tick (called every minute by the database scheduler): generate + score.
export const Route = createFileRoute("/api/public/forecast-evaluate")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const { authorizeWorker, workerTick } = await import("@/lib/use/forecast.server");
        if (!(await authorizeWorker(request))) return new Response("Unauthorized", { status: 401 });
        try {
          return Response.json(await workerTick());
        } catch (e) {
          console.error("forecast worker tick failed", e);
          return Response.json({ error: (e as Error).message }, { status: 500 });
        }
      },
    },
  },
});
